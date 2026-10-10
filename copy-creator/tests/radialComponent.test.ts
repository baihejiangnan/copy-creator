/* eslint-disable @typescript-eslint/no-explicit-any -- Minimal React/native test adapter executes the real TSX without a desktop. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { RadialNotes, RADIAL_ALL, RADIAL_UNGROUPED } from "../src/lib/radialNotes.ts";
import { requestRadialFlush } from "../src/lib/radialNoteFlush.ts";
import { ownEventSubscriptions } from "../src/lib/eventSubscriptions.ts";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
test("real radial component lists notes, dispatches by tab, waits for save and owns its listeners", async () => {
  const events = new Map<string, Set<(value: any) => unknown>>();
  const calls: string[] = [], pasted: any[] = [], cleanup: (() => void)[] = [];
  let target: any = null, hidden = 0, receipt: any;
  const dispatch = (name: string, payload: any = {}) => Promise.all([...events.get(name) ?? []].map(fn => fn({ payload })));
  const listen = async (name: string, fn: (value: any) => unknown) => {
    if (!events.has(name)) events.set(name, new Set());
    events.get(name)!.add(fn); return () => { events.get(name)!.delete(fn); };
  };
  const invoke = async (command: string, args: any) => {
    calls.push(command);
    if (command === "get_setting") return "";
    if (command === "get_suiji_groups") return { storage_epoch: 1, value: [] };
    if (command === "list_suiji") return { storage_epoch: 1, value: { records: [{ id: "same-id", title: "New note", summary: "summary" }], next_cursor: null } };
    if (command === "get_note") return { storage_epoch: 1, value: { id: args.id, body: "full saved body\r\n  ", refs: [], deleted_at_ms: null, archived_at_ms: null } };
    throw Error(command);
  };
  const clipboard = { records: [{ id: "same-id", type: "text", content: "clipboard collision", created_at: "2026-01-01" }],
    init() {}, setVisible() {}, loadRecords() {}, pasteRecord() { pasted.push("wrong clipboard record"); } };
  const store = Object.assign((selector: any) => selector(clipboard), { getState: () => clipboard });
  const slots: any[] = []; let cursor = 0; const effects: (() => void)[] = [];
  const memo = (value: any, deps: any[]) => {
    const index = cursor++, old = slots[index];
    if (!old || deps.some((item, i) => item !== old.deps[i])) slots[index] = { value, deps };
    return slots[index].value;
  };
  const react = {
    useState(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (value: any) => { slots[index] = value; }]; },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useCallback: memo,
    useEffect(fn: any, deps: any[]) { const changed = memo({}, deps); if (!changed.ran) { changed.ran = true; effects.push(() => { const stop = fn(); if (stop) cleanup.push(stop); }); } },
    useSyncExternalStore(_subscribe: any, snapshot: any) { return snapshot(); },
  };
  const source = readFileSync(new URL("../src/components/RadialMenu/index.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports: any = {};
  vm.runInNewContext(compiled, { exports, console, crypto, Date, document: { documentElement: { setAttribute() {} }, elementFromPoint: () => target,
    addEventListener() {}, removeEventListener() {} }, window: { addEventListener() {}, removeEventListener() {} },
    require(name: string) {
      if (name === "react") return react;
      if (name === "react/jsx-runtime") return { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) };
      if (name === "react-i18next") return { useTranslation: () => ({ t: (key: string) => key }) };
      if (name.endsWith("/i18n")) return { default: { language: "en", changeLanguage() {} } };
      if (name === "@tauri-apps/api/core") return { invoke };
      if (name === "@tauri-apps/api/event") return { listen, emitTo: async (_window: string, _name: string, request: any) => { receipt = request; } };
      if (name === "@tauri-apps/api/window") return { getCurrentWindow: () => ({ hide: async () => { hidden++; } }) };
      if (name.endsWith("/clipboardStore")) return { useClipboardStore: store };
      if (name.endsWith("/phraseStore")) return { usePhraseStore: Object.assign((selector: any) => selector({ groups: [], phrases: [] }), { getState: () => ({ groups: [], phrases: [], init() {}, loadPhrases() {} }) }) };
      if (name.endsWith("/radialNotes")) return { RadialNotes, RADIAL_ALL, RADIAL_UNGROUPED };
      if (name.endsWith("/radialNoteFlush")) return { requestRadialFlush };
      if (name.endsWith("/eventSubscriptions")) return { ownEventSubscriptions };
      if (name.endsWith("/storageIdentity")) return { getStorageIdentity: async () => 1, isCurrentStorageIdentity: (epoch: number) => epoch === 1,
        invokeStorage: async (command: string, args: any, epoch: number) => { pasted.push({ command, args, epoch }); }, onStorageIdentity: () => () => {} };
      if (name === "./useHoverSwitch") return { useHoverSwitch: (fn: any) => ({ handleEnter: fn, handleLeave() {}, progressKey: null, progress: 0 }) };
      if (name === "./HoverProgress") return { HoverProgress() {} };
      throw Error(name);
    } });
  const render = () => { cursor = 0; const tree = exports.default(); effects.splice(0).forEach(fn => fn()); return tree; };
  const find = (tree: any, predicate: (node: any) => boolean): any => {
    if (!tree || typeof tree !== "object") return undefined;
    if (Array.isArray(tree)) return tree.map(child => find(child, predicate)).find(Boolean);
    return predicate(tree) ? tree : find(tree.props?.children, predicate);
  };
  const hover = (attribute: string, value: string) => { target = { closest: (selector: string) => selector === `[${attribute}]` ? { getAttribute: () => value } : null }; };
  try {
    render(); await tick();
    const count = [...events.values()].reduce((sum, listeners) => sum + listeners.size, 0);
    await dispatch("radial-menu-down", { theme: "dark" }); await tick();
    render(); hover("data-radial-nav", "phrases"); await dispatch("radial-menu-move", { x: 1, y: 1 });
    assert.ok(find(render(), node => node.props?.["data-radial-item-id"] === "same-id"), "actual phrases tab must render a new/migrated note");
    hover("data-radial-item-id", "same-id"); await dispatch("radial-menu-move", { x: 1, y: 1 }); render();
    const up = dispatch("radial-menu-up"); await tick();
    assert.equal(pasted.length, 0); assert.ok(receipt, "main save request must precede detail read");
    await dispatch("radial-menu-down", { theme: "dark" }); await dispatch("radial-menu-up");
    assert.equal(calls.filter(command => command === "get_suiji_groups").length, 1, "cannot start a second gesture during save/paste");
    await dispatch("radial-note-flushed", { ...receipt, error: null }); await up;
    assert.equal(pasted[0].args.text, "full saved body\r\n  "); assert.equal(pasted[0].epoch, 1); assert.equal(hidden, 1);
    // A rejected save must keep the popup with a visible dismiss/error control.
    await dispatch("radial-menu-down", { theme: "dark" }); await tick(); render();
    hover("data-radial-item-id", "same-id"); await dispatch("radial-menu-move", { x: 1, y: 1 }); render();
    const failed = dispatch("radial-menu-up"); await tick();
    await dispatch("radial-note-flushed", { ...receipt, error: "notes.conflict" }); await failed;
    assert.ok(find(render(), node => node.type === "button" && node.props.children === "radialMenu.pasteFailed"));
    assert.equal(pasted.length, 1); assert.equal(hidden, 1);
    assert.equal([...events.values()].reduce((sum, listeners) => sum + listeners.size, 0), count, "show/rerender does not accumulate listeners");
  } finally { cleanup.forEach(fn => fn()); await tick(); }
  assert.equal([...events.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0);
});

test("clipboard card uses bilingual expansion labels and an accessible delete name", () => {
  const source = readFileSync(new URL("../src/pages/ClipboardPage/ClipboardCard.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /收起长文本|展开完整文本|["']加载["']/);
  assert.match(source, /className="card-delete-btn"[^>]*aria-label=\{t\("common.delete"\)\}/);
  for (const locale of ["en", "zh-CN"]) {
    const json = JSON.parse(readFileSync(new URL(`../src/i18n/${locale}.json`, import.meta.url), "utf8"));
    for (const key of ["collapseText", "expandText", "loadingText", "collapse", "expand", "invalidRecordType", "apiKeyTooLong", "updateFailed"]) assert.ok(json.clipboard[key]);
    assert.ok(json.common.delete); assert.ok(json.radialMenu.loading); assert.ok(json.radialMenu.pasteFailed);
  }
});

test("radial no longer contains obsolete focus tracking, hidden branch or debug logging", () => {
  const source = readFileSync(new URL("../src/components/RadialMenu/index.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /lastFocusRef|radial-menu-hidden|console\.log/);
});

test("real manual Key handler displays a native code and hides unexpected error details", async () => {
  const source = ts.createSourceFile("ClipboardCard.tsx", readFileSync(new URL("../src/pages/ClipboardPage/ClipboardCard.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleToggleUserApiKey" && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source); assert.ok(callback);
  const handler = ts.createPrinter().printNode(ts.EmitHint.Expression, callback, source);
  const compiled = ts.transpileModule(`exports.run = ${handler}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  for (const [failure, expected] of [["clipboard.invalidRecordType", "clipboard.invalidRecordType"], [Error("synthetic private diagnostic"), "clipboard.updateFailed"]]) {
    const exports: any = {}; let displayed: unknown = null;
    vm.runInNewContext(compiled, { exports, record: { id: "synthetic", user_api_key: false }, setCtxMenu() {},
      invokeStorage: async () => { throw failure; }, loadRecords: async () => { throw Error("failed mutation must not reload"); },
      setCaptureError: (value: unknown) => { displayed = value; } });
    await exports.run({ stopPropagation() {} }); assert.equal(displayed, expected);
  }
});
