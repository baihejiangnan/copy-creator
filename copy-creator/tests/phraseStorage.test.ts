import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

type Operation = "createGroup" | "updateGroup" | "deleteGroup" | "createPhrase" | "updatePhrase" | "deletePhrase";
type StoreState = { groups: Record<string, string>[]; phrases: Record<string, string>[]; selectedGroupId: string | null } & Record<Operation, (...args: string[]) => Promise<void>>;
type Store = { getState: () => StoreState; setState: (value: object) => void };

// Execute the actual store; replace only its native transport and identity source.
function fixture() {
  const source = readFileSync(new URL("../src/stores/phraseStore.ts", import.meta.url), "utf8");
  const query = readFileSync(new URL("../src/lib/latestQuery.ts", import.meta.url), "utf8");
  const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const queryExports: Record<string, unknown> = {};
  vm.runInNewContext(compile(query), { exports: queryExports });
  let state: StoreState;
  let identity!: () => void;
  let release!: (value?: unknown) => void;
  const exports: Record<string, Store> = {};
  const create = () => (initialize: (set: (value: object) => void, get: () => typeof state) => StoreState) => {
    const set = (value: object) => { state = { ...state, ...value }; };
    state = initialize(set, () => state);
    return { getState: () => state, setState: set };
  };
  vm.runInNewContext(compile(source), { exports, console, require: (name: string) => {
    if (name === "zustand") return { create };
    if (name === "@tauri-apps/api/core") return { invoke: () => new Promise(resolve => { release = resolve; }) };
    if (name === "@tauri-apps/api/event") return { listen: async () => () => {} };
    if (name === "../lib/storageIdentity") return { onStorageIdentity: (listener: () => void) => { identity = listener; }, invokeStorage: () => new Promise(resolve => { release = resolve; }) };
    if (name === "../lib/latestQuery") return queryExports;
    throw Error("Unexpected dependency " + name);
  } });
  return { store: exports.usePhraseStore, changeIdentity: () => identity(), deliver: (value?: unknown) => release(value) };
}

for (const operation of ["createGroup", "updateGroup", "deleteGroup", "createPhrase", "updatePhrase", "deletePhrase"] as const) {
  test(`${operation}: a delivered old-storage acknowledgment cannot change the new store`, async () => {
    const f = fixture();
    const target = { groups: [{ id: "g", name: "new storage group" }], phrases: [{ id: "p", group_id: "g", title: "new storage phrase", content: "new body" }], selectedGroupId: "g" };
    f.store.setState(target);
    const args: Record<string, string[]> = { createGroup: ["old group"], updateGroup: ["g", "old name"], deleteGroup: ["g"], createPhrase: ["g", "old title", "old body"], updatePhrase: ["p", "old title", "old body"], deletePhrase: ["p"] };
    const pending = f.store.getState()[operation](...args[operation]);
    f.changeIdentity();f.store.setState(target);
    f.deliver({ id: "old-created", group_id: "g", name: "old group", title: "old title", content: "old body" });await pending;
    const state = f.store.getState();
    assert.equal(JSON.stringify({ groups: state.groups, phrases: state.phrases, selectedGroupId: state.selectedGroupId }), JSON.stringify(target));
  });
}

test("create acknowledgments do not duplicate event-refreshed groups or phrases", async () => {
  for (const kind of ["group", "phrase"]) {
    const f = fixture(), item = { id: "created", group_id: "g", name: "group", title: "phrase", content: "body" };
    f.store.setState({ selectedGroupId: "g" });
    const pending = kind === "group" ? f.store.getState().createGroup("group") : f.store.getState().createPhrase("g", "phrase", "body");
    const field = kind === "group" ? "groups" : "phrases";f.store.setState({ [field]: [item] });
    f.deliver(item);await pending;assert.equal(f.store.getState()[field].length, 1);
  }
});

test("a phrase created for the previous selection cannot enter the current group list", async () => {
  const f = fixture();f.store.setState({ selectedGroupId: "old" });
  const pending = f.store.getState().createPhrase("old", "title", "body");
  f.store.setState({ selectedGroupId: "new", phrases: [{ id: "new-phrase" }] });
  f.deliver({ id: "old-phrase", group_id: "old" });await pending;
  assert.equal(f.store.getState().phrases.map((item: { id: string }) => item.id).join(","), "new-phrase");
});
