import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

type RecordState = { id: string; is_favorite: boolean; favorite_note: string };
type ContentRecord = { id: string; type: string; content: string; content_truncated?: boolean; is_api_key?: boolean };
type StoreState = { records: RecordState[]; init: () => void; deleteRecord: (id: string) => Promise<void>; toggleFavorite: (id: string) => Promise<void>; setFavoriteNote: (id: string, note: string) => Promise<string>; getRecordContent: (record: ContentRecord) => Promise<string>; pasteRecord: (record: ContentRecord) => Promise<void> };
type Store = { getState: () => StoreState; setState: (value: object) => void };

function fixture(holdReplies = false) {
  let release!: (value: unknown) => void;
  const calls: { command: string; args: unknown }[] = [];
  let signalContent!: () => void;
  const contentStarted = new Promise<void>(resolve => { signalContent = resolve; });
  let signalCommand!: () => void;
  const commandStarted = new Promise<void>(resolve => { signalCommand = resolve; });
  const events = new Map<string, (event: { payload: unknown }) => void>();
  const modules = new Map<string, Record<string, unknown>>();
  const load = (file: string): Record<string, unknown> => {
    const cached = modules.get(file); if (cached) return cached;
    const exports: Record<string, unknown> = {}; modules.set(file, exports);
    const source = readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(compiled, { exports, console, AbortController, setTimeout, clearTimeout, require: (name: string) => {
      if (name === "zustand") return { create: (initialize: (set: (value: object | ((state: StoreState) => object)) => void, get: () => StoreState) => StoreState) => {
        let state: StoreState;
        const set = (value: object | ((state: StoreState) => object)) => { state = { ...state, ...(typeof value === "function" ? value(state) : value) }; };
        state = initialize(set, () => state); return { getState: () => state, setState: set };
      } };
      if (name === "@tauri-apps/api/core") return { invoke: (command: string, args: unknown) => { calls.push({ command, args }); signalCommand(); if (command === "get_clipboard_record_content") signalContent(); return holdReplies && !command.startsWith("paste_") ? new Promise(resolve => { release = resolve; }) : Promise.resolve(1); } };
      if (name === "@tauri-apps/api/event") return { listen: async (event: string, handler: (event: { payload: unknown }) => void) => { events.set(event, handler); return () => {}; } };
      if (name.startsWith("../lib/")) return load(name.replace("../", ""));
      throw Error("Unexpected dependency " + name);
    } });
    return exports;
  };
  const identity = load("lib/storageIdentity") as { publishStorageIdentity: (epoch: number) => void; invokeStorage: (command: string, args?: object, epoch?: number) => Promise<unknown> };
  const store = load("stores/clipboardStore").useClipboardStore as Store;
  identity.publishStorageIdentity(1); store.getState().init();
  return { store, identity, calls, contentStarted, commandStarted, deliver: (value: unknown) => release(value), emit: (event: string, payload: unknown) => { assert.ok(events.has(event)); events.get(event)!({ payload }); } };
}

for (const [event, value] of [
  ["clipboard-favorite-changed", { id: "same-id", is_favorite: true }],
  ["clipboard-favorite-note-changed", { id: "same-id", favorite_note: "old storage note" }],
  ["clipboard-deleted", "same-id"],
] as const) {
  test(`${event}: delayed source event cannot mutate a target record with the same ID`, () => {
    const f = fixture(); f.identity.publishStorageIdentity(2);
    const target = [{ id: "same-id", is_favorite: false, favorite_note: "target note" }];
    f.store.setState({ records: target });
    f.emit(event, { storage_epoch: 1, value });
    assert.equal(JSON.stringify(f.store.getState().records), JSON.stringify(target));
    f.emit(event, { storage_epoch: 2, value });
    assert.notEqual(JSON.stringify(f.store.getState().records), JSON.stringify(target));
  });
}

for (const protectedKey of [false, true]) {
  test(`late full-content read is rejected after migration (protected key: ${protectedKey})`, { timeout: 2000 }, async () => {
    const f = fixture(true);
    const pending = f.store.getState().getRecordContent({ id: "same-id", type: "text", content: "preview", content_truncated: !protectedKey, is_api_key: protectedKey });
    await f.contentStarted;
    f.identity.publishStorageIdentity(2);
    f.deliver("synthetic old full content");
    await assert.rejects(pending, error => error === "notes.storageChanged");
    assert.equal(JSON.stringify(f.calls.at(-1)), JSON.stringify({ command: "get_clipboard_record_content", args: { id: "same-id", expectedStorageEpoch: 1 } }));
  });
}

test("late full-content read cannot initiate a paste after migration", { timeout: 2000 }, async () => {
  const f = fixture(true);
  const pending = f.store.getState().pasteRecord({ id: "same-id", type: "text", content: "preview", content_truncated: true });
  await f.contentStarted;
  f.identity.publishStorageIdentity(2); f.deliver("synthetic old full content");
  await pending;
  assert.equal(f.calls.filter(call => call.command.startsWith("paste_")).length, 0);
});

for (const type of ["text", "image", "file"]) {
  test(`${type} paste binds the native side effect to its original storage`, async () => {
    const f = fixture();
    await f.store.getState().pasteRecord({ id: "current-id", type, content: "synthetic content" });
    const call = f.calls.find(call => call.command.startsWith("paste_"));
    assert.ok(call);
    assert.equal((call.args as { expectedStorageEpoch?: number }).expectedStorageEpoch, 1);
  });
}

test("unstamped legacy events cannot bypass the current storage identity", () => {
  const f = fixture(), target = [{ id: "same-id", is_favorite: false, favorite_note: "target" }];
  f.store.setState({ records: target });
  f.emit("clipboard-favorite-changed", { id: "same-id", is_favorite: true });
  f.emit("clipboard-deleted", "same-id");
  f.emit("clipboard-refresh", null);
  assert.equal(JSON.stringify(f.store.getState().records), JSON.stringify(target));
});

for (const operation of ["deleteRecord", "toggleFavorite", "setFavoriteNote"] as const) {
  test(`${operation}: an old successful reply cannot alter target records or image caches`, async () => {
    const f = fixture(true);
    const pending = operation === "setFavoriteNote" ? f.store.getState().setFavoriteNote("same-id", "old note") : f.store.getState()[operation]("same-id");
    await f.commandStarted;
    f.identity.publishStorageIdentity(2);
    const target = { records: [{ id: "same-id", is_favorite: false, favorite_note: "target note" }], thumbnailCache: { "same-id": "target thumbnail" }, imageCache: { "same-id": "target preview" } };
    f.store.setState(target);
    f.deliver(operation === "setFavoriteNote" ? "old normalized note" : true);
    if (operation === "setFavoriteNote") await assert.rejects(pending, error => error === "notes.storageChanged");
    else await pending;
    const state = f.store.getState() as StoreState & { thumbnailCache: object; imageCache: object };
    assert.equal(JSON.stringify({ records: state.records, thumbnailCache: state.thumbnailCache, imageCache: state.imageCache }), JSON.stringify(target));
  });
}

test("storage mutation carries its original epoch, ignores caller overrides and rejects a late success", async () => {
  const f = fixture(true);
  const pending = f.identity.invokeStorage("save_api_key_label", { recordId: "same-id", expectedStorageEpoch: 99 });
  await f.commandStarted;
  assert.equal(JSON.stringify(f.calls.at(-1)), JSON.stringify({ command: "save_api_key_label", args: { recordId: "same-id", expectedStorageEpoch: 1 } }));
  f.identity.publishStorageIdentity(2); f.deliver(undefined);
  await assert.rejects(pending, reason => reason === "notes.storageChanged");
});

test("migration during identity resolution prevents native delivery of the old operation", async () => {
  const f = fixture();
  const pending = f.identity.invokeStorage("delete_clipboard_record", { id: "same-id" });
  f.identity.publishStorageIdentity(2);
  await assert.rejects(pending, reason => reason === "notes.storageChanged");
  assert.equal(f.calls.length, 0);
});

test("current storage mutation keeps its native return value", async () => {
  const f = fixture();
  assert.equal(await f.identity.invokeStorage("toggle_clipboard_favorite", { id: "current" }), 1);
  assert.equal(JSON.stringify(f.calls[0]), JSON.stringify({ command: "toggle_clipboard_favorite", args: { id: "current", expectedStorageEpoch: 1 } }));
});

test("a confirmed cleanup proposal cannot be rebound to a new storage identity", async () => {
  const f = fixture();
  f.identity.publishStorageIdentity(2);
  await assert.rejects(f.identity.invokeStorage("apply_clipboard_cleanup", { mode: "dedupe" }, 1), reason => reason === "notes.storageChanged");
  assert.equal(f.calls.length, 0);
});
