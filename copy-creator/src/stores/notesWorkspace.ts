import { create } from "zustand";
import { getNoteCoordinator, getNoteFeed, readNote } from "../lib/notes";
import { noteFailure } from "../lib/noteCoordinator";
import { onStorageChanged } from "../lib/lifecycle";
import type { NoteCoordinator } from "../lib/noteCoordinator";
import type { NoteFeed } from "../lib/noteFeed";
import type { NoteFailure } from "../types/note";
interface NotesWorkspace {
  coordinator: NoteCoordinator | null; feed: NoteFeed | null; selectedId: string | null;
  opening: boolean; error: NoteFailure | null;
  quickId: string | null; focusTick: number;
  initialize(): Promise<void>; open(id: string, expectedEpoch?: number): Promise<void>; create(): void; back(): void;
  select(id: string): void; setError(error: unknown): void;
}
let initializing: Promise<void> | null = null;
let generation = 0;
export const useNotesWorkspace = create<NotesWorkspace>((set,get) => ({
  coordinator: null, feed: null, selectedId: null, opening: false, error: null, quickId: null, focusTick: 0,
  initialize: () => {
    if (get().coordinator && get().feed) return Promise.resolve();
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        const coordinator = await getNoteCoordinator(), feed = await getNoteFeed();
        let epoch = coordinator.storageEpoch;
        onStorageChanged((next) => {
          if (next !== epoch) { epoch = next; generation++; set({ selectedId: null, quickId: null, opening: false, error: null }); }
        });
        set({ coordinator, feed, error: null });
      } catch (error) { set({ error: noteFailure(error) }); }
    })().finally(() => { initializing = null; });
    return initializing;
  },
  open: async (id, expectedEpoch) => {
    const current = ++generation; set({ opening: true, error: null });
    try {
      if (expectedEpoch !== undefined && expectedEpoch !== get().coordinator?.storageEpoch) throw { code: "notes.storageChanged" };
      await readNote(id);
      if (current === generation) { get().coordinator?.setActive(id); set({ selectedId: id, opening: false }); }
    } catch (error) { if (current === generation) set({ error: noteFailure(error), opening: false }); }
  },
  create: () => {
    try { const existing = get().quickId; const id = existing && get().coordinator?.getSession(existing) ? existing : get().coordinator?.create(); if (id) { generation++; get().coordinator?.setActive(id); set({ selectedId: id, quickId: id, focusTick: get().focusTick + 1, error: null, opening: false }); } }
    catch (error) { set({ error: noteFailure(error) }); }
  },
  back: () => {
    const { coordinator, selectedId } = get();
    // Decide "is this draft safe to drop" only after the pending write settles:
    // flushing a dirty session can still fail (conflict, storage change), and
    // reading the status before that point would release the quick draft on a
    // write that never landed.
    const settle = selectedId ? coordinator?.flush(selectedId).catch(() => {}) ?? Promise.resolve() : Promise.resolve();
    void settle.then(() => {
      const current = get();
      if (current.coordinator !== coordinator || current.selectedId !== selectedId) return;
      if (selectedId && coordinator?.getSession(selectedId)?.status === "empty") void coordinator.discard(selectedId).catch(() => {});
      const session = selectedId ? coordinator?.getSession(selectedId) : null;
      const completed = !session || session.status === "saved" || session.status === "empty";
      generation++; coordinator?.setActive(null); set({ selectedId: null, opening: false, error: null, ...(get().quickId === selectedId && completed ? { quickId: null } : {}) });
    });
  },
  select: (id) => { generation++; get().coordinator?.setActive(id); set({ selectedId: id, opening: false, error: null }); },
  setError: (error) => set({ error: error === null ? null : noteFailure(error) }),
}));
