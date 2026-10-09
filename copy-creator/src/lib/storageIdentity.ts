import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
let epoch: number | null = null;
let starting: Promise<number> | null = null;
const listeners = new Set<(epoch: number) => void>();
export interface StorageEvent<T> { storage_epoch: number; value: T }
export function isCurrentStorageIdentity(expected: number): boolean {
  return epoch !== null && epoch === expected;
}
export function publishStorageIdentity(next: number) {
  if (epoch === next) return;
  epoch = next;
  for (const listener of listeners) { try { listener(next); } catch { console.error("Storage cache invalidation failed"); } }
}
export function onStorageIdentity(listener: (epoch: number) => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export function getStorageIdentity(): Promise<number> {
  if (epoch !== null) return Promise.resolve(epoch);
  if (starting) return starting;
  starting = (async () => {
    await listen<{ storage_epoch: number }>("storage-changed", ({ payload }) => publishStorageIdentity(payload.storage_epoch));
    const actual = await invoke<number>("get_storage_epoch");
    if (epoch === null) publishStorageIdentity(actual);
    return epoch!;
  })().finally(() => { starting = null; });
  return starting;
}

/** Stamp before native delivery and reject acknowledgments from a former store. */
export async function invokeStorage<T>(command: string, args: Record<string, unknown> = {}, capturedEpoch?: number): Promise<T> {
  const expectedStorageEpoch = capturedEpoch ?? await getStorageIdentity();
  if (!isCurrentStorageIdentity(expectedStorageEpoch)) throw "notes.storageChanged";
  const result = await invoke<T>(command, { ...args, expectedStorageEpoch });
  if (!isCurrentStorageIdentity(expectedStorageEpoch)) throw "notes.storageChanged";
  return result;
}
