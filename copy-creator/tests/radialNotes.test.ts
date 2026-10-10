import test from "node:test";
import assert from "node:assert/strict";
import { RadialNotes, RADIAL_UNGROUPED } from "../src/lib/radialNotes.ts";
import { requestRadialFlush, answerRadialFlush, type RadialFlushReply } from "../src/lib/radialNoteFlush.ts";
import { ownEventSubscriptions } from "../src/lib/eventSubscriptions.ts";
import type { Note, StorageResult } from "../src/types/note.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const note = (id = "promoted", body = "完整正文\r\n  "): Note => ({ id, title: "title", body, summary: "摘要", refs: [], source: null,
  char_count: 8, byte_count: 20, created_at_ms: 1, updated_at_ms: 2, revision: 2, archived_at_ms: null, deleted_at_ms: null, ref_count: 0 });
function fixture() {
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const f = { epoch: 1, saved: note(), flush: async () => {}, read: null as Promise<StorageResult<Note>> | null,
    query: null as ((args: Record<string, unknown>) => Promise<unknown>) | null };
  const model = new RadialNotes({ epoch: async () => f.epoch, current: epoch => epoch === f.epoch,
    invoke: async <T>(command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "get_suiji_groups") return { storage_epoch: f.epoch, value: [{ id: "group", name: "Group", color: "#aabbcc", sort_order: 0, count: 1 }] } as T;
      if (command === "list_suiji") return (f.query ? await f.query(args) : { storage_epoch: f.epoch, value: { records: [f.saved], next_cursor: null } }) as T;
      if (command === "get_note") return (f.read ? await f.read : { storage_epoch: f.epoch, value: f.saved }) as T;
      if (command === "get_phrases") return [] as T; // Schema 6 retired data source.
      throw Error(`Unexpected command ${command}`);
    }, flush: () => f.flush(), paste: async (command, args, epoch) => { calls.push({ command, args: { ...args, expectedStorageEpoch: epoch } }); },
  });
  return { f, model, calls };
}
test("radial lists promoted and new notes via bounded suiji queries, including ungrouped", async () => {
  const { f, model, calls } = fixture();
  await model.show();
  assert.equal(model.getSnapshot().records[0]?.id, "promoted");
  f.saved = note("new-note");
  await model.refresh();
  assert.equal(model.getSnapshot().records[0]?.id, "new-note");
  await model.select("group");
  assert.equal(calls.at(-1)?.args.groupId, "group");
  await model.select(RADIAL_UNGROUPED);
  assert.equal(calls.at(-1)?.args.filter, "ungrouped");
  assert.equal(calls.at(-1)?.args.limit, 50);
  model.hide(); await model.refresh();
  assert.equal(model.getSnapshot().records.length, 0);
  assert.equal(calls.filter(call => call.command === "list_suiji").length, 4, "hidden invalidation sends no IPC");
});
test("radial waits for main flush and reads the latest full body for each paste", async () => {
  const { f, model, calls } = fixture();
  const flush = deferred<void>(); f.flush = () => flush.promise;
  const paste = model.paste("promoted", 1);
  await tick(); assert.equal(calls.length, 0, "no detail read or native paste before save acknowledgment");
  f.saved = note("promoted", "更新正文\r\n尾部  "); flush.resolve(); await paste;
  assert.equal(calls.at(-1)?.args.text, f.saved.body);
  f.saved = note("promoted", "second edit"); await model.paste("promoted", 1);
  assert.equal(calls.at(-1)?.args.text, "second edit");
  assert.equal(calls.filter(call => call.command === "get_note").length, 2);
});
test("flush failure and a late source detail after relocation never paste", async () => {
  const { f, model, calls } = fixture();
  f.flush = async () => { throw "notes.conflict"; };
  await assert.rejects(model.paste("promoted", 1), error => error === "notes.conflict");
  assert.equal(calls.length, 0);
  f.flush = async () => {};
  const detail = deferred<StorageResult<Note>>(); f.read = detail.promise;
  const pending = model.paste("promoted", 1); await tick(); f.epoch = 2;
  detail.resolve({ storage_epoch: 1, value: note() });
  await assert.rejects(pending, error => error === "notes.storageChanged");
  assert.equal(calls.some(call => call.command.startsWith("paste_")), false);
});
test("radial file references paste the file, while archived records cannot paste", async () => {
  const { f, model, calls } = fixture();
  f.saved = { ...note("promoted", ""), refs: [{ id: "file", kind: "file", target: "C:\\synthetic\\keep.txt", display_name: "keep" }] };
  await model.paste("promoted", 1);
  assert.equal(calls.at(-1)?.command, "paste_file");
  f.saved.archived_at_ms = 3;
  await assert.rejects(model.paste("promoted", 1), error => error === "notes.invalidState");
  assert.equal(calls.filter(call => call.command.startsWith("paste_")).length, 1);
});
test("cursor pages deduplicate and remain capped at 2000 records", async () => {
  const { f, model, calls } = fixture();
  let page = 0;
  f.query = async () => ({ storage_epoch: 1, value: { records: Array.from({ length: 50 }, (_, index) => note(String((page * 49) + index))), next_cursor: { id: String(++page), sort_at_ms: page } } });
  await model.show();
  for (let i = 0; i < 50; i++) await model.more();
  assert.equal(model.getSnapshot().records.length, 2000);
  assert.equal(model.getSnapshot().cursor, null);
  assert.equal(calls.filter(call => call.command === "list_suiji").length, 41);
});
test("old group query and hidden reads cannot repopulate the current scope", async () => {
  const { f, model } = fixture();
  await model.show();
  const old = deferred<unknown>();
  f.query = args => args.groupId === "group" ? old.promise : Promise.resolve({ storage_epoch: 1, value: { records: [note("ungrouped")], next_cursor: null } });
  const first = model.select("group"); await tick();
  const second = model.select(RADIAL_UNGROUPED);
  old.resolve({ storage_epoch: 1, value: { records: [note("stale")], next_cursor: null } });
  await Promise.all([first, second]);
  assert.equal(model.getSnapshot().records[0].id, "ungrouped");
  model.hide(); assert.equal(model.getSnapshot().records.length, 0);
});
test("flush handshake rejects failures, mismatched receipts, timeout and late acknowledgment", async () => {
  let callback!: (reply: RadialFlushReply) => void; let stops = 0;
  const request = { requestId: "one", storageEpoch: 1, id: "note" };
  const transport = { listen: async (handler: typeof callback) => { callback = handler; return () => { stops++; }; }, send: async () => {} };
  const timed = requestRadialFlush(request, transport, 10);
  await tick(); callback({ requestId: "other", storageEpoch: 1, error: null });
  callback({ requestId: "one", storageEpoch: 2, error: null });
  await assert.rejects(timed, error => error === "lifecycle.saveTimeout");
  callback({ requestId: "one", storageEpoch: 1, error: null }); assert.equal(stops, 1);
  const failed = requestRadialFlush(request, transport);
  await tick(); callback({ requestId: "one", storageEpoch: 1, error: "notes.conflict" });
  await assert.rejects(failed, error => error === "notes.conflict"); assert.equal(stops, 2);
});
test("main flush acknowledgment follows persistence and rejects an epoch change", async () => {
  let epoch = 1; const flushed = deferred<void>();
  const request = { requestId: "one", storageEpoch: 1, id: "note" };
  let acknowledged = false;
  const answer = answerRadialFlush(request, async () => epoch, () => flushed.promise).then(reply => { acknowledged = true; return reply; });
  await tick(); assert.equal(acknowledged, false, "main cannot acknowledge while persistence is pending");
  epoch = 2; flushed.resolve();
  assert.equal((await answer).error, "notes.storageChanged");
  assert.equal((await answerRadialFlush(request, async () => 1, async () => { throw Error("lifecycle.saveTimeout"); })).error, "lifecycle.saveTimeout");
});

test("flush deadline also bounds listener registration and releases its late handle", async () => {
  const registration = deferred<() => void>(); let stopped = 0, sent = false;
  const pending = requestRadialFlush({ requestId: "one", storageEpoch: 1, id: "note" }, {
    listen: () => registration.promise, send: async () => { sent = true; },
  }, 10);
  await assert.rejects(pending, error => error === "lifecycle.saveTimeout");
  registration.resolve(() => { stopped++; }); await tick();
  assert.equal(stopped, 1); assert.equal(sent, false);
});
test("effect cleanup releases all listeners even if registration resolves late", async () => {
  const late = deferred<() => void>(); let stopped = 0;
  const dispose = ownEventSubscriptions([Promise.resolve(() => { stopped++; }), late.promise], error => { throw error; });
  await tick(); dispose(); late.resolve(() => { stopped++; }); await tick();
  assert.equal(stopped, 2, "late registration must release without a second cleanup call");
  dispose();
  assert.equal(stopped, 2);
});
