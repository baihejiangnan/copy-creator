import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function fixture() {
  const values: unknown[] = [], setters: ((value: unknown) => void)[] = [], events = new Map<string, (event: unknown) => void>();
  let epoch = 1, identity: (() => void) | undefined;
  const exports: { DataSection?: (props: object) => unknown } = {};
  const source = ts.transpileModule(readFileSync(new URL("../src/components/settings/DataSection.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(source, { exports, document: { hidden: false, addEventListener() {}, removeEventListener() {} }, require: (name: string) => {
    if (name === "react") return { useState: (initial: unknown) => { const index = values.length; values.push(initial); const set = (next: unknown) => { values[index] = next; }; setters.push(set); return [initial, set]; }, useEffect: (run: () => void) => run(), useId: () => "qa", useRef: (current: unknown) => ({ current }) };
    if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
    if (name === "react-i18next") return { useTranslation: () => ({ t: (key: string) => key }) };
    if (name === "@tauri-apps/api/event") return { listen: async (event: string, run: (event: unknown) => void) => { events.set(event, run); return () => {}; } };
    if (name === "../../lib/storageIdentity") return { isCurrentStorageIdentity: (origin: number) => epoch === origin, onStorageIdentity: (run: () => void) => { identity = run; return () => {}; } };
    if (name === "@tauri-apps/api/core") return { invoke: async () => {} };
    if (name === "../../stores/vaultStore") return { useVaultStore: { getState: () => ({}) } };
    if (name === "../../lib/lifecycle") return {};
    if (name.startsWith("@mui/icons-material/")) return { default: () => null };
    throw Error("Unexpected dependency " + name);
  } });
  exports.DataSection!({ onImported: async () => {} });
  const fill = () => { for (let i = 5; i <= 8; i++) setters[i]("QA synthetic private input"); };
  return { fill, read: () => values.slice(5, 9), event: (origin: number) => events.get("vault-locked")!({ payload: { storage_epoch: origin, value: null } }), migrate: () => { epoch++; identity?.(); } };
}

test("an old vault lock cannot clear passwords entered for the new backup target", () => {
  const f = fixture(); f.migrate(); f.fill(); f.event(1);
  assert.deepEqual(f.read(), Array(4).fill("QA synthetic private input"));
});
test("current vault lock clears all pending backup/master passwords", () => {
  const f = fixture(); f.fill(); f.event(1); assert.deepEqual(f.read(), Array(4).fill(""));
});
test("changing storage clears the previous target's pending private inputs", () => {
  const f = fixture(); f.fill(); f.migrate(); assert.deepEqual(f.read(), Array(4).fill(""));
});
