import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Drives the real `lib/suiji.ts` and `stores/notesWorkspace.ts` inside a VM so the
// native boundary and the coordinator can be observed. These lock the two behaviours
// that made grouping or starring a record lose the change when the user navigated
// straight back (fix list P1-6 / P2-17).

type Note = {
  id: string; title: string; body: string; refs: { id: string; kind: string; target: string }[];
  summary: string; char_count: number; byte_count: number; created_at_ms: number; updated_at_ms: number;
  revision: number; archived_at_ms: number | null; deleted_at_ms: number | null; ref_count: number;
  source: unknown; group_id?: string | null; starred?: boolean;
};

function note(id: string, overrides: Partial<Note> = {}): Note {
  return { id, title: "", body: "saved", refs: [], summary: "saved", char_count: 5, byte_count: 5,
    created_at_ms: 1, updated_at_ms: 1, revision: 1, archived_at_ms: null, deleted_at_ms: null,
    ref_count: 0, source: null, ...overrides };
}

/** Coordinator stand-in exposing exactly the surface the two callers touch. */
function fakeCoordinator(initial: Note[]) {
  const sessions = new Map<string, { id: string; draft: Note; status: string; storageEpoch: number }>();
  const state = { epoch: 1, activeId: null as string | null, activations: [] as (string | null)[], discarded: [] as string[] };
  for (const item of initial) sessions.set(item.id, { id: item.id, draft: item, status: "clean", storageEpoch: 1 });
  const coordinator = {
    get storageEpoch() { return state.epoch; },
    get activeNoteId() { return state.activeId; },
    getSession: (id: string) => sessions.get(id),
    setActive(id: string | null) { state.activeId = id; state.activations.push(id); },
    load(value: Note) { sessions.set(value.id, { id: value.id, draft: value, status: "saved", storageEpoch: state.epoch }); },
    async discard(id: string) { state.discarded.push(id); sessions.delete(id); if (state.activeId === id) state.activeId = null; },
    async flush() { /* resolved by the caller-controlled `flushOutcome` below */ },
    markConflict() {},
  };
  return { coordinator, state, sessions };
}

/** Arguments the native boundary receives; the VM never inspects them further. */
type InvokeArgs = Record<string, unknown>;
type Invoke = (command: string, args: InvokeArgs) => unknown;
type NotesWorkspaceStore = {
  getState: () => {
    create: () => string;
    back: () => void;
    open: (id: string) => Promise<void>;
    selectedId: string | null;
    quickId: string | null;
    opening: boolean;
  };
  setState: (patch: Record<string, unknown>) => void;
};

function loadModules(options: {
  coordinator: ReturnType<typeof fakeCoordinator>["coordinator"];
  invoke: Invoke;
  runOperation?: (operation: () => Promise<void>) => Promise<void>;
  readNote?: (id: string) => Promise<unknown>;
}) {
  const modules = new Map<string, Record<string, unknown>>();
  const load = (file: string): Record<string, unknown> => {
    const cached = modules.get(file); if (cached) return cached;
    const exports: Record<string, unknown> = {}; modules.set(file, exports);
    const source = readFileSync(new URL(`../src/${file}.ts`, import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(compiled, { exports, console, crypto, AbortController, setTimeout, clearTimeout, Promise, Map, Set, Array, Object, JSON, Math, Error, String, Number, Boolean, Symbol, Date, require: (name: string) => {
      type Setter = (value: unknown) => void;
      type Getter = () => unknown;
      if (name === "zustand") return { create: (initialize: (set: Setter, get: Getter) => unknown) => {
        let state: unknown;
        const set: Setter = (value) => {
          const patch = typeof value === "function" ? (value as (current: unknown) => Record<string, unknown>)(state) : value;
          state = { ...(state as Record<string, unknown>), ...(patch as Record<string, unknown>) };
        };
        state = initialize(set, () => state); return { getState: () => state, setState: set };
      } };
      if (name === "@tauri-apps/api/core") return { invoke: options.invoke };
      if (name === "@tauri-apps/api/event") return { listen: async () => () => {} };
      if (name === "./storageIdentity" || name === "../lib/storageIdentity") return {
        invokeStorage: (command: string, args: InvokeArgs, capturedEpoch: number) =>
          Promise.resolve(options.invoke(command, { ...args, expectedStorageEpoch: capturedEpoch })),
      };
      if (name === "./noteCoordinator" || name === "../lib/noteCoordinator") return {
        noteFailure: (error: unknown) => ({ code: (error as { code?: string })?.code ?? "notes.failed", message: "" }),
      };
      if (name === "./notes" || name === "../lib/notes") return {
        getNoteCoordinator: async () => options.coordinator,
        getNoteFeed: async () => ({ invalidate() {} }),
        // The real `readNote` returns the cached session untouched, and the fake
        // exposes no session for an unknown id — same contract.
        readNote: options.readNote ?? (async (id: string) => options.coordinator.getSession(id)),
      };
      if (name === "./lifecycle" || name === "../lib/lifecycle") return {
        saveBarrier: { run: (_kind: string, operation: () => Promise<void>) => options.runOperation ? options.runOperation(operation) : operation() },
        onStorageChanged: () => () => {},
      };
      // Anything else relative resolves against the same source tree.
      if (name.startsWith("../")) return load(name.replace(/^\.\.\//, ""));
      if (name.startsWith("./")) return load(`${file.replace(/\/[^/]+$/, "/")}${name.replace(/^\.\//, "")}`);
      throw Error("Unexpected dependency " + name);
    } });
    return exports;
  };
  return load;
}

test("organizeNote keeps a selection made while the write was in flight", async () => {
  const target = note("grouped", { group_id: null });
  const mine = note("my-draft", { body: "user is editing this" });
  const opened = note("opened-meanwhile", { body: "user clicked this during the write" });
  const f = fakeCoordinator([mine, target, opened]);
  f.state.activeId = mine.id;
  const calls: { command: string; args: InvokeArgs }[] = [];
  const load = loadModules({ coordinator: f.coordinator, invoke: (command, args) => {
    calls.push({ command, args });
    if (command === "get_note") return Promise.resolve({ storage_epoch: 1, value: target });
    if (command === "organize_note") {
      // The user selects another record while this write is still in flight.
      f.state.activeId = opened.id;
      return Promise.resolve({ storage_epoch: 1, value: { note: { ...target, group_id: args.groupId }, mutation_id: args.mutationId, applied: true } });
    }
    throw Error("unexpected command " + command);
  } });

  const suiji = load("lib/suiji") as { organizeNote: (id: string, patch: object) => Promise<void> };
  await suiji.organizeNote(target.id, { groupId: "group-1" });

  // The record that was rewritten is live again, and the selection the user made
  // while the write was in flight is still the active one.
  assert.ok(f.state.discarded.includes(target.id), "organizeNote reloads the rewritten record");
  assert.equal(f.state.activeId, opened.id,
    "a selection made during the write must not be clobbered by the pointer captured before it");
  assert.equal(f.sessions.get(target.id)?.draft.group_id, "group-1");
  assert.equal(calls.at(-1)?.command, "organize_note");
});

test("organizeNote restores its own record when it was the active one", async () => {
  const target = note("grouped", { group_id: null });
  const f = fakeCoordinator([target]);
  f.state.activeId = target.id;
  const load = loadModules({ coordinator: f.coordinator, invoke: (command, args) => {
    if (command === "get_note") return Promise.resolve({ storage_epoch: 1, value: target });
    if (command === "organize_note") return Promise.resolve({ storage_epoch: 1, value: { note: { ...target, group_id: args.groupId }, mutation_id: args.mutationId, applied: true } });
    throw Error("unexpected command " + command);
  } });

  const suiji = load("lib/suiji") as { organizeNote: (id: string, patch: object) => Promise<void> };
  await suiji.organizeNote(target.id, { groupId: "group-1" });
  assert.equal(f.state.activeId, target.id, "the rewritten record stays active when it already was");
});

test("back() releases the quick draft only after the flush settles as saved", async () => {
  const draft = note("quick", { body: "typed" });
  const f = fakeCoordinator([draft]);
  f.state.activeId = draft.id;
  f.sessions.get(draft.id)!.status = "dirty";
  let settleFlush!: () => void;
  const flushDone = new Promise<void>((resolve) => { settleFlush = resolve; });
  const originalFlush = f.coordinator.flush;
  (f.coordinator as { flush: () => Promise<void> }).flush = () => flushDone.then(() => { f.sessions.get(draft.id)!.status = "saved"; });

  const load = loadModules({ coordinator: f.coordinator, invoke: () => { throw Error("no IPC expected"); } });
  const store = (load("stores/notesWorkspace") as { useNotesWorkspace: NotesWorkspaceStore }).useNotesWorkspace;
  store.getState().create();
  store.setState({ selectedId: draft.id, quickId: draft.id });
  store.getState().back();

  // The draft stays released-to-quick only once the write is known to have landed.
  assert.equal(store.getState().selectedId, draft.id, "back() must not tear down before the flush settles");
  settleFlush();
  await flushDone;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.getState().selectedId, null, "back() clears the selection after a successful flush");
  assert.equal(store.getState().quickId, null, "a saved draft releases the quick slot");
  void originalFlush;
});

for (const destination of ["quick", "another-record"]) {
  test(`back() cannot cancel a newer open(${destination}) while its read is pending`, async () => {
    const draft = note("quick");
    const f = fakeCoordinator([draft, note("another-record")]);
    let finishFlush!: () => void;
    let finishRead!: () => void;
    const flushed = new Promise<void>(resolve => { finishFlush = resolve; });
    const read = new Promise<void>(resolve => { finishRead = resolve; });
    f.coordinator.flush = () => flushed;
    const load = loadModules({ coordinator: f.coordinator, readNote: () => read,
      invoke: () => { throw Error("no IPC expected"); } });
    const store = (load("stores/notesWorkspace") as { useNotesWorkspace: NotesWorkspaceStore }).useNotesWorkspace;
    store.setState({ coordinator: f.coordinator, selectedId: draft.id, quickId: draft.id });
    f.coordinator.setActive(draft.id);

    store.getState().back();
    const opening = store.getState().open(destination);
    finishFlush();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(store.getState().opening, true, "an old back must not cancel the newer navigation");
    finishRead();
    await opening;
    assert.equal(store.getState().selectedId, destination);
    assert.equal(f.state.activeId, destination);
  });
}

test("back() preserves an unsaved quick draft when flush fails", async () => {
  const draft = note("quick");
  const f = fakeCoordinator([draft]);
  f.sessions.get(draft.id)!.status = "conflict";
  f.coordinator.flush = async () => { throw { code: "notes.conflict" }; };
  const load = loadModules({ coordinator: f.coordinator, invoke: () => { throw Error("no IPC expected"); } });
  const store = (load("stores/notesWorkspace") as { useNotesWorkspace: NotesWorkspaceStore }).useNotesWorkspace;
  store.setState({ coordinator: f.coordinator, selectedId: draft.id, quickId: draft.id });
  store.getState().back();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.getState().quickId, draft.id);
  assert.equal(f.sessions.get(draft.id)?.draft.body, draft.body);
  assert.equal(f.state.discarded.length, 0);
});
