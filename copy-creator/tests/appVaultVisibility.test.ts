/* eslint-disable @typescript-eslint/no-explicit-any -- Render the real App with synthetic React and native adapters. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { VAULT_AUTO_LOCK_OPTIONS } from "../src/types/vault.ts";

function fixture(autoLock: string, authenticating = false) {
  const calls: string[] = [];
  const vault = {
    status: { unlocked: !authenticating, auto_lock: autoLock }, busy: authenticating,
    async lock() { calls.push("lock_vault"); vault.status.unlocked = false; vault.busy = false; },
  };
  const react = {
    useState: (initial: any) => [initial, () => {}],
    useRef: (initial: any) => ({ current: initial }),
    useEffect() {},
    useCallback: (callback: any) => callback,
    useSyncExternalStore: (_subscribe: any, snapshot: any) => snapshot(),
    lazy: () => () => null,
  };
  const nativeWindow = { async minimize() { calls.push("minimize"); } };
  const exports: any = {};
  const source = ts.transpileModule(readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(source, { exports, console, require(name: string) {
    if (name === "react") return react;
    if (name === "react/jsx-runtime") return { jsx: (type: any, props: any) => ({ type, props }), jsxs: (type: any, props: any) => ({ type, props }) };
    if (name === "react-i18next") return { useTranslation: () => ({ t: (key: string) => key }) };
    if (name === "@tauri-apps/api/window") return { getCurrentWindow: () => nativeWindow };
    if (name === "@tauri-apps/api/core") return { invoke: async (command: string) => { calls.push(command); } };
    if (name === "./stores/vaultStore") return { useVaultStore: { getState: () => vault } };
    if (name === "./stores/settingsStore") return { useSettingsStore: () => ({ themeMode: "light" }) };
    if (name === "./stores/updateStore") return { useUpdateStore: (select: any) => select({ result: null }) };
    if (name === "./stores/settingsEditorStore") return { useSettingsEditorStore: (select: any) => select({ errors: {} }) };
    if (name === "./components/Icons") return { Icons: {} };
    if (name === "./lib/lifecycle") return { saveBarrier: {
      subscribe() {}, getSnapshot: () => ({ busy: false }),
      hintFlush: () => { calls.push("hintFlush"); return new Promise(() => {}); },
    } };
    if (name === "./lib/documentVisible") return { refreshWindowVisibility: async () => { calls.push("refreshVisibility"); } };
    return {};
  } });
  const find = (tree: any, className: string): any => {
    if (!tree || typeof tree !== "object") return;
    if (Array.isArray(tree)) return tree.map(child => find(child, className)).find(Boolean);
    return tree.props?.className === className ? tree : find(tree.props?.children, className);
  };
  const tree = exports.default();
  return { vault, calls, click: async (className: string) => {
    const button = find(tree, className);
    assert.ok(button, "real window control must be rendered");
    await button.props.onClick();
  } };
}

for (const policy of VAULT_AUTO_LOCK_OPTIONS) {
  for (const control of ["window-minimize-btn", "window-close-btn"]) {
    test(`${control} preserves the vault session under ${policy} while hinting saves`, async () => {
      const f = fixture(policy);
      await f.click(control);
      assert.deepEqual(f.calls, control === "window-minimize-btn"
        ? ["hintFlush", "minimize", "refreshVisibility"] : ["hintFlush", "hide_main_window"]);
      assert.equal(f.vault.status.unlocked, true);
      assert.equal(f.vault.status.auto_lock, policy);
    });
  }
}

for (const control of ["window-minimize-btn", "window-close-btn"]) {
  test(`${control} does not cancel an in-flight vault authentication`, async () => {
    const f = fixture("3hours", true);
    await f.click(control);
    assert.equal(f.vault.busy, true);
    assert.ok(!f.calls.includes("lock_vault"));
  });
}
