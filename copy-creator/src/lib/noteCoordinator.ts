import type { Note, NoteDraft, NoteFailure, NoteMutation, NoteSource, NoteSummary, StorageResult } from "../types/note.ts";

export const NOTE_BODY_MAX_BYTES = 256 * 1024;
export const NOTE_DIRTY_SESSION_LIMIT = 4;
// Each admitted session reserves 4 MiB for raw UTF-8 fields, including an
// invalid draft retained after validation fails. One accepted snapshot doubles
// that reservation. Limits are checked by lengths on input, UTF-8 on save.
export const NOTE_DIRTY_BYTES_RESERVED = 16 * 1024 * 1024;
export const NOTE_INFLIGHT_BYTES_RESERVED = 16 * 1024 * 1024;
const CLEAN_LIMIT = 5;
type Timer = ReturnType<typeof setTimeout>;
export interface NoteClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): Timer;
  clearTimeout(timer: Timer): void;
}
const systemClock: NoteClock = {
  now: Date.now, setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};
export interface SaveRequest {
  readonly storageEpoch: number;
  readonly id: string;
  readonly expectedRevision: number | null;
  readonly mutationId: string;
  readonly sequence: number;
  readonly draft: NoteDraft;
}
export type NoteTransport = (request: SaveRequest) => Promise<StorageResult<NoteMutation>>;
export type SaveStatus = "empty" | "saved" | "dirty" | "saving" | "error" | "conflict";
export interface NoteSession {
  readonly id: string;
  readonly storageEpoch: number;
  readonly revision: number | null;
  readonly draft: NoteDraft;
  readonly sequence: number;
  readonly savedSequence: number;
  readonly composing: boolean;
  readonly status: SaveStatus;
  readonly error: NoteFailure | null;
  readonly summary: NoteSummary | null;
  readonly source: NoteSource | null;
}

export function noteFailure(value: unknown): NoteFailure {
  if (typeof value === "string" && /^(notes|clipboard|lifecycle)\.[A-Za-z]+$/.test(value)) return { code: value };
  if (value && typeof value === "object" && "code" in value && typeof value.code === "string") {
    return { code: value.code, ...("current_revision" in value && typeof value.current_revision === "number"
      ? { current_revision: value.current_revision } : {}) };
  }
  return { code: "notes.saveFailed" };
}
function fail(code: string): never { throw { code } satisfies NoteFailure; }
function immutableDraft(draft: NoteDraft): NoteDraft {
  return Object.freeze({ title: draft.title, body: draft.body,
    refs: Object.freeze(draft.refs.map((reference) => Object.freeze({ ...reference }))) });
}
function sameDraft(note: NoteDraft, draft: NoteDraft): boolean {
  return note.title === draft.title && note.body === draft.body && note.refs.length === draft.refs.length
    && note.refs.every((reference, index) => {
      const other = draft.refs[index];
      return reference.id === other.id && reference.kind === other.kind && reference.target === other.target
        && reference.display_name === other.display_name;
    });
}
function inputBounds(draft: NoteDraft) {
  // O(1) string lengths on every input. Exact UTF-8 checks run only at save.
  if (draft.body.length > NOTE_BODY_MAX_BYTES) fail("notes.bodyTooLarge");
  if (draft.title.length > 256) fail("notes.titleTooLong");
  if (draft.refs.length > 20) fail("notes.tooManyRefs");
  if (draft.refs.some((r) => r.id.length > 64 || r.target.length > 32768 || r.display_name.length > 1024)) fail("notes.invalidRef");
}
function saveBounds(draft: NoteDraft) {
  inputBounds(draft);
  const encoder = new TextEncoder();
  if (encoder.encode(draft.body).length > NOTE_BODY_MAX_BYTES) fail("notes.bodyTooLarge");
  if (Array.from(draft.title).length > 128) fail("notes.titleTooLong");
  if (draft.refs.some((r) => encoder.encode(r.target).length > 32768 || Array.from(r.display_name).length > 512)) fail("notes.invalidRef");
}
function summaryOf(note: Note): NoteSummary {
  return { id: note.id, title: note.title, summary: note.summary, char_count: note.char_count,
    byte_count: note.byte_count, created_at_ms: note.created_at_ms, updated_at_ms: note.updated_at_ms,
    revision: note.revision, archived_at_ms: note.archived_at_ms, deleted_at_ms: note.deleted_at_ms,
    ref_count: note.ref_count, group_id: note.group_id, starred: note.starred };
}
function notify(listeners?: Set<() => void>) {
  listeners?.forEach((listener) => {
    try { listener(); } catch { console.error("Note subscriber failed"); }
  });
}
function isDirty(session: NoteSession) { return session.sequence !== session.savedSequence; }
function needsRecovery(session: NoteSession) {
  return isDirty(session) || (session.revision === null && !!(session.draft.title || session.draft.body || session.draft.refs.length));
}
const BLOCKED = new Set(["notes.conflict", "notes.mutationMismatch", "notes.deleted", "notes.storageChanged", "notes.notFound"]);
const DEFINITELY_REJECTED = new Set(["notes.bodyTooLarge", "notes.titleTooLong", "notes.tooManyRefs", "notes.invalidRef", "notes.duplicateRef", "notes.invalidId", "notes.emptyDraft"]);

/** Lives outside a page. Each session has at most one immutable save in flight.
 * Unknown outcomes keep their request identity until confirmed or explicitly discarded.
 */
export class NoteCoordinator {
  private readonly sessions = new Map<string, NoteSession>();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly requests = new Map<string, SaveRequest>();
  private readonly timers = new Map<string, { idle: Timer; maximum: Timer }>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly budgetListeners = new Set<() => void>();
  private frozen = false;
  private activeId: string | null = null;
  private epoch: number;
  private readonly transport: NoteTransport;
  private readonly clock: NoteClock;
  private readonly uuid: () => string;
  private readonly onCommit: (note: Note) => void;

  constructor(transport: NoteTransport, initialEpoch: number,
    clock: NoteClock = systemClock, uuid: () => string = () => crypto.randomUUID(),
    onCommit: (note: Note) => void = () => {}) {
    this.epoch = initialEpoch; this.transport = transport; this.clock = clock;
    this.uuid = uuid; this.onCommit = onCommit;
  }
  get storageEpoch() { return this.epoch; }
  get activeNoteId() { return this.activeId; }
  get dirtyCount() { return [...this.sessions.values()].filter(isDirty).length; }
  get paused() { return this.frozen; }
  get hasPending() { return [...this.sessions.values()].some(needsRecovery) || this.flights.size > 0 || this.requests.size > 0; }
  getSession(id: string) { return this.sessions.get(id); }
  getRecoveryIds() {
    return [...this.sessions.values()].filter(needsRecovery).map((s) => s.id);
  }
  subscribe(id: string, listener: () => void) {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener); this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  subscribeBudget(listener: () => void) {
    this.budgetListeners.add(listener); return () => { this.budgetListeners.delete(listener); };
  }
  setActive(id: string | null) { this.activeId = id; this.evictClean(); }
  private publish(session: NoteSession) {
    const previous = this.sessions.get(session.id);
    this.sessions.delete(session.id); this.sessions.set(session.id, Object.freeze(session));
    notify(this.listeners.get(session.id));
    if (!previous || needsRecovery(previous) !== needsRecovery(session) || previous.status !== session.status) {
      notify(this.budgetListeners);
    }
  }
  private clearTimers(id: string) {
    const timers = this.timers.get(id);
    if (timers) { this.clock.clearTimeout(timers.idle); this.clock.clearTimeout(timers.maximum); this.timers.delete(id); }
  }
  private schedule(id: string) {
    const session = this.sessions.get(id);
    if (!session || !isDirty(session) || session.composing || this.frozen || session.status === "conflict") return;
    const existing = this.timers.get(id);
    if (existing) this.clock.clearTimeout(existing.idle);
    const trigger = () => { this.clearTimers(id); void this.flush(id).catch(() => {}); };
    this.timers.set(id, { idle: this.clock.setTimeout(trigger, 500),
      maximum: existing?.maximum ?? this.clock.setTimeout(trigger, 2000) });
  }
  private assertEditable() { if (this.frozen) fail("notes.paused"); }
  private admitDirty(id?: string) {
    if (!id || !needsRecovery(this.sessions.get(id)!)) {
      if ([...this.sessions.values()].filter(needsRecovery).length >= NOTE_DIRTY_SESSION_LIMIT) fail("notes.draftBudget");
    }
  }
  create(): string {
    this.assertEditable(); this.admitDirty();
    const id = this.uuid(); this.activeId = id;
    this.publish({ id, storageEpoch: this.epoch, revision: null,
      draft: immutableDraft({ title: "", body: "", refs: [] }), sequence: 0, savedSequence: 0,
      composing: false, status: "empty", error: null, summary: null, source: null });
    this.evictClean(); return id;
  }
  load(note: Note, epoch: number, activate = true) {
    if (epoch !== this.epoch) fail("notes.storageChanged");
    const existing = this.sessions.get(note.id);
    if (existing && (isDirty(existing) || this.flights.has(note.id) || this.requests.has(note.id))) return existing;
    if (activate) this.activeId = note.id;
    this.publish({ id: note.id, storageEpoch: epoch, revision: note.revision, draft: immutableDraft(note),
      sequence: 0, savedSequence: 0, composing: false, status: "saved", error: null,
      summary: summaryOf(note), source: note.source });
    this.evictClean(); return this.sessions.get(note.id)!;
  }
  edit(id: string, patch: Partial<NoteDraft>) {
    this.assertEditable();
    const session = this.sessions.get(id); if (!session) fail("notes.notFound");
    const draft = { ...session.draft, ...patch }; inputBounds(draft);
    if (sameDraft(draft, session.draft)) return;
    this.admitDirty(id);
    this.publish({ ...session, draft: patch.refs ? immutableDraft(draft) : Object.freeze(draft),
      sequence: session.sequence + 1, status: session.status === "conflict" ? "conflict" : this.flights.has(id) ? "saving" : "dirty",
      error: session.status === "conflict" ? session.error : null });
    this.schedule(id);
  }
  setComposing(id: string, composing: boolean) {
    const session = this.sessions.get(id); if (!session) return;
    this.publish({ ...session, composing });
    if (composing) this.clearTimers(id); else this.schedule(id);
  }
  markConflict(id: string, error: unknown) {
    const session = this.sessions.get(id); if (!session) return;
    this.clearTimers(id);
    this.publish({ ...session, status: "conflict", error: noteFailure(error) });
  }
  pause() {
    this.frozen = true;
    for (const id of this.timers.keys()) this.clearTimers(id);
    notify(this.budgetListeners);
  }
  resume() {
    this.frozen = false;
    for (const session of this.sessions.values()) if (session.status === "dirty") this.schedule(session.id);
    notify(this.budgetListeners);
  }
  async flushAll() {
    // Call pause first for an exclusive lifecycle barrier. Plain flushes are also
    // useful on hide, where the page may disappear but this coordinator stays alive.
    do {
      const ids = [...this.sessions.values()].filter(isDirty).map((s) => s.id);
      await Promise.all([...new Set([...ids, ...this.flights.keys()])].map((id) => this.flush(id)));
    } while (this.dirtyCount > 0);
    // Title-only drafts deliberately do not create DB records. They must not
    // be mistaken for saved data at exit/import/storage-switch boundaries.
    if ([...this.sessions.values()].some((session) => session.revision === null && needsRecovery(session))) fail("notes.emptyDraft");
  }
  async flush(id: string): Promise<void> {
    this.clearTimers(id);
    for (;;) {
      const existing = this.flights.get(id);
      if (existing) { await existing; continue; }
      const session = this.sessions.get(id);
      if (!session || !isDirty(session)) return;
      if (session.composing) fail("notes.compositionInProgress");
      if (session.status === "conflict") throw session.error!;
      if (!this.requests.has(id) && session.revision === null && !session.draft.body && !session.draft.refs.length) {
        this.publish({ ...session, savedSequence: session.sequence, status: "empty", error: null }); return;
      }
      let request = this.requests.get(id);
      if (!request) {
        try { saveBounds(session.draft); }
        catch (error) { this.publish({ ...session, status: "error", error: noteFailure(error) }); throw error; }
        request = Object.freeze({ storageEpoch: session.storageEpoch, id, expectedRevision: session.revision,
          mutationId: this.uuid(), sequence: session.sequence, draft: immutableDraft(session.draft) });
        this.requests.set(id, request);
      }
      this.publish({ ...session, status: "saving", error: null });
      const accepted = request;
      const flight = Promise.resolve().then(() => this.execute(accepted)).finally(() => {
        this.flights.delete(id); this.evictClean(); notify(this.budgetListeners);
      });
      this.flights.set(id, flight);
      await flight;
    }
  }
  private async execute(request: SaveRequest) {
    try {
      let response: StorageResult<NoteMutation> | undefined;
      for (let attempt = 0; !response; attempt++) {
        try { response = await this.transport(request); }
        catch (error) {
          if (noteFailure(error).code !== "notes.busy" || attempt >= 2) throw error;
          await new Promise<void>((resolve) => this.clock.setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
      const ack = response.value;
      if (response.storage_epoch !== this.epoch || response.storage_epoch !== request.storageEpoch) fail("notes.storageChanged");
      if (ack.mutation_id !== request.mutationId || ack.note.id !== request.id) fail("notes.mutationMismatch");
      if (ack.note.deleted_at_ms !== null) fail("notes.deleted");
      if (!sameDraft(ack.note, request.draft)) throw { code: "notes.conflict", current_revision: ack.note.revision } satisfies NoteFailure;
      if (ack.note.revision <= (request.expectedRevision ?? 0)) fail("notes.mutationMismatch");
      const session = this.sessions.get(request.id); if (!session) return;
      this.requests.delete(request.id);
      this.publish({ ...session, revision: ack.note.revision, savedSequence: request.sequence,
        status: session.sequence === request.sequence ? "saved" : "dirty", error: null,
        summary: summaryOf(ack.note), source: ack.note.source });
      // The persistence acknowledgement remains valid if a UI refresh fails.
      try { this.onCommit(ack.note); } catch (error) { console.error("Note refresh failed", error); }
    } catch (value) {
      const failure = noteFailure(value);
      const session = this.sessions.get(request.id);
      if (DEFINITELY_REJECTED.has(failure.code)) this.requests.delete(request.id);
      if (session) this.publish({ ...session, status: BLOCKED.has(failure.code) ? "conflict" : "error", error: failure });
      throw failure;
    }
  }
  /** The user explicitly chose a copy. Remap ref identities and reuse the same
   * recovery reservation, so a full failed-draft budget never forces a discard.
   */
  forkConflict(id: string): string {
    this.assertEditable();
    const old = this.sessions.get(id); if (!old || old.status !== "conflict" || this.flights.has(id)) fail("notes.invalidState");
    const newId = this.uuid();
    const draft = immutableDraft({ ...old.draft, refs: old.draft.refs.map((ref) => ({ ...ref, id: this.uuid() })) });
    this.remove(id); this.activeId = newId;
    this.publish({ id: newId, storageEpoch: this.epoch, revision: null, draft, sequence: 1, savedSequence: 0,
      composing: false, status: "dirty", error: null, summary: null, source: null });
    this.schedule(newId); return newId;
  }
  async discard(id: string) {
    await this.flights.get(id)?.catch(() => {});
    this.remove(id);
  }
  private remove(id: string) {
    this.clearTimers(id); this.requests.delete(id); this.sessions.delete(id);
    if (this.activeId === id) this.activeId = null;
    notify(this.listeners.get(id));
    notify(this.budgetListeners);
  }
  switchStorage(epoch: number) {
    if (epoch === this.epoch) return;
    if (this.hasPending) fail("notes.pendingDrafts");
    for (const id of [...this.sessions.keys()]) this.remove(id);
    this.epoch = epoch;
  }
  private evictClean() {
    const clean = [...this.sessions.values()].filter((s) => !needsRecovery(s) && !this.flights.has(s.id) && !this.requests.has(s.id));
    while (clean.length > CLEAN_LIMIT) {
      const index = clean.findIndex((s) => s.id !== this.activeId);
      if (index < 0) break;
      this.remove(clean.splice(index, 1)[0].id);
    }
  }
}
