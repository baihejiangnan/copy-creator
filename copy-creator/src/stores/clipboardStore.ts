import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { LatestQuery } from "../lib/latestQuery";
import { RequestPool, trimImageCache } from "../lib/requestPool";
import { invokeStorage, getStorageIdentity, onStorageIdentity, isCurrentStorageIdentity, type StorageEvent } from "../lib/storageIdentity";

type UnlistenFn = () => void;

export const CLIP_TYPES = ["all", "favorite", "text", "image", "link", "explorer", "file", "apikey"] as const;
export type ClipType = (typeof CLIP_TYPES)[number];

interface ApiKeyLabel {
  service: string;
  api_base: string;
  note: string;
  is_expired: boolean;
}

interface ClipboardRecord {
  id: string;
  type: "text" | "image" | "link" | "explorer" | "file";
  content: string;
  content_length?: number;
  content_truncated?: boolean;
  source_app: string;
  created_at: string;
  is_api_key?: boolean;
  user_api_key?: boolean;
  is_favorite: boolean;
  favorite_note: string;
  key_preview?: string;
  guessed_service?: string | null;
  label?: ApiKeyLabel | null;
}

const PAGE_SIZE = 120;

interface ClipboardState {
  records: ClipboardRecord[];
  search: string;
  loading: boolean;
  hasMore: boolean;
  thumbnailCache: Record<string, string>;
  imageCache: Record<string, string>;
  category: ClipType;
  initialized: boolean;

  init: () => void;
  setVisible: (visible: boolean) => void;
  invalidate: () => void;
  setSearch: (s: string) => void;
  setCategory: (c: ClipType) => void;
  loadRecords: (append?: boolean) => Promise<void>;
  updateRecordLabel: (id: string, label: ApiKeyLabel) => void;
  deleteRecord: (id: string) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  setFavoriteNote: (id: string, note: string) => Promise<string>;
  pasteRecord: (record: ClipboardRecord) => Promise<void>;
  getRecordContent: (record: ClipboardRecord) => Promise<string>;
  getThumbnail: (record: Pick<ClipboardRecord, "id" | "content">, signal?: AbortSignal) => Promise<string>;
  getImageData: (record: Pick<ClipboardRecord, "id" | "content">, signal?: AbortSignal) => Promise<string>;
}

let unlisten: UnlistenFn | null = null;

const MAX_THUMBNAILS = 80;
const MAX_FULL_IMAGES = 4;
const FULL_IMAGE_PREVIEW_MAX_SIZE = 1600;
const thumbnails = new RequestPool<string>(3, 80);
const previews = new RequestPool<string>(1, 8);
let imageGeneration = 0;
let queryGeneration = 0;
let visible = false;
let stale = true;
let loadingKey: string | null = null;
let loadedKey: string | null = null;
const queries = new LatestQuery<ClipboardRecord[]>();
let cursor: { created_at: string; id: string } | null = null;

async function getFullContent(record: ClipboardRecord): Promise<string> {
  const generation = imageGeneration;
  const epoch = await getStorageIdentity();
  if (generation !== imageGeneration) throw "notes.storageChanged";
  // API keys are intentionally represented by previews in list results.
  // Fetch the original only when the user explicitly copies or pastes one.
  if (!record.content_truncated && !record.is_api_key) return record.content;
  const content = await invoke<string>("get_clipboard_record_content", { id: record.id, expectedStorageEpoch: epoch });
  if (generation !== imageGeneration) throw "notes.storageChanged";
  return content;
}

export const useClipboardStore = create<ClipboardState>((set, get) => ({
  records: [],
  search: "",
  loading: false,
  hasMore: true,
  thumbnailCache: {},
  imageCache: {},
  category: "all",
  initialized: false,

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });

    listen<StorageEvent<ClipboardRecord>>("clipboard-update", ({ payload }) => { if (isCurrentStorageIdentity(payload?.storage_epoch)) get().invalidate(); }).then((fn) => { unlisten = fn; });

    listen<StorageEvent<string>>("clipboard-deleted", ({ payload }) => {
      if (!isCurrentStorageIdentity(payload?.storage_epoch)) return;
      const deletedId = payload.value;
      set((state) => ({ records: state.records.filter((r) => r.id !== deletedId) }));
      get().invalidate();
    });

    listen<StorageEvent<{ id: string; is_favorite: boolean }>>("clipboard-favorite-changed", (event) => {
      if (!isCurrentStorageIdentity(event.payload?.storage_epoch)) return;
      set((state) => ({
        records: state.records.map((record) =>
          record.id === event.payload.value.id
            ? { ...record, is_favorite: event.payload.value.is_favorite }
            : record,
        ),
      }));
      get().invalidate();
    });

    listen<StorageEvent<{ id: string; favorite_note: string }>>("clipboard-favorite-note-changed", (event) => {
      if (!isCurrentStorageIdentity(event.payload?.storage_epoch)) return;
      set((state) => ({
        records: state.records.map((record) =>
          record.id === event.payload.value.id
            ? { ...record, favorite_note: event.payload.value.favorite_note }
            : record,
        ),
      }));
      get().invalidate();
    });

    listen<StorageEvent<null>>("clipboard-refresh", ({ payload }) => { if (isCurrentStorageIdentity(payload?.storage_epoch)) get().invalidate(); });
    void getStorageIdentity().catch(console.error);
  },

  setVisible: (next) => { visible = next; if (next && stale) void get().loadRecords(); },
  invalidate: () => { stale = true; queryGeneration++; cursor = null; if (visible) void get().loadRecords(); },
  setSearch: (search) => {
    if (search === get().search) return;
    queryGeneration++; stale = true; cursor = null; set({ search, records: [], hasMore: true });
  },
  setCategory: (category) => {
    if (category === get().category) return;
    queryGeneration++; stale = true; cursor = null; set({ category, records: [], hasMore: true });
  },

  loadRecords: async (append = false) => {
    if (!visible) { stale = true; return; }
    const epoch = await getStorageIdentity().catch((error) => { console.error("Storage identity unavailable:", error); return null; });
    if (epoch === null) return;
    const generation = queryGeneration;
    const state = get();
    if (append && (!state.hasMore || state.loading || !cursor)) return;
    const nextCursor = append ? cursor : null;
    const key = JSON.stringify([epoch,generation,state.search,state.category,nextCursor]);
    if (!append && !stale && loadedKey === key) return;
    loadingKey = key; set({ loading: true });
    try {
      const records = await queries.run(key, () => invoke<ClipboardRecord[]>("get_clipboard_records", {
        search: state.search || undefined, category: state.category === "all" ? undefined : state.category,
        limit: PAGE_SIZE, cursor: nextCursor, expectedStorageEpoch: epoch,
      }));
      if (!records || generation !== queryGeneration) return;
      const last = records.at(-1); if (last) cursor = { created_at: last.created_at, id: last.id };
      loadedKey = key; stale = false;
      const combined = append ? [...get().records, ...records] : records;
      const seen = new Set<string>();
      set({ records: combined.filter((record) => !seen.has(record.id) && !!seen.add(record.id)), hasMore: records.length >= PAGE_SIZE });
    } catch (error) { if (generation === queryGeneration) { stale = true; console.error("Failed to load clipboard records:", error); } }
    finally { if (loadingKey === key) { loadingKey = null; set({ loading: false }); } }
  },

  updateRecordLabel: (id: string, label: ApiKeyLabel) =>
    set((state) => {
      const idx = state.records.findIndex((r) => r.id === id);
      if (idx === -1) return state;
      const updated = [...state.records];
      updated[idx] = { ...updated[idx], label };
      return { records: updated };
    }),

  deleteRecord: async (id: string) => {
    const generation = imageGeneration;
    try {
      await invokeStorage("delete_clipboard_record", { id });
      if (generation !== imageGeneration) return;
      const thumbCache = { ...get().thumbnailCache };
      delete thumbCache[id];
      const cache = { ...get().imageCache };
      delete cache[id];
      set({
        records: get().records.filter((r) => r.id !== id),
        thumbnailCache: thumbCache,
        imageCache: cache,
      });
    } catch (e) {
      console.error("Failed to delete record:", e);
    }
  },

  toggleFavorite: async (id: string) => {
    const generation = imageGeneration;
    try {
      const isFavorite = await invokeStorage<boolean>("toggle_clipboard_favorite", { id });
      if (generation !== imageGeneration) return;
      set((state) => ({
        records: state.records.map((record) =>
          record.id === id ? { ...record, is_favorite: isFavorite } : record,
        ),
      }));
    } catch (e) {
      console.error("Failed to update favorite:", e);
    }
  },

  setFavoriteNote: async (id: string, note: string) => {
    const generation = imageGeneration;
    const favoriteNote = await invokeStorage<string>("set_clipboard_favorite_note", { id, note });
    if (generation !== imageGeneration) throw "notes.storageChanged";
    set((state) => ({
      records: state.records.map((record) =>
        record.id === id ? { ...record, favorite_note: favoriteNote } : record,
      ),
    }));
    return favoriteNote;
  },

  pasteRecord: async (record: ClipboardRecord) => {
    const generation = imageGeneration;
    try {
      const epoch = await getStorageIdentity();
      if (generation !== imageGeneration) return;
      const content = await getFullContent(record);
      if (generation !== imageGeneration) return;
      if (record.type === "image") {
        await invokeStorage("paste_image", { path: content }, epoch);
      } else if (record.type === "file") {
        await invokeStorage("paste_file", { path: content }, epoch);
      } else {
        await invokeStorage("paste_text", { text: content }, epoch);
      }
    } catch (e) {
      console.error("Paste failed:", e);
    }
  },

  getRecordContent: getFullContent,

  getThumbnail: async (record: Pick<ClipboardRecord, "id" | "content">, signal?: AbortSignal): Promise<string> => {
    const cached = get().thumbnailCache[record.id];
    if (cached) return cached;

    const generation = imageGeneration;
    const epoch = await getStorageIdentity();
    if (signal?.aborted || generation !== imageGeneration) return "";
    try {
      const url = await thumbnails.request(`${epoch}:${record.id}:${record.content}`, async () => {
        // Use base64 data URI for reliable cross-platform display
        const base64 = await invoke<string>("get_image_thumbnail", {
          path: record.content,
          maxSize: 264,
          expectedStorageEpoch: epoch,
        });
        return `data:image/png;base64,${base64}`;
      }, signal);
      if (!url || signal?.aborted || generation !== imageGeneration) return "";
      set({ thumbnailCache: trimImageCache({ ...get().thumbnailCache, [record.id]: url }, MAX_THUMBNAILS, 12 * 1024 * 1024) });
      return url;
    } catch (e) { if (!signal?.aborted) console.error("Failed to load thumbnail:", e); return ""; }
  },

  getImageData: async (record: Pick<ClipboardRecord, "id" | "content">, signal?: AbortSignal): Promise<string> => {
    const cached = get().imageCache[record.id];
    if (cached) return cached;

    const generation = imageGeneration;
    const epoch = await getStorageIdentity();
    if (signal?.aborted || generation !== imageGeneration) return "";
    try {
      const url = await previews.request(`${epoch}:${record.id}:${record.content}`, async () => {
        const base64 = await invoke<string>("get_image_base64", {
        path: record.content,
        maxSize: FULL_IMAGE_PREVIEW_MAX_SIZE,
        expectedStorageEpoch: epoch,
        });
        return `data:image/png;base64,${base64}`;
      }, signal);
      if (!url || signal?.aborted || generation !== imageGeneration) return "";
      set({ imageCache: trimImageCache({ ...get().imageCache, [record.id]: url }, MAX_FULL_IMAGES, 24 * 1024 * 1024) });
      return url;
    } catch (e) {
      console.error("Failed to load image:", e);
      return "";
    }
  },
}));

onStorageIdentity(() => {
  imageGeneration++; queryGeneration++; stale = true; cursor = null; loadedKey = null;
  useClipboardStore.setState({ records: [], thumbnailCache: {}, imageCache: {}, hasMore: true });
  if (visible) void useClipboardStore.getState().loadRecords();
});

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    if (unlisten) unlisten();
  });
}
