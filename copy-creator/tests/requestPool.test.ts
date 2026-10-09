import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestPool, trimImageCache } from "../src/lib/requestPool.ts";
const tick = async () => { for (let n = 0; n < 10; n++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
test("image requests coalesce while active and queued; concurrency and admission are bounded", async () => {
  const pool = new RequestPool<string>(1, 1), first = deferred<string>(), second = deferred<string>();
  let count = 0;
  const a = pool.request("a", () => { count++; return first.promise; });
  const duplicate = pool.request("a", () => { throw new Error("duplicate IPC"); });
  const b = pool.request("b", () => { count++; return second.promise; });
  assert.equal(await pool.request("overflow", async () => "bad"), undefined);
  await tick(); assert.equal(count, 1); assert.equal(pool.running, 1); assert.equal(pool.pending, 1);
  first.resolve("one"); assert.equal(await a, "one"); assert.equal(await duplicate, "one");
  await tick(); assert.equal(count, 2); second.resolve("two"); assert.equal(await b, "two");
  await tick(); assert.equal(pool.running, 0);
});
test("the last cancelled queued image never enters native work; shared consumers remain valid", async () => {
  const pool = new RequestPool<string>(1, 2), first = deferred<string>(); let queuedCalls = 0;
  const abort = new AbortController(), shared = new AbortController();
  const a = pool.request("a", () => first.promise, abort.signal);
  const survivor = pool.request("a", () => first.promise, shared.signal);
  const cancel = new AbortController();
  const b = pool.request("b", async () => { queuedCalls++; return "unexpected"; }, cancel.signal);
  cancel.abort(); abort.abort(); assert.equal(await b, undefined); assert.equal(await a, undefined);
  first.resolve("retained"); assert.equal(await survivor, "retained"); await tick(); assert.equal(queuedCalls, 0);
});
test("synchronous image decode failure releases capacity and forwards failure to all consumers", async () => {
  const pool = new RequestPool<string>(1, 2);
  const a = pool.request("bad", () => { throw new Error("decode"); });
  const duplicate = pool.request("bad", async () => "unexpected");
  const b = pool.request("next", async () => "ok");
  await Promise.all([assert.rejects(a, /decode/), assert.rejects(duplicate, /decode/)]);
  assert.equal(await b, "ok"); await tick(); assert.equal(pool.running, 0);
});
test("image cache enforces both count and string byte budgets, including one oversized image", () => {
  assert.deepEqual(trimImageCache({ old: "123", recent: "45", huge: "123456789" }, 2, 10), { old: "123", recent: "45" });
  assert.deepEqual(trimImageCache({ a: "1", b: "2", c: "3" }, 2, 100), { b: "2", c: "3" });
  assert.deepEqual(trimImageCache({ huge: "12345" }, 1, 8), {});
});
