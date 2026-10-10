import { invoke } from "@tauri-apps/api/core";
import { getNoteCoordinator, getNoteFeed, readNote } from "./notes";
import { saveBarrier } from "./lifecycle";
import { invokeStorage } from "./storageIdentity";
import { noteFailure } from "./noteCoordinator";
import type { Note, NoteMutation, StorageResult } from "../types/note";
export interface RecordGroup { id: string; name: string; color: string; sort_order: number; count: number }
const pending = new Map<string, { epoch: number; revision: number; mutationId: string; groupId: string | null; starred: boolean }>();

export async function pasteNote(id: string, expectedEpoch?: number) {
  const coordinator = await getNoteCoordinator();
  const epoch = expectedEpoch ?? coordinator.storageEpoch;
  if (epoch !== coordinator.storageEpoch) throw { code: "notes.storageChanged" };
  await readNote(id);
  await coordinator.flush(id);
  const session = coordinator.getSession(id);
  if (!session) throw { code: "notes.notFound" };
  if (epoch !== coordinator.storageEpoch || session.storageEpoch !== epoch) throw { code: "notes.storageChanged" };
  if (!session.draft.body && session.draft.refs.length === 1 && session.draft.refs[0].kind === "file") {
    await invokeStorage("paste_file", { path: session.draft.refs[0].target }, epoch);
  } else {
    const text = session.draft.body || session.draft.refs.map(ref => ref.target).join("\n");
    if (text) await invokeStorage("paste_text", { text }, epoch);
  }
}

export async function organizeNote(id: string, patch: { groupId?: string | null; starred?: boolean }, expectedEpoch?: number) {
  const coordinator = await getNoteCoordinator();
  const capturedEpoch = expectedEpoch ?? coordinator.storageEpoch;
  if (capturedEpoch !== coordinator.storageEpoch) throw { code: "notes.storageChanged" };
  await readNote(id);
  await saveBarrier.run("noteState", async () => {
    if (capturedEpoch !== coordinator.storageEpoch) throw { code: "notes.storageChanged" };
    const activeId = coordinator.activeNoteId;
    const epoch = coordinator.storageEpoch;
    let request = pending.get(id);
    if (request?.epoch !== epoch) { pending.delete(id); request = undefined; }
    if (!request) {
      if (pending.size >= 32) throw { code: "notes.busy" };
      const fresh = await invoke<StorageResult<Note>>("get_note", { expectedStorageEpoch: epoch, id });
      if (fresh.storage_epoch !== coordinator.storageEpoch) throw { code: "notes.storageChanged" };
      request = { epoch, revision: fresh.value.revision, mutationId: crypto.randomUUID(),
        groupId: patch.groupId === undefined ? fresh.value.group_id ?? null : patch.groupId,
        starred: patch.starred ?? fresh.value.starred ?? false };
      pending.set(id, request);
    } else if ((patch.groupId !== undefined && patch.groupId !== request.groupId) || (patch.starred !== undefined && patch.starred !== request.starred)) {
      throw { code: "notes.retryState" };
    }
    const result = await invoke<StorageResult<NoteMutation>>("organize_note", {
      expectedStorageEpoch: epoch, id, expectedRevision: request.revision, mutationId: request.mutationId,
      groupId: request.groupId, starred: request.starred,
    }).catch(error => {
      const failure = noteFailure(error);
      if (["notes.conflict", "notes.deleted", "notes.notFound", "notes.groupMissing"].includes(failure.code)) pending.delete(id);
      if (failure.code === "notes.conflict") coordinator.markConflict(id, failure);
      throw error;
    });
    if (result.storage_epoch !== coordinator.storageEpoch) throw { code: "notes.storageChanged" };
    if (result.value.mutation_id !== request.mutationId || result.value.note.id !== id) throw { code: "notes.mutationMismatch" };
    pending.delete(id); await coordinator.discard(id);
    // `discard` clears the active pointer only when this record held it. Re-point the
    // editor at it exactly in that case: writing the captured id back unconditionally
    // would clobber a record the user selected while this request was in flight, and
    // `evictClean` would then be free to drop the session they are actually editing.
    if (activeId === id && coordinator.activeNoteId === null) coordinator.setActive(id);
    coordinator.load(result.value.note, epoch, false);
    (await getNoteFeed()).invalidate();
  });
}
