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
  initialize(): Promise<void>; open(id: string): Promise<void>; create(): void; back(): void;
  select(id: string): void; setError(error: unknown): void;
}
let initializing: Promise<void> | null = null;
let generation = 0;
export const useNotesWorkspace = create<NotesWorkspace>((set,get) => ({
  coordinator: null, feed: null, selectedId: null, opening: false, error: null,
  initialize: () => {
    if (get().coordinator && get().feed) return Promise.resolve();
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        const coordinator = await getNoteCoordinator(), feed = await getNoteFeed();
        let epoch = coordinator.storageEpoch;
        onStorageChanged((next) => {
          if (next !== epoch) { epoch = next; generation++; set({ selectedId: null, opening: false, error: null }); }
        });
        set({ coordinator, feed, error: null });
      } catch (error) { set({ error: noteFailure(error) }); }
    })().finally(() => { initializing = null; });
    return initializing;
  },
  open: async (id) => {
    const current = ++generation; set({ opening: true, error: null });
    try {
      await readNote(id);
      if (current === generation) { get().coordinator?.setActive(id); set({ selectedId: id, opening: false }); }
    } catch (error) { if (current === generation) set({ error: noteFailure(error), opening: false }); }
  },
  create: () => {
    try { const id = get().coordinator?.create(); if (id) { generation++; set({ selectedId: id, error: null, opening: false }); } }
    catch (error) { set({ error: noteFailure(error) }); }
  },
  back: () => {
    const { coordinator, selectedId } = get();
    if (coordinator && selectedId) void coordinator.flush(selectedId).catch(() => {});
    generation++; coordinator?.setActive(null); set({ selectedId: null, opening: false, error: null });
  },
  select: (id) => { generation++; get().coordinator?.setActive(id); set({ selectedId: id, opening: false, error: null }); },
  setError: (error) => set({ error: error === null ? null : noteFailure(error) }),
}));
