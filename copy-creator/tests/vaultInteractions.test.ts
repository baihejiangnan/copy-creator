/* eslint-disable @typescript-eslint/no-explicit-any -- Runs real field handlers with synthetic React/native adapters. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createVaultEntry, vaultFieldLabel } from "../src/lib/vaultModel.ts";
import { hasUnsavedVaultDraft, ownVaultNavigation, requestVaultNavigation } from "../src/lib/vaultNavigation.ts";

function fieldFixture() {
  let state: any[] = [], cursor = 0, insideSelection = false;
  const calls: any[] = [];
  const entry = createVaultEntry("server", key => key); entry.id = "synthetic-entry";
  entry.fields[0].label = "IP"; entry.fields[0].value = "203.0.113.24";
  entry.fields[1].label = "Password"; entry.fields[1].value = "DEMO_ONLY_SECRET";
  const react = { useState(initial: any) { const index = cursor++; state[index] ??= typeof initial === "function" ? initial() : initial; return [state[index], (value: any) => { state[index] = typeof value === "function" ? value(state[index]) : value; }]; } };
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(new URL("../src/pages/VaultPage/EntryDetail.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(source, { exports, window: { getSelection: () => ({ toString: () => "selected text", anchorNode: {}, focusNode: {} }) }, require(name: string) {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) };
    if (name === "react-i18next") return { useTranslation: () => ({ t: (key: string) => key }) };
    if (name.endsWith("/Icons")) return { Icons: {} };
    if (name.endsWith("/vaultModel")) return { vaultFieldLabel };
    if (name.endsWith("/vaultStore")) return { useVaultStore: () => ({ busy: false, copyField: (...args: any[]) => calls.push(["copy", ...args]), pasteField: (...args: any[]) => calls.push(["paste", ...args]) }) };
    return {};
  } });
  const render = () => { cursor = 0; return exports.VaultFields({ entry }); };
  const find = (value: any, label: string): any => Array.isArray(value) ? value.map(child => find(child, label)).find(Boolean) : value && typeof value === "object" ? value.props?.["aria-label"] === label ? value : find(value.props?.children, label) : null;
  return { entry, calls, render, click(label: string) { const button = find(render(), label); assert.ok(button); button.props.onClick({ currentTarget: { contains: () => insideSelection } }); }, selectField() { insideSelection = true; }, clear() { state = []; } };
}
test("field click sends only stable IDs, including a hidden password and a selected target range", () => {
  const f = fieldFixture(); f.click("vault2.paste IP"); f.click("vault2.paste Password");
  assert.deepEqual(f.calls, [["paste", f.entry.id, `field:${f.entry.fields[0].id}`], ["paste", f.entry.id, `field:${f.entry.fields[1].id}`]]);
  assert.ok(!JSON.stringify(f.calls).includes("DEMO_ONLY_SECRET"));
});
test("copy and reveal are independent; selecting field text suppresses paste", () => {
  const f = fieldFixture(); f.click("vault.copy Password"); f.click("vault.show Password");
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], "copy"); assert.ok(JSON.stringify(f.render()).includes("DEMO_ONLY_SECRET"));
  f.selectField(); f.click("vault2.paste IP"); assert.equal(f.calls.length, 1);
});
test("navigation is deferred until explicit acceptance and owner cleanup cannot remove a successor", () => {
  let accepted: (() => void) | undefined; let navigations = 0;
  const stop = ownVaultNavigation(proceed => { accepted = proceed; }, () => true);
  requestVaultNavigation(() => navigations++); assert.equal(navigations, 0); assert.equal(hasUnsavedVaultDraft(), true);
  accepted?.(); assert.equal(navigations, 1);
  const successor = ownVaultNavigation(proceed => proceed(), () => false); stop();
  assert.equal(hasUnsavedVaultDraft(), false); requestVaultNavigation(() => navigations++); assert.equal(navigations, 2);
  successor(); requestVaultNavigation(() => navigations++); assert.equal(navigations, 3);
});
