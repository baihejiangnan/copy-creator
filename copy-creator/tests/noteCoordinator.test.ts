import { test } from "node:test";
import assert from "node:assert/strict";
import { NoteCoordinator, NOTE_BODY_MAX_BYTES, NOTE_DIRTY_SESSION_LIMIT } from "../src/lib/noteCoordinator.ts";
import type { NoteClock, SaveRequest } from "../src/lib/noteCoordinator.ts";
import type { Note, NoteMutation, StorageResult } from "../src/types/note.ts";

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
class FakeClock implements NoteClock {
  time = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  setTimeout = (callback: () => void, delay: number) => {
    const id = ++this.next; this.timers.set(id, { at: this.time + delay, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (id: ReturnType<typeof setTimeout>) => { this.timers.delete(id as unknown as number); };
  async advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at; this.timers.delete(next[0]); next[1].callback(); await tick();
    }
    this.time = end; await tick();
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function ack(request: SaveRequest, overrides: Partial<Note> = {}): StorageResult<NoteMutation> {
  const note: Note = {
    id: request.id, title: request.draft.title, body: request.draft.body, refs: request.draft.refs.map((r) => ({ ...r })),
    summary: request.draft.body.slice(0, 160), char_count: request.draft.body.length, byte_count: request.draft.body.length,
    created_at_ms: 1, updated_at_ms: 2, revision: (request.expectedRevision ?? 0) + 1,
    archived_at_ms: null, deleted_at_ms: null, ref_count: request.draft.refs.length, source: null, ...overrides,
  };
  return { storage_epoch: request.storageEpoch, value: { note, mutation_id: request.mutationId, applied: true } };
}
function harness() {
  const clock = new FakeClock();
  const calls: { request: SaveRequest; result: ReturnType<typeof deferred<StorageResult<NoteMutation>>> }[] = [];
  let count = 0;
  const coordinator = new NoteCoordinator((request) => {
    const result = deferred<StorageResult<NoteMutation>>(); calls.push({ request, result }); return result.promise;
  }, 1, clock, () => `fixture-${++count}`);
  return { clock, calls, coordinator };
}
function loaded(id: string): Note {
  return { id, title: "", body: "saved", refs: [], summary: "saved", char_count: 5, byte_count: 5,
    created_at_ms: 1, updated_at_ms: 1, revision: 1, archived_at_ms: null, deleted_at_ms: null, ref_count: 0, source: null };
}

test("empty drafts do not write; idle input saves once after 500 ms", async () => {
  const h = harness(), id = h.coordinator.create();
  await h.coordinator.flushAll(); assert.equal(h.calls.length, 0);
  h.coordinator.edit(id, { body: "one" }); await h.clock.advance(400);
  h.coordinator.edit(id, { body: "two" }); await h.clock.advance(499); assert.equal(h.calls.length, 0);
  await h.clock.advance(1); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].request.draft.body, "two");
  h.calls[0].result.resolve(ack(h.calls[0].request)); await tick();
  assert.equal(h.coordinator.getSession(id)?.status, "saved"); assert.equal(h.coordinator.hasPending, false);
});

test("title-only drafts stay recoverable without writes or unbounded cache admission", async () => {
  const h = harness(); const ids: string[] = [];
  for (let n = 0; n < NOTE_DIRTY_SESSION_LIMIT; n++) {
    const id = h.coordinator.create(); ids.push(id); h.coordinator.edit(id, { title: `idea ${n}` }); await h.coordinator.flush(id);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.coordinator.dirtyCount, 0);
  for (let n = 0; n < 20; n++) h.coordinator.load(loaded(`clean-${n}`), 1);
  assert.deepEqual(h.coordinator.getRecoveryIds(), ids);
  assert.throws(() => h.coordinator.create(), { code: "notes.draftBudget" });
  h.coordinator.edit(ids[0], { title: "corrected" });
  await h.coordinator.discard(ids[0]); assert.ok(h.coordinator.create());
});

test("continuous input has a two second save trigger without copying every edit to IPC", async () => {
  const h = harness(), id = h.coordinator.create();
  for (let n = 0; n < 5; n++) { h.coordinator.edit(id, { body: String(n) }); await h.clock.advance(399); }
  assert.equal(h.calls.length, 0); await h.clock.advance(5);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].request.draft.body, "4");
  h.calls[0].result.resolve(ack(h.calls[0].request)); await tick();
});

test("title-only recovery blocks lifecycle acknowledgement and storage reset until explicitly resolved", async () => {
  const h=harness(), id=h.coordinator.create();
  h.coordinator.edit(id,{title:"idea without a body"});await h.coordinator.flush(id);
  assert.equal(h.coordinator.hasPending,true);assert.equal(h.calls.length,0);
  await assert.rejects(h.coordinator.flushAll(),{code:"notes.emptyDraft"});
  assert.throws(()=>h.coordinator.switchStorage(2),{code:"notes.pendingDrafts"});
  assert.equal(h.coordinator.getSession(id)?.draft.title,"idea without a body");
  h.coordinator.pause();h.coordinator.resume();
  await h.coordinator.discard(id);await h.coordinator.flushAll();h.coordinator.switchStorage(2);
  assert.equal(h.coordinator.hasPending,false);assert.equal(h.coordinator.storageEpoch,2);
});

test("IME composition pauses all automatic saves and resumes with the complete text", async () => {
  const h = harness(), id = h.coordinator.create();
  h.coordinator.setComposing(id, true); h.coordinator.edit(id, { body: "中" }); await h.clock.advance(8000);
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.coordinator.flushAll(), { code: "notes.compositionInProgress" });
  h.coordinator.edit(id, { body: "中文完整" }); h.coordinator.setComposing(id, false);
  await h.clock.advance(500); assert.equal(h.calls[0].request.draft.body, "中文完整");
  h.calls[0].result.resolve(ack(h.calls[0].request)); await tick();
});

test("a late acknowledgement cannot clear a newer draft; each note has one accepted request", async () => {
  const h = harness(), id = h.coordinator.create(); h.coordinator.edit(id, { body: "old" });
  const flushing = h.coordinator.flush(id); await tick();
  const otherFlush = h.coordinator.flush(id); h.coordinator.edit(id, { body: "new" });
  await h.clock.advance(2500); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request.draft.body, "old");
  h.calls[0].result.resolve(ack(h.calls[0].request)); await tick();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].request.draft.body, "new");
  assert.equal(h.calls[1].request.expectedRevision, 1); assert.equal(h.coordinator.getSession(id)?.status, "saving");
  assert.notEqual(h.coordinator.getSession(id)?.sequence, h.coordinator.getSession(id)?.savedSequence);
  h.calls[1].result.resolve(ack(h.calls[1].request)); await Promise.all([flushing, otherFlush]);
  assert.equal(h.coordinator.getSession(id)?.status, "saved");
});

test("an unknown response retries the exact immutable request before a later draft", async () => {
  const h = harness(), id = h.coordinator.create(); h.coordinator.edit(id, { body: "accepted" });
  const first = h.coordinator.flush(id); await tick(); h.calls[0].result.reject(new Error("response lost"));
  await assert.rejects(first, { code: "notes.saveFailed" });
  h.coordinator.edit(id, { body: "later" }); const retry = h.coordinator.flush(id); await tick();
  assert.strictEqual(h.calls[1].request, h.calls[0].request); assert.equal(h.calls[1].request.draft.body, "accepted");
  h.calls[1].result.resolve(ack(h.calls[1].request)); await tick();
  assert.equal(h.calls[2].request.draft.body, "later"); assert.notEqual(h.calls[2].request.mutationId, h.calls[1].request.mutationId);
  h.calls[2].result.resolve(ack(h.calls[2].request)); await retry;
});

test("synchronous transport failure still releases the single flight and preserves the draft", async () => {
  const clock = new FakeClock(); let calls = 0;
  const coordinator = new NoteCoordinator(() => { calls++; throw new Error("offline"); }, 1, clock);
  const id = coordinator.create(); coordinator.edit(id, { body: "keep" });
  await assert.rejects(coordinator.flush(id)); await assert.rejects(coordinator.flush(id));
  assert.equal(calls, 2); assert.equal(coordinator.getSession(id)?.draft.body, "keep");
  assert.equal(coordinator.getSession(id)?.status, "error");
});

test("busy retries are bounded and retain one mutation identity", async () => {
  const clock = new FakeClock(), requests: SaveRequest[] = [];
  const coordinator = new NoteCoordinator(async (request) => { requests.push(request); throw { code: "notes.busy" }; }, 1, clock);
  const id = coordinator.create(); coordinator.edit(id, { body: "keep" });
  const result = coordinator.flush(id); const rejection = assert.rejects(result, { code: "notes.busy" });
  await tick(); await clock.advance(300); await rejection;
  assert.equal(requests.length, 3); assert.ok(requests.every((r) => r === requests[0]));
  await clock.advance(10000); assert.equal(requests.length, 3); assert.equal(coordinator.getSession(id)?.draft.body, "keep");
});

test("conflicts retain local text and block overwrites; copying remaps note and ref identities", async () => {
  const h = harness(); const existing = loaded("original");
  existing.refs = [{ id: "old-ref", kind: "url", target: "https://example.com", display_name: "link" }];
  h.coordinator.load(existing, 1); h.coordinator.edit("original", { body: "local" });
  const result = h.coordinator.flush("original"); await tick();
  h.calls[0].result.reject({ code: "notes.conflict", current_revision: 3 });
  await assert.rejects(result, { code: "notes.conflict" });
  h.coordinator.edit("original", { body: "still local" }); await h.clock.advance(4000); assert.equal(h.calls.length, 1);
  const copy = h.coordinator.forkConflict("original"); assert.notEqual(copy, "original");
  assert.equal(h.coordinator.getSession(copy)?.draft.body, "still local");
  assert.notEqual(h.coordinator.getSession(copy)?.draft.refs[0].id, "old-ref");
  const saved = h.coordinator.flush(copy); await tick(); assert.equal(h.calls[1].request.expectedRevision, null);
  h.calls[1].result.resolve(ack(h.calls[1].request)); await saved;
});

test("replayed creation with different server content or deletion is not shown as saved", async () => {
  for (const overrides of [{ body: "foreign change" }, { deleted_at_ms: 5 }]) {
    const h = harness(), id = h.coordinator.create(); h.coordinator.edit(id, { body: "my text" });
    const result = h.coordinator.flush(id); await tick(); h.calls[0].result.resolve(ack(h.calls[0].request, overrides));
    await assert.rejects(result); assert.equal(h.coordinator.getSession(id)?.draft.body, "my text");
    assert.equal(h.coordinator.getSession(id)?.status, "conflict");
  }
});

test("storage identity mismatch retains the draft and prevents a silent cache reset", async () => {
  const h = harness(), id = h.coordinator.create(); h.coordinator.edit(id, { body: "keep" });
  assert.throws(() => h.coordinator.switchStorage(2), { code: "notes.pendingDrafts" });
  const result = h.coordinator.flush(id); await tick();
  h.calls[0].result.resolve({ ...ack(h.calls[0].request), storage_epoch: 2 });
  await assert.rejects(result, { code: "notes.storageChanged" }); assert.equal(h.coordinator.getSession(id)?.draft.body, "keep");
  await h.coordinator.discard(id); h.coordinator.switchStorage(2);
  assert.equal(h.coordinator.storageEpoch, 2); assert.equal(h.coordinator.getSession(id), undefined);
  assert.throws(() => h.coordinator.load(loaded("stale"), 1), { code: "notes.storageChanged" });
});

test("four failed sessions block additional edits without evicting any draft", async () => {
  const clock = new FakeClock();
  const coordinator = new NoteCoordinator(async () => { throw { code: "notes.databaseFailed" }; }, 1, clock);
  const ids: string[] = [];
  for (let n = 0; n < NOTE_DIRTY_SESSION_LIMIT; n++) {
    const id = coordinator.create(); ids.push(id); coordinator.edit(id, { body: `keep-${n}` });
    await assert.rejects(coordinator.flush(id));
  }
  assert.throws(() => coordinator.create(), { code: "notes.draftBudget" });
  coordinator.load(loaded("clean"), 1);
  assert.throws(() => coordinator.edit("clean", { body: "blocked" }), { code: "notes.draftBudget" });
  for (const [n, id] of ids.entries()) assert.equal(coordinator.getSession(id)?.draft.body, `keep-${n}`);
  await coordinator.discard(ids[0]); const next = coordinator.create(); coordinator.edit(next, { body: "allowed" });
  assert.equal(coordinator.dirtyCount, NOTE_DIRTY_SESSION_LIMIT);
});

test("clean LRU eviction never evicts dirty or unknown-outcome sessions", async () => {
  const h = harness(), id = h.coordinator.create(); h.coordinator.edit(id, { body: "keep dirty" });
  for (let n = 0; n < 20; n++) h.coordinator.load(loaded(`clean-${n}`), 1);
  assert.equal(h.coordinator.getSession(id)?.draft.body, "keep dirty");
  assert.equal(h.coordinator.getSession("clean-0"), undefined);
  assert.equal(h.coordinator.getSession("clean-19")?.draft.body, "saved");
});

test("pause blocks new input, drains accepted saves and resumes after a failed barrier", async () => {
  const h = harness(), id = h.coordinator.create(); h.coordinator.edit(id, { body: "keep" }); h.coordinator.pause();
  assert.throws(() => h.coordinator.edit(id, { body: "blocked" }), { code: "notes.paused" });
  const barrier = h.coordinator.flushAll(); await tick(); h.calls[0].result.reject(new Error("disk"));
  await assert.rejects(barrier); assert.equal(h.coordinator.getSession(id)?.draft.body, "keep");
  h.coordinator.resume(); h.coordinator.edit(id, { body: "new" });
  assert.equal(h.coordinator.getSession(id)?.draft.body, "new");
});

test("UTF-8 validation retains oversized Chinese input and recovery saves the corrected text", async () => {
  const h = harness(), id = h.coordinator.create(); const tooLarge = "中".repeat(Math.floor(NOTE_BODY_MAX_BYTES / 3) + 1);
  h.coordinator.edit(id, { body: tooLarge });
  await assert.rejects(h.coordinator.flush(id), { code: "notes.bodyTooLarge" });
  assert.equal(h.calls.length, 0); assert.equal(h.coordinator.getSession(id)?.draft.body, tooLarge);
  h.coordinator.edit(id, { body: "corrected" }); const result = h.coordinator.flush(id); await tick();
  h.calls[0].result.resolve(ack(h.calls[0].request)); await result;
  assert.equal(h.coordinator.getSession(id)?.status, "saved");
});

test("a failed list refresh cannot change a successful persistence acknowledgement", async (context) => {
  context.mock.method(console, "error", () => {});
  const coordinator = new NoteCoordinator(async (request) => ack(request), 1, new FakeClock(), undefined,
    () => { throw new Error("UI refresh"); });
  const id = coordinator.create(); coordinator.edit(id, { body: "saved" }); await coordinator.flush(id);
  assert.equal(coordinator.getSession(id)?.status, "saved"); assert.equal(coordinator.hasPending, false);
});

test("subscriber failure cannot poison a save and budget observers see the drained flight", async (context) => {
  context.mock.method(console, "error", () => {});
  const h = harness(), id = h.coordinator.create();
  h.coordinator.subscribe(id, () => { throw new Error("render"); });
  let pending = true;
  h.coordinator.subscribeBudget(() => { pending = h.coordinator.hasPending; });
  h.coordinator.edit(id, { body: "safe" });
  const flushed = h.coordinator.flush(id); await tick();
  h.calls[0].result.resolve(ack(h.calls[0].request)); await flushed;
  assert.equal(h.coordinator.getSession(id)?.status, "saved"); assert.equal(pending, false);
});
