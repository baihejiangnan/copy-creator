import { invoke } from "@tauri-apps/api/core";
import { getNoteCoordinator, getNoteFeed } from "./notes";
import { saveBarrier } from "./lifecycle";
import { noteFailure } from "./noteCoordinator";
import type { NoteAction, NoteMutation, StorageResult } from "../types/note";
// Keep uncertain requests outside page/card lifetimes. A retry must reuse its
// original identity; only a successful acknowledgement starts a new intention.
const captures = new Map<string, { epoch: number; mutationId: string }>();
const states = new Map<string, { epoch: number; revision: number; mutationId: string; action: NoteAction }>();
export async function captureNote(recordId: string) {
  const coordinator = await getNoteCoordinator();
  let request = captures.get(recordId);
  if (request && request.epoch !== coordinator.storageEpoch) { captures.delete(recordId); request = undefined; }
  if (!request) {
    if (captures.size >= 32) throw { code: "notes.busy" };
    request = { epoch: coordinator.storageEpoch, mutationId: crypto.randomUUID() }; captures.set(recordId, request);
  }
  const result = await invoke<StorageResult<NoteMutation>>("capture_clipboard_as_note", {
    expectedStorageEpoch: request.epoch, recordId, mutationId: request.mutationId,
  });
  if (result.storage_epoch !== coordinator.storageEpoch) throw { code: "notes.storageChanged" };
  if (result.value.mutation_id !== request.mutationId) throw { code: "notes.mutationMismatch" };
  captures.delete(recordId); (await getNoteFeed()).invalidate();
  return result.value.note.id;
}
export async function changeNoteState(id: string, action: NoteAction, expectedEpoch?: number) {
  const coordinator = await getNoteCoordinator();
  const epoch = expectedEpoch ?? coordinator.storageEpoch;
  await saveBarrier.run("noteState", async () => {
    if (coordinator.storageEpoch !== epoch) throw { code: "notes.storageChanged" };
    const session = coordinator.getSession(id);
    if (!session || session.revision === null) throw { code: "notes.notFound" };
    let request = states.get(id);
    if (request && request.epoch !== coordinator.storageEpoch) { states.delete(id); request = undefined; }
    if (request && request.action !== action) throw { code: "notes.retryState" };
    if (!request) {
      if (states.size >= 32) throw { code: "notes.busy" };
      request = { epoch: coordinator.storageEpoch, revision: session.revision, mutationId: crypto.randomUUID(), action }; states.set(id, request);
    }
    const result = await invoke<StorageResult<NoteMutation>>("set_note_state", {
      expectedStorageEpoch: request.epoch, id, expectedRevision: request.revision,
      mutationId: request.mutationId, action: request.action,
    }).catch((error: unknown) => {
      const failure = noteFailure(error);
      if (["notes.conflict", "notes.deleted", "notes.notFound", "notes.invalidState"].includes(failure.code)) states.delete(id);
      if (["notes.conflict", "notes.deleted", "notes.notFound"].includes(failure.code)) coordinator.markConflict(id, failure);
      throw error;
    });
    if (result.storage_epoch !== coordinator.storageEpoch) throw { code: "notes.storageChanged" };
    if (result.value.mutation_id !== request.mutationId || result.value.note.id !== id) throw { code: "notes.mutationMismatch" };
    states.delete(id); await coordinator.discard(id);
    coordinator.load(result.value.note, result.storage_epoch); (await getNoteFeed()).invalidate();
  });
}
