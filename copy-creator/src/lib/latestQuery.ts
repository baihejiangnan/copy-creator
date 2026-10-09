interface Job<T> { key: string; load: () => Promise<T>; resolve: (value: T | undefined) => void; reject: (error: unknown) => void; promise: Promise<T | undefined> }
/** One accepted read and one replaceable pending read. Superseded pending work
 * never reaches IPC; same-key callers share the same request.
 */
export class LatestQuery<T> {
  private active: Job<T> | null = null;
  private pending: Job<T> | null = null;
  run(key: string, load: () => Promise<T>): Promise<T | undefined> {
    if (this.active?.key === key) return this.active.promise;
    if (this.pending?.key === key) return this.pending.promise;
    let resolve!: Job<T>["resolve"], reject!: Job<T>["reject"];
    const promise = new Promise<T | undefined>((yes, no) => { resolve = yes; reject = no; });
    const job = { key, load, resolve, reject, promise };
    if (this.active) { this.pending?.resolve(undefined); this.pending = job; }
    else this.start(job);
    return promise;
  }
  private start(job: Job<T>) {
    this.active = job;
    void Promise.resolve().then(job.load).then(job.resolve, job.reject).finally(() => {
      this.active = null;
      const pending = this.pending; this.pending = null;
      if (pending) this.start(pending);
    });
  }
}
