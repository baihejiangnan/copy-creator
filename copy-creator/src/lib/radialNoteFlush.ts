export interface RadialFlushRequest { requestId: string; id: string; storageEpoch: number }
export interface RadialFlushReply { requestId: string; storageEpoch: number; error: string | null }
interface FlushTransport {
  listen(reply: (value: RadialFlushReply) => void): Promise<() => void>;
  send(request: RadialFlushRequest): Promise<void>;
}
/** Request-scoped listener; a late or foreign acknowledgment can never authorize paste. */
export async function requestRadialFlush(request: RadialFlushRequest, transport: FlushTransport, timeoutMs = 11000) {
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let resolve!: () => void, reject!: (error: unknown) => void;
  const reply = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  try {
    timer = setTimeout(() => reject("lifecycle.saveTimeout"), timeoutMs);
    const registration = transport.listen(value => {
      if (value.requestId !== request.requestId || value.storageEpoch !== request.storageEpoch) return;
      if (value.error) reject(value.error); else resolve();
    }).then(unlisten => {
      if (disposed) unlisten(); else stop = unlisten;
    });
    await Promise.race([registration, reply]);
    // Observe rejection while a failed/slow send is still pending.
    const delivery = transport.send(request);
    await Promise.all([reply, delivery]);
  } finally { disposed = true; if (timer !== undefined) clearTimeout(timer); stop?.(); }
}
export async function answerRadialFlush(request: RadialFlushRequest, epoch: () => Promise<number>, flush: () => Promise<void>): Promise<RadialFlushReply> {
  try {
    if (await epoch() !== request.storageEpoch) throw "notes.storageChanged";
    await flush();
    if (await epoch() !== request.storageEpoch) throw "notes.storageChanged";
    return { requestId: request.requestId, storageEpoch: request.storageEpoch, error: null };
  } catch (error) {
    const code = typeof error === "string" ? error : error && typeof error === "object" && "code" in error ? error.code : error instanceof Error ? error.message : null;
    return { requestId: request.requestId, storageEpoch: request.storageEpoch,
      error: typeof code === "string" && /^(notes|lifecycle|settings)\.[A-Za-z]+$/.test(code) ? code : "notes.saveFailed" };
  }
}
