import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { invokeStorage, onStorageIdentity, isCurrentStorageIdentity, type StorageEvent } from "../lib/storageIdentity";
import { LatestQuery } from "../lib/latestQuery";

interface PhraseGroup {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface Phrase {
  id: string;
  group_id: string;
  title: string;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface PhraseState {
  groups: PhraseGroup[];
  phrases: Phrase[];
  selectedGroupId: string | null;
  search: string;
  loading: boolean;

  setSearch: (s: string) => void;
  setSelectedGroup: (id: string | null) => void;
  init: () => void;
  loadGroups: () => Promise<void>;
  loadPhrases: (groupId: string) => Promise<void>;
  createGroup: (name: string) => Promise<void>;
  updateGroup: (id: string, name: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  createPhrase: (
    groupId: string,
    title: string,
    content: string
  ) => Promise<void>;
  updatePhrase: (
    id: string,
    title: string,
    content: string
  ) => Promise<void>;
  deletePhrase: (id: string) => Promise<void>;
  pastePhrase: (phrase: Phrase) => Promise<void>;
}

export const usePhraseStore = create<PhraseState>()((set, get) => {
  let initialized = false;
  let generation = 0, detailGeneration = 0;
  const groupQueries = new LatestQuery<PhraseGroup[]>(), phraseQueries = new LatestQuery<Phrase[]>();
  onStorageIdentity(() => {
    generation++; detailGeneration++;
    set({ groups: [], phrases: [], selectedGroupId: null, loading: false });
    if (initialized) void get().loadGroups();
  });

  return {
  groups: [],
  phrases: [],
  selectedGroupId: null,
  search: "",
  loading: false,

  setSearch: (s: string) => set({ search: s }),
  setSelectedGroup: (id: string | null) => set({ selectedGroupId: id }),

  loadGroups: async () => {
    const current = generation;
    try {
      const groups = await groupQueries.run(String(current), () => invoke<PhraseGroup[]>("get_phrase_groups"));
      if (!groups || current !== generation) return;
      set({ groups });
      if (groups.length > 0 && !get().selectedGroupId) {
        get().loadPhrases(groups[0].id);
      }
    } catch (e) {
      console.error("Failed to load phrase groups:", e);
    }
  },

  init: () => {
    if (initialized) return;
    initialized = true;

    listen<StorageEvent<null>>("phrase-groups-changed", ({ payload }) => {
      if (isCurrentStorageIdentity(payload?.storage_epoch)) void get().loadGroups();
    });

    get().loadGroups();
  },

  loadPhrases: async (groupId: string) => {
    const current = generation, detail = ++detailGeneration;
    set({ loading: true });
    try {
      const phrases = await phraseQueries.run(`${current}:${groupId}`, () => invoke<Phrase[]>("get_phrases", { groupId }));
      if (!phrases || current !== generation || detail !== detailGeneration) return;
      set({ phrases, selectedGroupId: groupId });
    } catch (e) {
      console.error("Failed to load phrases:", e);
    } finally {
      if (current === generation && detail === detailGeneration) set({ loading: false });
    }
  },

  createGroup: async (name: string) => {
    const current = generation;
    try {
      const group = await invokeStorage<PhraseGroup>("create_phrase_group", { name });
      if (current !== generation) return;
      set({ groups: [...get().groups.filter((existing) => existing.id !== group.id), group] });
    } catch (e) {
      console.error("Failed to create group:", e);
    }
  },

  updateGroup: async (id: string, name: string) => {
    const current = generation;
    try {
      await invokeStorage("update_phrase_group", { id, name });
      if (current !== generation) return;
      set({
        groups: get().groups.map((g) => (g.id === id ? { ...g, name } : g)),
      });
    } catch (e) {
      console.error("Failed to update group:", e);
    }
  },

  deleteGroup: async (id: string) => {
    const current = generation;
    try {
      await invokeStorage("delete_phrase_group", { id });
      if (current !== generation) return;
      set({
        groups: get().groups.filter((g) => g.id !== id),
        phrases:
          get().selectedGroupId === id ? [] : get().phrases,
        selectedGroupId:
          get().selectedGroupId === id ? null : get().selectedGroupId,
      });
    } catch (e) {
      console.error("Failed to delete group:", e);
    }
  },

  createPhrase: async (groupId: string, title: string, content: string) => {
    const current = generation;
    try {
      const phrase = await invokeStorage<Phrase>("create_phrase", {
        groupId,
        title,
        content,
      });
      if (current !== generation || get().selectedGroupId !== groupId) return;
      set({ phrases: [...get().phrases.filter((existing) => existing.id !== phrase.id), phrase] });
    } catch (e) {
      console.error("Failed to create phrase:", e);
    }
  },

  updatePhrase: async (id: string, title: string, content: string) => {
    const current = generation;
    try {
      await invokeStorage("update_phrase", { id, title, content });
      if (current !== generation) return;
      set({
        phrases: get().phrases.map((p) =>
          p.id === id ? { ...p, title, content } : p
        ),
      });
    } catch (e) {
      console.error("Failed to update phrase:", e);
    }
  },

  deletePhrase: async (id: string) => {
    const current = generation;
    try {
      await invokeStorage("delete_phrase", { id });
      if (current !== generation) return;
      set({ phrases: get().phrases.filter((p) => p.id !== id) });
    } catch (e) {
      console.error("Failed to delete phrase:", e);
    }
  },

  pastePhrase: async (phrase: Phrase) => {
    try {
      await invokeStorage("paste_text", { text: phrase.content });
    } catch (e) {
      console.error("Paste failed:", e);
    }
  },
  };
});
