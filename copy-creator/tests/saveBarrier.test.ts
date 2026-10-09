import { test } from "node:test";
import assert from "node:assert/strict";
import { SaveBarrier } from "../src/lib/saveBarrier.ts";

function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("browser host timers are not invoked with the barrier timer object as receiver", async (context) => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  context.mock.method(globalThis, "setTimeout", function (this: unknown, callback: () => void, delay: number) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return originalSet(callback, delay);
  });
  context.mock.method(globalThis, "clearTimeout", function (this: unknown, timer: ReturnType<typeof setTimeout>) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    originalClear(timer);
  });
  const barrier = new SaveBarrier(); let applied = false;
  await barrier.run("archive", async () => { applied = true; });
  assert.equal(applied, true); assert.equal(barrier.getSnapshot().busy, false);
});

test("freezes all writers before flushing and resumes only after the operation settles", async () => {
  const barrier = new SaveBarrier(), saved = deferred(), operation = deferred(), calls: string[] = [];
  barrier.register("a", { pause: () => { calls.push("pause-a"); }, flush: () => { calls.push("flush-a"); return saved.promise; }, resume: () => { calls.push("resume-a"); } });
  barrier.register("b", { pause: () => { calls.push("pause-b"); }, flush: async () => { calls.push("flush-b"); }, resume: () => { calls.push("resume-b"); } });
  const result = barrier.run("export", () => { calls.push("operation"); return operation.promise; });
  assert.deepEqual(calls, ["pause-a", "pause-b"]); await tick();
  assert.equal(calls.includes("operation"), false); saved.resolve(); await tick();
  assert.equal(calls.includes("operation"), true); assert.equal(barrier.getSnapshot().busy, true);
  operation.resolve(); await result;
  assert.deepEqual(calls.slice(-2), ["resume-b", "resume-a"]); assert.equal(barrier.getSnapshot().busy, false);
});

test("failed saves retain their error and cannot start native mutation", async () => {
  const barrier = new SaveBarrier(); let ran = false, resumed = false;
  barrier.register("failed", { pause() {}, flush: async () => { throw { code: "notes.conflict" }; }, resume: () => { resumed = true; } });
  await assert.rejects(barrier.run("exit", async () => { ran = true; }), { code: "notes.conflict" });
  assert.equal(ran, false); assert.equal(resumed, true); assert.equal(barrier.getSnapshot().busy, false);
  assert.deepEqual(barrier.getSnapshot().error, { code: "notes.conflict" });
});

test("timed out flush cannot start an operation after its late acknowledgement", async () => {
  let expire!: () => void;
  const barrier = new SaveBarrier({ setTimeout: (callback) => { expire = callback; return 1 as unknown as ReturnType<typeof setTimeout>; }, clearTimeout() {} });
  const save = deferred(); let ran = 0, resumed = 0;
  barrier.register("slow", { pause() {}, flush: () => save.promise, resume: () => { resumed++; } });
  const result = barrier.run("storage", async () => { ran++; }); await tick(); expire();
  await assert.rejects(result, /lifecycle.saveTimeout/); save.resolve(); await tick();
  assert.equal(ran, 0); assert.equal(resumed, 1);
});

test("concurrent destructive operations and late writer registration are refused", async () => {
  const barrier = new SaveBarrier(), save = deferred();
  barrier.register("slow", { pause() {}, flush: () => save.promise, resume() {} });
  const result = barrier.run("backup", async () => {});
  await assert.rejects(barrier.run("exit", async () => {}), /lifecycle.busy/);
  assert.throws(() => barrier.register("new", { pause() {}, flush: async () => {}, resume() {} }), /lifecycle.busy/);
  save.resolve(); await result;
});

test("partial pause and failed operation both release the barrier", async () => {
  for (const pauseFails of [true, false]) {
    const barrier = new SaveBarrier(); let resumed = false;
    barrier.register("a", { pause: () => { if (pauseFails) throw new Error("pause"); }, flush: async () => {}, resume: () => { resumed = true; } });
    await assert.rejects(barrier.run("import", async () => { throw new Error("operation"); }));
    assert.equal(resumed, true); assert.equal(barrier.getSnapshot().busy, false);
  }
});

test("terminal success remains frozen, terminal failure resumes for recovery", async () => {
  for (const success of [true, false]) {
    const barrier = new SaveBarrier(); let resumed = false;
    barrier.register("a", { pause() {}, flush: async () => {}, resume: () => { resumed = true; } });
    const result = barrier.run("restart", async () => { if (!success) throw new Error("native failure"); }, { terminal: true });
    if (success) await result; else await assert.rejects(result);
    assert.equal(barrier.getSnapshot().busy, success); assert.equal(resumed, !success);
  }
});

test("hide hints report failures but do not destroy sessions or freeze input", async () => {
  const barrier = new SaveBarrier(); let paused = false;
  barrier.register("a", { pause: () => { paused = true; }, flush: async () => { throw new Error("disk"); }, resume() {} });
  await barrier.hintFlush(); assert.equal(paused, false); assert.equal(barrier.getSnapshot().busy, false);
  assert.ok(barrier.getSnapshot().error); barrier.dismissError(); assert.equal(barrier.getSnapshot().error, null);
});
