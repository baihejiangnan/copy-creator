import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { create } from "zustand";

interface State {
  initialized: boolean; checking: boolean; error: string | null; errorDetail: string | null;
  result: { status: string } | null; checkedAt: number | null; downloading: boolean;
  downloaded: { version: string } | null; progress: { downloaded: number } | null;
  autoCheck: boolean;
  start(): Promise<void>; initialize(reload?: boolean): Promise<void>; check(automatic?: boolean): Promise<void>;
  download(): Promise<void>; launch(): Promise<void>; setAutoCheck(value: boolean): Promise<void>;
}
interface Store { getState(): State; setState(value: object): void }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const available = { status: "available", latestVersion: "0.3.0", releaseUrl: "https://github.com/baihejiangnan/copy-creator/releases/tag/v0.3.0", notes: "test", mode: "portable", canDownload: true, downloadError: null, assetSize: 100 };
function fixture(auto = true) {
  let epoch = 1, onIdentity!: () => void;
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  let transport: (command: string, args?: Record<string, unknown>) => Promise<unknown> = async command => {
    if (command === "get_app_info") return { version: "0.2.25" };
    if (command === "get_all_settings") return { auto_check_updates: auto ? "1" : "0" };
    if (command === "check_for_updates") return available;
  };
  const exports: { useUpdateStore?: Store } = {};
  const source = ts.transpileModule(readFileSync(new URL("../src/stores/updateStore.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, Date, console, require: (name: string) => {
    if (name === "zustand") return { create };
    if (name === "../lib/lifecycle") return { startLifecycle: async () => {} };
    if (name === "../lib/storageIdentity") return {
      getStorageIdentity: async () => epoch, isCurrentStorageIdentity: (value: number) => epoch === value,
      onStorageIdentity: (listener: () => void) => { onIdentity = listener; },
      invokeStorage: (command: string, args?: Record<string, unknown>) => transport(command, args),
    };
    if (name === "@tauri-apps/api/core") return {
      Channel: class { onmessage = () => {}; },
      invoke: (command: string, args?: Record<string, unknown>) => { calls.push({ command, args }); return transport(command, args); },
    };
    throw Error("Unexpected dependency " + name);
  } });
  return { store: exports.useUpdateStore!, calls, handle: (handler: typeof transport) => { transport = handler; },
    migrate: () => { epoch++; onIdentity(); } };
}

test("automatic startup and manual requests await a single real check", async () => {
  const f = fixture(); await f.store.getState().initialize();
  const reply = deferred<unknown>(); f.handle(async command => command === "check_for_updates" ? reply.promise : undefined);
  const startup = f.store.getState().start(); await Promise.resolve(); await Promise.resolve();
  const manual = f.store.getState().check(); const manual2 = f.store.getState().check();
  assert.equal(manual, manual2); assert.equal(f.store.getState().checking, true);
  let settled = false; void manual.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
  reply.resolve(available); await Promise.all([startup, manual]);
  assert.equal(f.calls.filter(call => call.command === "check_for_updates").length, 1);
  assert.equal(f.store.getState().result?.status, "available"); assert.equal(f.store.getState().checking, false);
  await f.store.getState().start(); assert.equal(f.calls.filter(call => call.command === "check_for_updates").length, 1);
});

test("disabled startup does not check but manual checking remains available", async () => {
  const f = fixture(false); await Promise.all([f.store.getState().start(), f.store.getState().start()]);
  assert.equal(f.calls.filter(call => call.command === "check_for_updates").length, 0);
  await f.store.getState().check(); assert.equal(f.calls.filter(call => call.command === "check_for_updates").length, 1);
  assert.equal(f.calls.at(-1)?.args?.automatic, false);
});

test("manual intent during an automatic cooldown receives one fresh network result", async () => {
  const f = fixture(); await f.store.getState().initialize();
  const skipped = deferred<unknown>(); let count = 0;
  f.handle(async () => ++count === 1 ? skipped.promise : available);
  const automatic = f.store.getState().check(true); await Promise.resolve();
  const manual = f.store.getState().check(); skipped.resolve(null);
  await Promise.all([automatic, manual]);
  assert.equal(f.calls.filter(call => call.command === "check_for_updates").length, 2);
  assert.equal(f.calls.at(-1)?.args?.automatic, false); assert.equal(f.store.getState().result?.status, "available");
});

test("errors survive finally, panel reinitialization and automatic cooldown; manual retry replaces them", async () => {
  const f = fixture(); await f.store.getState().initialize();
  f.handle(async command => { if (command === "check_for_updates") throw "updates.serverError|HTTP 503"; return command === "get_all_settings" ? { auto_check_updates: "1" } : { version: "0.2.25" }; });
  await f.store.getState().check();
  assert.equal(f.store.getState().checking, false); assert.equal(f.store.getState().error, "updates.serverError");
  assert.equal(f.store.getState().errorDetail, "HTTP 503"); assert.equal(f.store.getState().checkedAt, null);
  await f.store.getState().initialize(true); assert.equal(f.store.getState().error, "updates.serverError");
  f.handle(async () => null); await f.store.getState().check(true); assert.equal(f.store.getState().error, "updates.serverError");
  f.handle(async () => ({ ...available, status: "upToDate" })); await f.store.getState().check();
  assert.equal(f.store.getState().error, null); assert.equal(f.store.getState().result?.status, "upToDate"); assert.ok(f.store.getState().checkedAt);
});

test("download progress is shared; failure releases busy state and prevents launching", async () => {
  const f = fixture(); await f.store.getState().check();
  const reply = deferred<unknown>(); f.handle(async (command, args) => {
    if (command === "download_update") { (args?.progress as { onmessage(value: object): void }).onmessage({ downloaded: 50, total: 100 }); return reply.promise; }
  });
  const pending = f.store.getState().download(); assert.equal(f.store.getState().downloading, true);
  assert.equal(f.store.getState().progress?.downloaded, 50);
  await f.store.getState().check(); await f.store.getState().launch();
  assert.equal(f.calls.filter(call => call.command === "check_for_updates").length, 1);
  assert.equal(f.calls.filter(call => call.command === "launch_update").length, 0);
  reply.reject("updates.signatureInvalid"); await pending;
  assert.equal(f.store.getState().downloading, false); assert.equal(f.store.getState().downloaded, null);
  assert.equal(f.store.getState().error, "updates.signatureInvalid");
});

test("verified download exposes explicit launch action; launch receives only the expected version", async () => {
  const f = fixture(); await f.store.getState().check();
  f.handle(async command => command === "download_update" ? { version: "0.3.0", mode: "portable", path: "synthetic/new.exe" } : undefined);
  await f.store.getState().download(); assert.equal(f.store.getState().downloaded?.version, "0.3.0");
  assert.equal(f.calls.filter(call => call.command === "launch_update").length, 0);
  await f.store.getState().launch(); const launch = f.calls.find(call => call.command === "launch_update")!;
  assert.equal(JSON.stringify(launch.args), JSON.stringify({ expectedVersion: "0.3.0" }));
});

test("a delayed settings response cannot override the next storage identity", async () => {
  const f = fixture(); await f.store.getState().initialize();
  const reply = deferred<unknown>(); let reads = 0;
  f.handle(async command => command === "get_all_settings" ? (++reads === 1 ? reply.promise : { auto_check_updates: "0" }) : { version: "0.2.25" });
  const old = f.store.getState().initialize(true); await Promise.resolve(); f.migrate();
  reply.resolve({ auto_check_updates: "1" }); await old;
  for (let i=0; i<10; i++) await Promise.resolve();
  assert.equal(f.store.getState().autoCheck, false); assert.equal(f.store.getState().initialized, true);
  assert.equal(f.calls.filter(call => call.command === "check_for_updates").length, 0);
});
