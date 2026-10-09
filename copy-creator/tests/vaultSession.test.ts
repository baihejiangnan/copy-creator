import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual mounted effect with a synthetic DOM and deferred native transport.
function fixture() {
  let epoch = 1, locked = 0, error: string | null = null;
  let resolve!: () => void, reject!: (reason: string) => void;
  const handlers = new Map<string, (event: unknown) => void>();
  const calls: { command: string; origin: number }[] = [];
  class Element { closest() { return this; } }
  class Input extends Element {
    private text = "synthetic text";
    get value() { return this.text; } set value(next: string) { this.text = next; }
    selectionStart = 0; selectionEnd = 9; readOnly = false; disabled = false; isConnected = true;
    dispatchEvent() {} setSelectionRange() {}
  }
  const input = new Input();
  const state = { status: { unlocked: true }, clearLocked: () => { locked++; state.status.unlocked = false; }, setError: (next: string) => { error = next; } };
  const exports: { default?: () => void } = {};
  const source = ts.transpileModule(readFileSync(new URL("../src/components/VaultSession.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(source, { exports, Date, Element, HTMLInputElement: Input, HTMLTextAreaElement: class extends Input {}, InputEvent: class {},
    document: { addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler), removeEventListener() {} },
    require: (name: string) => {
      if (name === "react") return { useEffect: (run: () => void) => run() };
      if (name === "@tauri-apps/api/event") return { listen: async (name: string, handler: (event: unknown) => void) => { handlers.set(name, handler); return () => {}; } };
      if (name === "../stores/vaultStore") return { useVaultStore: { getState: () => state } };
      if (name === "../lib/storageIdentity") return {
        getStorageIdentity: () => Promise.resolve(epoch), isCurrentStorageIdentity: (origin: number) => origin === epoch,
        invokeStorage: (command: string, _args: unknown, origin: number) => { calls.push({ command, origin }); return new Promise<void>((yes, no) => { resolve = yes; reject = no; }); },
      };
      throw Error("Unexpected dependency " + name);
    },
  });
  exports.default!();
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { input, calls, emit: (name: string, payload: unknown) => handlers.get(name)!({ payload }),
    act: async (name: string) => { handlers.get(name)!({ target: input, type: name, preventDefault() {} }); await flush(); },
    migrate: () => { epoch++; state.status.unlocked = true; },
    finish: async (reason?: string) => { if (reason) reject(reason); else resolve(); await flush(); },
    inspect: () => ({ locked, error, unlocked: state.status.unlocked }),
  };
}

test("a delayed source vault lock event cannot clear the newly unlocked target", () => {
  const f = fixture(); f.migrate(); f.emit("vault-locked", { storage_epoch: 1, value: null });
  assert.equal(f.inspect().unlocked, true); f.emit("vault-locked", { storage_epoch: 2, value: null });
  assert.equal(f.inspect().locked, 1);
});

for (const reason of ["vault.locked", "lifecycle.busy"]) {
  test(`late activity failure ${reason} cannot lock a new storage session`, async () => {
    const f = fixture(); await f.act("pointerdown"); assert.equal(f.calls[0].origin, 1);
    f.migrate(); await f.finish(reason); assert.equal(f.inspect().locked, 0);
  });
}

test("current activity lock failure clears secrets; a transient busy error does not", async () => {
  for (const reason of ["vault.locked", "lifecycle.busy"]) {
    const f = fixture(); await f.act("pointerdown"); await f.finish(reason);
    assert.equal(f.inspect().locked, reason === "vault.locked" ? 1 : 0);
  }
});

for (const reason of ["vault.locked", "vault.copyFailed"]) {
  test(`late cut failure ${reason} cannot publish into the target`, async () => {
    const f = fixture(); await f.act("cut"); f.migrate(); await f.finish(reason);
    assert.deepEqual(f.inspect(), { locked: 0, error: null, unlocked: true }); assert.equal(f.input.value, "synthetic text");
  });
}

test("a delayed cut acknowledgment cannot modify a reused input after relocation", async () => {
  const f = fixture(); await f.act("cut"); f.migrate(); await f.finish(); assert.equal(f.input.value, "synthetic text");
});

test("a current cut acknowledgment removes exactly the copied selection", async () => {
  const f = fixture(); await f.act("cut"); await f.finish(); assert.equal(f.input.value, " text");
});
