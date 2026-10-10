/* eslint-disable @typescript-eslint/no-explicit-any -- Executes production stores/components with synthetic native and React adapters. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { ownEventSubscriptions } from "../src/lib/eventSubscriptions.ts";

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
function load(file: string, dependencies: (name: string) => any, globals: object = {}) {
  const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8").replaceAll("import.meta.hot", "hot");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: any = {};
  vm.runInNewContext(compiled, { exports, console, setTimeout, clearTimeout, hot: undefined, require: dependencies, ...globals });
  return exports;
}
const create = (initialize: any) => {
  let state: any;
  const set = (value: any) => { state = { ...state, ...(typeof value === "function" ? value(state) : value) }; };
  state = initialize(set, () => state);
  return Object.assign((selector: any) => selector(state), { getState: () => state, setState: set });
};

for (const cleanup of ["beforeunload", "hmr"]) {
  test(`clipboard ${cleanup} releases every native/identity listener including late registrations`, async () => {
    const pending: ((stop: () => void) => void)[] = [], active = new Set<number>(), errors: unknown[] = [];
    const windowEvents = new Map<string, () => void>(); let hotDispose!: () => void, identityStops = 0;
    const store = load("stores/clipboardStore.ts", name => {
      if (name === "zustand") return { create };
      if (name.endsWith("/eventSubscriptions")) return { ownEventSubscriptions };
      if (name.endsWith("/storageIdentity")) return { getStorageIdentity: async () => 1, onStorageIdentity: () => () => { identityStops++; } };
      if (name.endsWith("/latestQuery")) return { LatestQuery: class {} };
      if (name.endsWith("/requestPool")) return { RequestPool: class {} };
      if (name === "@tauri-apps/api/core") return {};
      if (name === "@tauri-apps/api/event") return { listen: () => new Promise(resolve => { pending.push(resolve); }) };
      throw Error(name);
    }, { hot: { dispose: (fn: () => void) => { hotDispose = fn; } }, console: { error: (error: unknown) => errors.push(error) }, window: {
      addEventListener: (name: string, fn: () => void) => windowEvents.set(name, fn), removeEventListener: (name: string) => windowEvents.delete(name),
    } }).useClipboardStore;
    store.getState().init(); store.getState().init(); assert.equal(pending.length, 5);
    const finish = (index: number) => { active.add(index); pending[index](() => { active.delete(index); }); };
    finish(0); finish(1); await tick();
    if (cleanup === "hmr") { assert.equal(typeof hotDispose, "function"); hotDispose(); }
    else windowEvents.get("beforeunload")!();
    finish(2); finish(3); finish(4); await tick();
    assert.equal(active.size, 0); assert.equal(identityStops, 1); assert.equal(windowEvents.size, 0); assert.equal(errors.length, 0);
    store.getState().init(); assert.equal(pending.length, 5);
  });
}

test("clipboard listener registration errors are owned without blocking cleanup of peers", async () => {
  const errors: unknown[] = []; let stopped = 0;
  let dispose!: () => void;
  const store = load("stores/clipboardStore.ts", name => {
    if (name === "zustand") return { create };
    if (name.endsWith("/eventSubscriptions")) return { ownEventSubscriptions };
    if (name.endsWith("/storageIdentity")) return { getStorageIdentity: async () => 1, onStorageIdentity: () => () => {} };
    if (name.endsWith("/latestQuery")) return { LatestQuery: class {} };
    if (name.endsWith("/requestPool")) return { RequestPool: class {} };
    if (name === "@tauri-apps/api/core") return {};
    if (name === "@tauri-apps/api/event") return { listen: (name: string) => name === "clipboard-deleted" ? Promise.reject("synthetic registration failure") : Promise.resolve(() => { stopped++; }) };
    throw Error(name);
  }, { console: { error: (error: unknown) => errors.push(error) }, hot: { dispose: (fn: () => void) => { dispose = fn; } } }).useClipboardStore;
  store.getState().init(); await tick(); dispose(); await tick();
  assert.equal(errors.length, 1); assert.equal(stopped, 4);
});

test("clipboard icons are complete before the page module is imported", () => {
  const Icons = { clipboard: {}, image: {}, link: {}, file: {} };
  const meta = load("pages/ClipboardPage/utils.tsx", name => {
    if (name.endsWith("/Icons")) return { Icons };
    if (name === "react") return {};
    throw Error(name);
  }).TYPE_META;
  for (const [type, icon] of Object.entries({ text: Icons.clipboard, image: Icons.image, link: Icons.link, explorer: Icons.link, file: Icons.file })) assert.equal(meta[type].icon, icon);
});

test("clipboard disposal during identity lookup prevents a retired store from querying or publishing records", async () => {
  let dispose!: () => void, resolve!: (epoch: number) => void, queries = 0;
  const identity = new Promise<number>(yes => { resolve = yes; });
  const store = load("stores/clipboardStore.ts", name => {
    if (name === "zustand") return { create };
    if (name.endsWith("/eventSubscriptions")) return { ownEventSubscriptions };
    if (name.endsWith("/storageIdentity")) return { getStorageIdentity: () => identity, onStorageIdentity: () => () => {} };
    if (name.endsWith("/latestQuery")) return { LatestQuery: class { run(_key: string, work: () => unknown) { return work(); } } };
    if (name.endsWith("/requestPool")) return { RequestPool: class {} };
    if (name === "@tauri-apps/api/core") return { invoke: async () => { queries++; return [{ id: "synthetic" }]; } };
    if (name === "@tauri-apps/api/event") return {};
    throw Error(name);
  }, { hot: { dispose: (fn: () => void) => { dispose = fn; } } }).useClipboardStore;
  store.getState().setVisible(true);
  dispose(); resolve(1); await tick(); await tick();
  assert.equal(queries, 0); assert.equal(store.getState().records.length, 0);
});

function vaultFixture() {
  let now = 0, next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const store = load("stores/vaultStore.ts", name => {
    if (name === "zustand") return { create };
    if (name === "@tauri-apps/api/core") return {};
    if (name.endsWith("/storageIdentity")) return { invokeStorage: async () => {}, getStorageIdentity: async () => 1, onStorageIdentity: () => () => {}, isCurrentStorageIdentity: () => true };
    if (name.endsWith("/types/vault")) return { VAULT_AUTO_LOCK_OPTIONS: ["3hours"] };
    throw Error(name);
  }, { setTimeout: (fn: () => void, delay: number) => { timers.set(++next, { at: now + delay, fn }); return next; }, clearTimeout: (id: number) => timers.delete(id) }).useVaultStore;
  store.setState({ status: { configured: true, unlocked: true, auto_lock: "3hours" } });
  return { store, timers, advance(ms: number) { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); } } };
}
for (const first of ["copyField", "pasteField"]) for (const second of ["copyField", "pasteField"]) {
  test(`vault ${first} then ${second} keeps the newest notice for its full lifetime`, async () => {
    const f = vaultFixture();
    await f.store.getState()[first]("synthetic", "username"); f.advance(2000);
    await f.store.getState()[second]("synthetic", "username"); f.advance(500);
    assert.equal(f.store.getState().notice, second === "copyField" ? "vault.copied" : "vault.pasteSent");
    assert.equal(f.timers.size, 1); f.advance(2000); assert.equal(f.store.getState().notice, null);
  });
}
for (const clear of ["clearLocked", "clearSelected"]) test(`vault ${clear} cancels the pending notice timer`, async () => {
  const f = vaultFixture(); await f.store.getState().copyField("synthetic", "username");
  f.store.getState()[clear](); assert.equal(f.timers.size, 0); assert.equal(f.store.getState().notice, null);
});

function find(tree: any, predicate: (node: any) => boolean): any {
  if (!tree || typeof tree !== "object") return;
  if (Array.isArray(tree)) return tree.map(child => find(child, predicate)).find(Boolean);
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
for (const parent of ["notes", "suiji"]) test(`${parent} editor shares its parent's groups without a second subscription`, () => {
  const groups = [{ id: "synthetic-group", name: "Synthetic", count: 1 }]; let subscriptions = 0;
  const session = { draft: { title: "Synthetic", body: "Synthetic", refs: [] }, status: "saved", revision: 1, summary: { updated_at_ms: 1 } };
  const coordinator = { getSession: () => session, getRecoveryIds: () => [] };
  const feed = { getSnapshot: () => ({ records: [], search: "", filter: "active", sort: "updated", page: 1 }) };
  const state = { coordinator, feed, selectedId: "synthetic", quickId: null };
  const workspace = Object.assign((selector?: any) => selector ? selector(state) : state, { getState: () => state });
  const RecordGroupSelect = () => {};
  const dependencies = (name: string): any => {
    if (name === "react") return { useState: (value: any) => [value, () => {}], useRef: (value: any) => ({ current: value }), useEffect() {}, useSyncExternalStore: (_: any, snapshot: any) => snapshot() };
    if (name === "react/jsx-runtime") return { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) };
    if (name === "react-i18next") return { useTranslation: () => ({ t: (key: string) => key }) };
    if (name.endsWith("/notesWorkspace")) return { useNotesWorkspace: workspace };
    if (name.endsWith("/useRecordGroups")) return { useRecordGroups: () => { subscriptions++; return { groups, ready: true }; } };
    if (name.endsWith("/documentVisible")) return { useWindowVisible: () => true };
    if (name.endsWith("/RecordGroupSelect")) return { __esModule: true, default: RecordGroupSelect };
    if (name === "../NotesPage") return notes;
    if (name.endsWith("/Icons")) return { Icons: {} };
    return {};
  };
  const notes = load("pages/NotesPage/index.tsx", dependencies);
  let tree = parent === "notes" ? notes.default() : load("pages/PhrasePage/SuijiPage.tsx", dependencies).default();
  if (parent === "suiji") { const child = find(tree, node => typeof node.type === "function"); assert.ok(child); tree = child.type(child.props); }
  const editor = find(tree, node => node.type === notes.NoteEditor); assert.ok(editor);
  const control = find(editor.type(editor.props), node => node.type === RecordGroupSelect); assert.ok(control);
  assert.equal(control.props.groups, groups); assert.equal(subscriptions, 1);
});
