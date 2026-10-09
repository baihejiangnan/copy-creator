import type { NoteCursor, NoteFailure, NoteFilter, NotePage, NoteSummary, StorageResult } from "../types/note.ts";
import { LatestQuery } from "./latestQuery.ts";
import { noteFailure } from "./noteCoordinator.ts";
export interface NoteQuery { epoch: number; filter: NoteFilter; search: string; cursor: NoteCursor | null }
export interface NoteFeedState {
  readonly filter: NoteFilter; readonly search: string; readonly records: readonly NoteSummary[];
  readonly loading: boolean; readonly error: NoteFailure | null; readonly nextCursor: NoteCursor | null;
  readonly page: number; readonly canPrevious: boolean;
}
export class NoteFeed {
  private readonly transport: (query: NoteQuery) => Promise<StorageResult<NotePage>>;
  private readonly queue = new LatestQuery<StorageResult<NotePage>>();
  private readonly listeners = new Set<() => void>();
  private state: NoteFeedState = Object.freeze({ filter: "active", search: "", records: [], loading: false, error: null, nextCursor: null, page: 1, canPrevious: false });
  private epoch: number;
  private generation = 0;
  private cursor: NoteCursor | null = null;
  private previous: (NoteCursor | null)[] = [];
  private visible = false;
  private stale = true;
  private paused = false;
  private flight: { generation: number; promise: Promise<void> } | null = null;
  constructor(epoch: number, transport: (query: NoteQuery) => Promise<StorageResult<NotePage>>) { this.epoch = epoch; this.transport = transport; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<NoteFeedState>) {
    this.state = Object.freeze({ ...this.state, ...patch });
    for (const listener of this.listeners) { try { listener(); } catch { console.error("Note feed subscriber failed"); } }
  }
  setVisible(visible: boolean) { this.visible = visible; if (visible && this.stale) void this.load(); }
  async setQuery(filter: NoteFilter, search: string) {
    if (Array.from(search).length > 256) throw { code: "notes.searchTooLong" };
    if (filter === this.state.filter && search === this.state.search) return this.load();
    this.generation++; this.cursor = null; this.previous = []; this.stale = true;
    this.publish({ filter, search, records: [], nextCursor: null, page: 1, canPrevious: false, error: null });
    return this.load();
  }
  invalidate() {
    this.stale = true; this.generation++;
    this.cursor = null; this.previous = []; this.publish({ page: 1, canPrevious: false });
    if (this.visible) void this.first();
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; if (this.visible && this.stale) void this.load(); }
  first() {
    this.generation++; this.cursor = null; this.previous = []; this.stale = true;
    this.publish({ page: 1, canPrevious: false }); return this.load();
  }
  next() {
    if (!this.state.nextCursor || this.state.loading) return Promise.resolve();
    this.previous.push(this.cursor); if (this.previous.length > 100) this.previous.shift();
    this.cursor = this.state.nextCursor; this.generation++; this.stale = true;
    this.publish({ page: this.state.page + 1, canPrevious: true }); return this.load();
  }
  back() {
    if (!this.previous.length || this.state.loading) return Promise.resolve();
    this.cursor = this.previous.pop()!; this.generation++; this.stale = true;
    this.publish({ page: this.state.page - 1, canPrevious: this.previous.length > 0 }); return this.load();
  }
  switchEpoch(epoch: number) {
    if (epoch === this.epoch) return;
    this.epoch = epoch; this.generation++; this.cursor = null; this.previous = []; this.stale = true;
    this.publish({ records: [], nextCursor: null, page: 1, canPrevious: false, error: null, loading: false });
    if (this.visible) void this.load();
  }
  load(): Promise<void> {
    if (this.paused) return Promise.resolve();
    if (this.flight?.generation === this.generation) return this.flight.promise;
    if (!this.stale && !this.state.error) return Promise.resolve();
    const generation = this.generation;
    const query = { epoch: this.epoch, filter: this.state.filter, search: this.state.search, cursor: this.cursor };
    const key = JSON.stringify([generation, query]);
    this.publish({ loading: true, error: null });
    const promise = this.queue.run(key, () => this.transport(query)).then((response) => {
      if (!response || generation !== this.generation) return;
      if (response.storage_epoch !== this.epoch) throw { code: "notes.storageChanged" };
      // Only summaries for the current page (50, server maximum 100) are held.
      const seen = new Set<string>();
      const records = response.value.records.filter((row) => !seen.has(row.id) && !!seen.add(row.id)).slice(0, 100);
      this.stale = false; this.publish({ records, nextCursor: response.value.next_cursor, loading: false });
    }).catch((error) => {
      if (generation === this.generation) this.publish({ loading: false, error: noteFailure(error) });
    }).finally(() => { if (this.flight?.generation === generation) this.flight = null; });
    this.flight = { generation, promise }; return promise;
  }
}
