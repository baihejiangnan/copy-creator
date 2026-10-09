export interface SaveParticipant {
  pause(): void;
  flush(): Promise<void>;
  resume(): void;
}
export interface BarrierState {
  readonly busy: boolean;
  readonly purpose: string | null;
  readonly error: unknown;
}
interface BarrierTimer {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

/** Freeze first, confirm every save, then run the exclusive operation. The
 * deadline applies to saving only; a late save can never start an abandoned
 * operation. An accepted native operation keeps the barrier until it settles.
 */
export class SaveBarrier {
  private readonly participants = new Map<string, SaveParticipant>();
  private readonly listeners = new Set<() => void>();
  private state: BarrierState = Object.freeze({ busy: false, purpose: null, error: null });
  private readonly timer: BarrierTimer;
  constructor(timer: BarrierTimer = {
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  }) { this.timer = timer; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private publish(state: BarrierState) {
    this.state = Object.freeze(state);
    for (const listener of this.listeners) {
      try { listener(); } catch { console.error("Save barrier subscriber failed"); }
    }
  }
  register(id: string, participant: SaveParticipant) {
    if (this.state.busy || this.participants.has(id)) throw new Error("lifecycle.busy");
    this.participants.set(id, participant);
    return () => { if (this.participants.get(id) === participant) this.participants.delete(id); };
  }
  dismissError() { this.publish({ ...this.state, error: null }); }
  reportError(error: unknown) { this.publish({ ...this.state, error }); }
  async hintFlush() {
    if (this.state.busy) return;
    const results = await Promise.allSettled([...this.participants.values()].map((p) => Promise.resolve().then(() => p.flush())));
    const failure = results.find((r) => r.status === "rejected");
    if (failure?.status === "rejected") this.publish({ ...this.state, error: failure.reason });
  }
  async run<T>(purpose: string, operation: () => Promise<T>, options: { timeoutMs?: number; terminal?: boolean } = {}): Promise<T> {
    if (this.state.busy) throw new Error("lifecycle.busy");
    this.publish({ busy: true, purpose, error: null });
    const paused: SaveParticipant[] = [];
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let terminalSuccess = false;
    try {
      // Include a participant before calling pause, so a partial pause is also
      // resumed if that implementation throws.
      for (const participant of this.participants.values()) { paused.push(participant); participant.pause(); }
      await Promise.race([
        Promise.all(paused.map((p) => Promise.resolve().then(() => p.flush()))),
        new Promise<never>((_, reject) => {
          timeout = this.timer.setTimeout(() => reject(new Error("lifecycle.saveTimeout")), options.timeoutMs ?? 10000);
        }),
      ]);
      if (timeout !== undefined) this.timer.clearTimeout(timeout);
      const result = await operation();
      terminalSuccess = options.terminal === true;
      return result;
    } catch (error) {
      this.publish({ ...this.state, error }); throw error;
    } finally {
      if (timeout !== undefined) this.timer.clearTimeout(timeout);
      if (!terminalSuccess) {
        for (const participant of paused.reverse()) {
          try { participant.resume(); } catch { console.error("Save participant resume failed"); }
        }
        this.publish({ busy: false, purpose: null, error: this.state.error });
      }
    }
  }
}
