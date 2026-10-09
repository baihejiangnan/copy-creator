import { test } from "node:test";
import assert from "node:assert/strict";
import { NoteFeed } from "../src/lib/noteFeed.ts";
import { LatestQuery } from "../src/lib/latestQuery.ts";
import type { NotePage, NoteSummary, StorageResult } from "../src/types/note.ts";
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; }); return { promise,resolve,reject }; }
const tick = async () => { for (let i=0;i<20;i++) await Promise.resolve(); };
const row = (id: string): NoteSummary => ({ id,title:id,summary:id,char_count:1,byte_count:1,created_at_ms:1,updated_at_ms:1,revision:1,archived_at_ms:null,deleted_at_ms:null,ref_count:0 });
function page(id: string, epoch=1, next=false): StorageResult<NotePage> { return {storage_epoch:epoch,value:{records:[row(id)],next_cursor:next ? {id,sort_at_ms:1}:null}}; }
test("latest queue shares a read and replaces pending work before IPC", async () => {
  const queue=new LatestQuery<number>(), first=deferred<number>(), last=deferred<number>(); let calls=0;
  const a=queue.run("a",()=>{calls++; return first.promise;});
  assert.strictEqual(queue.run("a",()=>Promise.resolve(9)),a);
  const b=queue.run("b",async()=>{calls++;return 2;});
  const c=queue.run("c",()=>{calls++;return last.promise;}); await tick(); assert.equal(calls,1); assert.equal(await b,undefined);
  first.resolve(1); assert.equal(await a,1); await tick(); assert.equal(calls,2); last.resolve(3); assert.equal(await c,3);
});
test("old search results cannot replace the latest query; only the newest pending query runs", async () => {
  const responses: ReturnType<typeof deferred<StorageResult<NotePage>>>[]=[]; const queries: string[]=[];
  const feed=new NoteFeed(1,(query)=>{queries.push(query.search);const next=deferred<StorageResult<NotePage>>();responses.push(next);return next.promise;});
  const a=feed.load(); const b=feed.setQuery("active","old"); const c=feed.setQuery("active","new"); await tick(); assert.deepEqual(queries,[""]);
  responses[0].resolve(page("stale")); await a; await tick(); assert.deepEqual(queries,["","new"]); assert.deepEqual(feed.getSnapshot().records,[]);
  responses[1].resolve(page("current")); await Promise.all([b,c]); assert.equal(feed.getSnapshot().records[0].id,"current");
});
test("storage switching rejects stale identity without clearing an unrelated current query", async () => {
  const responses: ReturnType<typeof deferred<StorageResult<NotePage>>>[]=[];
  const feed=new NoteFeed(1,()=>{const next=deferred<StorageResult<NotePage>>();responses.push(next);return next.promise;});
  feed.setVisible(true); await tick(); feed.switchEpoch(2); responses[0].resolve(page("old")); await tick();
  responses[1].resolve(page("wrong",1)); await tick(); assert.equal(feed.getSnapshot().error?.code,"notes.storageChanged"); assert.equal(feed.getSnapshot().records.length,0);
});
test("hidden feed defers invalidation and opening it performs one refresh", async () => {
  let calls=0; const feed=new NoteFeed(1,async()=>{calls++;return page(String(calls));});
  feed.invalidate();feed.invalidate(); await tick(); assert.equal(calls,0);
  feed.setVisible(true); feed.load(); await tick(); assert.equal(calls,1);
  feed.setVisible(false); feed.invalidate(); await tick(); assert.equal(calls,1);
  feed.setVisible(true); await tick(); assert.equal(calls,2);
});
test("overlong Unicode search rejects asynchronously and preserves the last page without IPC", async () => {
  let calls=0;
  const feed=new NoteFeed(1,async()=>{calls++;return page("kept");});
  await feed.load();
  let rejected: Promise<void> | undefined;
  assert.doesNotThrow(()=>{rejected=feed.setQuery("active","中".repeat(257));});
  await assert.rejects(rejected!,{code:"notes.searchTooLong"});
  assert.equal(calls,1);assert.equal(feed.getSnapshot().records[0].id,"kept");
  await feed.setQuery("active","😀".repeat(256));assert.equal(calls,2);
});
test("cursor paging deduplicates summaries and retains at most one bounded page", async () => {
  const cursors: (string|undefined)[]=[];
  const feed=new NoteFeed(1,async(query)=>{
    cursors.push(query.cursor?.id); const result=page(query.cursor ? "second":"first",1,!query.cursor);
    result.value.records.push(result.value.records[0]); return result;
  });
  await feed.load(); assert.equal(feed.getSnapshot().records.length,1); await feed.next(); assert.equal(feed.getSnapshot().records[0].id,"second");
  assert.equal(feed.getSnapshot().page,2); await feed.back(); assert.equal(feed.getSnapshot().records[0].id,"first"); assert.deepEqual(cursors,[undefined,"first",undefined]);
});
test("storage invalidation during a barrier clears cache but defers IPC until producers resume", async () => {
  let calls=0;
  const feed=new NoteFeed(1,async(query)=>{calls++;return page(String(calls),query.epoch);});
  feed.setVisible(true);await tick();feed.pause();feed.switchEpoch(2);await tick();
  assert.equal(calls,1);assert.equal(feed.getSnapshot().records.length,0);
  feed.resume();await tick();assert.equal(calls,2);assert.equal(feed.getSnapshot().records[0].id,"2");
});
