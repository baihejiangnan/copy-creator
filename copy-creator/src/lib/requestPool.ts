interface Consumer<T> { resolve(value: T | undefined): void; reject(error: unknown): void; dispose(): void }
interface Task<T> { key: string; run(): Promise<T>; consumers: Set<Consumer<T>>; started: boolean }
/** Bounded, coalesced work. A cancelled last consumer removes queued work;
 * native work already accepted may finish, but no cancelled consumer receives it.
 */
export class RequestPool<T> {
  private active = 0;
  private readonly tasks = new Map<string, Task<T>>();
  private readonly queue: Task<T>[] = [];
  private readonly concurrency: number;
  private readonly maxQueued: number;
  constructor(concurrency: number, maxQueued: number) { this.concurrency = concurrency; this.maxQueued = maxQueued; }
  get pending() { return this.queue.length; }
  get running() { return this.active; }
  request(key: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    let task = this.tasks.get(key);
    if (!task) {
      if (this.active >= this.concurrency && this.queue.length >= this.maxQueued) return Promise.resolve(undefined);
      task = { key, run, consumers: new Set(), started: false }; this.tasks.set(key, task); this.queue.push(task);
    }
    const accepted = task;
    const promise = new Promise<T | undefined>((resolve, reject) => {
      const cancel = () => {
        accepted.consumers.delete(consumer); consumer.dispose(); resolve(undefined);
        if (!accepted.started && !accepted.consumers.size) {
          const index = this.queue.indexOf(accepted); if (index >= 0) this.queue.splice(index, 1);
          if (this.tasks.get(key) === accepted) this.tasks.delete(key);
        }
      };
      const consumer: Consumer<T> = { resolve, reject, dispose: () => signal?.removeEventListener("abort", cancel) };
      accepted.consumers.add(consumer); signal?.addEventListener("abort", cancel, { once: true });
    });
    this.drain(); return promise;
  }
  private drain() {
    while (this.active < this.concurrency && this.queue.length) {
      const task = this.queue.shift()!; task.started = true; this.active++;
      void Promise.resolve().then(() => task.run()).then((value) => {
        for (const consumer of task.consumers) { consumer.dispose(); consumer.resolve(value); }
      }, (error: unknown) => {
        for (const consumer of task.consumers) { consumer.dispose(); consumer.reject(error); }
      }).finally(() => {
        task.consumers.clear(); this.active--; if (this.tasks.get(task.key) === task) this.tasks.delete(task.key); this.drain();
      });
    }
  }
}

export function trimImageCache(cache: Record<string, string>, entries: number, bytes: number) {
  // Data URLs are ASCII; reserve two bytes per code unit for JS string storage.
  let used = 0; const retained: [string, string][] = [];
  for (const entry of Object.entries(cache).reverse()) {
    const cost = entry[1].length * 2;
    if (retained.length >= entries || used + cost > bytes) continue;
    retained.push(entry); used += cost;
  }
  return Object.fromEntries(retained.reverse());
}
