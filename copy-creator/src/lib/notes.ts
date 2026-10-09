import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NoteCoordinator } from "./noteCoordinator";
import { onStorageChanged, saveBarrier } from "./lifecycle";
import { NoteFeed } from "./noteFeed";
import { LatestQuery } from "./latestQuery";
import type { Note, NoteMutation, NotePage, StorageResult } from "../types/note";

let coordinator: NoteCoordinator | null = null;
let initializing: Promise<NoteCoordinator> | null = null;
let feed: NoteFeed | null = null;
const details = new LatestQuery<StorageResult<Note>>();
const commitListeners = new Set<(note: Note) => void>();
export function onNoteCommitted(listener: (note: Note) => void) {
  commitListeners.add(listener); return () => { commitListeners.delete(listener); };
}
export function getNoteCoordinator(): Promise<NoteCoordinator> {
  if (coordinator) return Promise.resolve(coordinator);
  if (initializing) return initializing;
  initializing = (async () => {
    const epoch = await invoke<number>("get_storage_epoch");
    const next = new NoteCoordinator((request) => invoke<StorageResult<NoteMutation>>(
      request.expectedRevision === null ? "create_note" : "save_note", {
        expectedStorageEpoch: request.storageEpoch, id: request.id, mutationId: request.mutationId,
        ...(request.expectedRevision === null ? {} : { expectedRevision: request.expectedRevision }), draft: request.draft,
      }), epoch, undefined, undefined, (note) => {
        for (const listener of commitListeners) { try { listener(note); } catch { console.error("Note list refresh failed"); } }
      });
    saveBarrier.register("notes", {
      pause: () => { next.pause(); feed?.pause(); }, flush: () => next.flushAll(),
      resume: () => { next.resume(); feed?.resume(); },
    });
    onStorageChanged((epoch) => next.switchStorage(epoch));
    coordinator = next; return next;
  })().finally(() => { initializing = null; });
  return initializing;
}
export async function getNoteFeed() {
  const coordinator = await getNoteCoordinator();
  if (!feed) {
    feed = new NoteFeed(coordinator.storageEpoch, (query) => invoke<StorageResult<NotePage>>("list_notes", {
      expectedStorageEpoch: query.epoch, filter: query.filter, search: query.search, cursor: query.cursor, limit: 50,
    }));
    if (coordinator.paused) feed.pause();
    onStorageChanged((epoch) => feed?.switchEpoch(epoch));
    onNoteCommitted(() => feed?.invalidate());
    void listen<{ storage_epoch: number }>("notes-changed", ({ payload }) => {
      if (payload.storage_epoch === coordinator.storageEpoch) feed?.invalidate();
    }).catch(console.error);
    void listen<{ storage_epoch: number }>("notes-pruned", ({ payload }) => {
      if (payload.storage_epoch === coordinator.storageEpoch) feed?.invalidate();
    }).catch(console.error);
  }
  return feed;
}
export async function readNote(id: string) {
  const coordinator = await getNoteCoordinator();
  const cached = coordinator.getSession(id);
  if (cached) return cached;
  const epoch = coordinator.storageEpoch;
  const result = await details.run(`${epoch}:${id}`, () => invoke<StorageResult<Note>>("get_note", { expectedStorageEpoch: epoch, id }));
  if (!result) throw { code: "notes.superseded" };
  return coordinator.load(result.value, result.storage_epoch, false);
}

export function invalidateNoteStorage(epoch: number) { coordinator?.switchStorage(epoch); }
