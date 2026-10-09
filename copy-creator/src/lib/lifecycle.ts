import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SaveBarrier } from "./saveBarrier";
import { useSettingsEditorStore } from "../stores/settingsEditorStore";
import { publishStorageIdentity } from "./storageIdentity";

export const saveBarrier = new SaveBarrier();
saveBarrier.register("settings", {
  pause: () => useSettingsEditorStore.getState().pause(),
  flush: () => useSettingsEditorStore.getState().flushPaused(),
  resume: () => useSettingsEditorStore.getState().resume(),
});
export const lifecycleSessionId = crypto.randomUUID();
let starting: Promise<void> | null = null;
interface NativeSaveRequest { requestId: string; sessionId: string; purpose: "exit" | "restart" }
const delivered = new Set<string>();
const storageListeners = new Set<(epoch: number) => void>();
export function onStorageChanged(listener: (epoch: number) => void) {
  storageListeners.add(listener); return () => { storageListeners.delete(listener); };
}
export function notifyStorageChanged(epoch: number) {
  publishStorageIdentity(epoch);
  for (const listener of storageListeners) { try { listener(epoch); } catch (error) { saveBarrier.reportError(error); } }
}
let pendingRelease: string | null = null;
export async function releasePendingStorageOperation() {
  if (!pendingRelease) return;
  const token = pendingRelease;
  try {
    await invoke("end_storage_operation", { sessionId: lifecycleSessionId, operationToken: token });
    if (pendingRelease === token) pendingRelease = null;
  } catch (error) {
    // A stale token cannot unpause or terminate a newer native operation.
    if (error === "lifecycle.expired") { if (pendingRelease === token) pendingRelease = null; }
    else throw error;
  }
}
export function withStorageOperation<T>(kind: "export" | "import" | "storage", operation: (token: string) => Promise<T>) {
  return saveBarrier.run(kind, async () => {
    await startLifecycle();
    await releasePendingStorageOperation();
    const epoch = await invoke<number>("get_storage_epoch");
    // Keep the identity before IPC. Even a lost begin acknowledgement can be
    // cancelled without guessing which lease the backend may have accepted.
    const token = crypto.randomUUID();
    pendingRelease = token;
    try {
      await invoke("begin_storage_operation", {
        operationToken: token, sessionId: lifecycleSessionId, kind, expectedStorageEpoch: epoch,
      });
      return await operation(token);
    }
    finally {
      // The actual epoch is read before producers resume. Events are hints;
      // this acknowledgement also handles an event lost during webview work.
      try { notifyStorageChanged(await invoke<number>("get_storage_epoch")); }
      finally { await releasePendingStorageOperation(); }
    }
  });
}

/** App-wide registration deliberately survives page unmount and React's
 * StrictMode effect replay. A new webview gets a new session identity.
 */
export function startLifecycle() {
  if (starting) return starting;
  starting = (async () => {
    const stops: (() => void)[] = [];
    try {
      stops.push(await listen<NativeSaveRequest>("lifecycle-save-request", ({ payload }) => {
        if (payload.sessionId !== lifecycleSessionId || delivered.has(payload.requestId)) return;
        delivered.add(payload.requestId);
        void saveBarrier.run(payload.purpose, () => invoke<void>("lifecycle_saved", {
          requestId: payload.requestId, sessionId: lifecycleSessionId,
        }), { terminal: true }).catch(async () => {
          await invoke("lifecycle_cancel", { requestId: payload.requestId, sessionId: lifecycleSessionId }).catch(() => {});
        }).finally(() => { delivered.delete(payload.requestId); });
      }));
      stops.push(await listen<string>("lifecycle-error", ({ payload }) => saveBarrier.reportError(new Error(payload))));
      stops.push(await listen("lifecycle-hide", () => { void saveBarrier.hintFlush(); }));
      stops.push(await listen<{ storage_epoch: number }>("storage-changed", ({ payload }) => notifyStorageChanged(payload.storage_epoch)));
      await invoke("lifecycle_ready", { sessionId: lifecycleSessionId });
      document.addEventListener("visibilitychange", () => { if (document.hidden) void saveBarrier.hintFlush(); });
    } catch (error) {
      stops.forEach((stop) => stop()); starting = null;
      saveBarrier.reportError(error); throw error;
    }
  })();
  return starting;
}

export function lifecycleErrorKey(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return /^(lifecycle|settings|notes|updates)\.[A-Za-z]+$/.test(message) ? message : "lifecycle.failed";
}
