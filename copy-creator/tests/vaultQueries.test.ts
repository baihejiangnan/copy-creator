/* eslint-disable @typescript-eslint/no-explicit-any -- Executes the real store with controlled native promises. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { LatestQuery } from "../src/lib/latestQuery.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const native: { args: any; resolve: (page: any) => void }[] = [];
  let state: any;
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(new URL("../src/stores/vaultStore.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(source, { exports, console, setTimeout, clearTimeout, require(name: string) {
    if (name === "zustand") return { create(initialize: any) { state = initialize((value: any) => { state = { ...state, ...value }; }, () => state); return { getState: () => state, setState(value: any) { state = { ...state, ...value }; } }; } };
    if (name.endsWith("/latestQuery")) return { LatestQuery };
    if (name.endsWith("/storageIdentity")) return { getStorageIdentity: async () => 1, onStorageIdentity() {}, isCurrentStorageIdentity: () => true, invokeStorage: async (_command: string, args: any) => new Promise(resolve => native.push({ args, resolve })) };
    if (name.endsWith("/types/vault")) return { VAULT_AUTO_LOCK_OPTIONS: ["3hours"] };
    return {};
  } });
  const store = exports.useVaultStore; store.setState({ status: { configured: true, unlocked: true } });
  const page = (title: string) => ({ entries: [{ id: title, title }], total: 1, identity_total: 1, detail_total: 1, independent_total: 0 });
  return { store, native, page };
}
test("vault search has one native read and one replaceable pending query; stale pages never publish", async () => {
  const f = fixture(); const first = f.store.getState().refresh(); await tick();
  f.store.getState().setSearch("intermediate"); const skipped = f.store.getState().refresh(); await tick();
  f.store.getState().setQuery("entry", "work"); f.store.getState().setSearch("newest"); const newest = f.store.getState().refresh(); await tick();
  assert.equal(f.native.length, 1); f.native[0].resolve(f.page("old")); await tick();
  assert.equal(f.native.length, 2); assert.equal(f.native[1].args.search, "newest"); assert.equal(f.native[1].args.identity, "work"); assert.equal(f.store.getState().entries.length, 0);
  f.native[1].resolve(f.page("new")); await Promise.all([first, skipped, newest]); assert.equal(f.store.getState().entries[0].title, "new");
});
test("locking clears counts and pages and rejects late protected responses", async () => {
  const f = fixture(); const pending = f.store.getState().refresh(); await tick(); f.store.getState().clearLocked();
  f.native[0].resolve(f.page("stale-secret-summary")); await pending;
  assert.equal(f.store.getState().entries.length, 0); assert.equal(f.store.getState().total, 0); assert.equal(f.store.getState().identityTotal, 0); assert.equal(f.store.getState().listing, false);
});
