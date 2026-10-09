import { invokeStorage } from "../lib/storageIdentity";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface AppInfo {
  name: string;
  version: string;
  author: string;
  license: string;
  repositoryUrl: string;
  upstreamUrl: string;
  releasesUrl: string;
}

interface UpdateResult {
  status: "available" | "upToDate" | "noRelease";
  latestVersion: string | null;
  releaseUrl: string | null;
  notes: string | null;
}

interface UpdateState {
  info: AppInfo | null;
  autoCheck: boolean;
  initialized: boolean;
  checking: boolean;
  saving: boolean;
  result: UpdateResult | null;
  error: string | null;
  checkedAt: number | null;
  initialize: (reload?: boolean) => Promise<void>;
  start: () => Promise<void>;
  check: () => Promise<void>;
  setAutoCheck: (enabled: boolean) => Promise<void>;
  openLink: (url: string) => Promise<void>;
}

let initialization: Promise<void> | null = null;
let startup: Promise<void> | null = null;

export const useUpdateStore = create<UpdateState>((set, get) => ({
  info: null,
  autoCheck: true,
  initialized: false,
  checking: false,
  saving: false,
  result: null,
  error: null,
  checkedAt: null,

  initialize: async (reload = false) => {
    if (get().initialized && !reload) return;
    if (initialization) return initialization;
    initialization = (async () => {
      try {
        const [info, settings] = await Promise.all([
          invoke<AppInfo>("get_app_info"),
          invoke<Record<string, string>>("get_all_settings"),
        ]);
        set({ info, autoCheck: settings.auto_check_updates !== "0", initialized: true, error: null });
      } catch {
        set({ error: "updates.infoError" });
      } finally {
        initialization = null;
      }
    })();
    return initialization;
  },

  // Share startup work across React StrictMode mounts; check once per app session.
  start: async () => {
    if (startup) return startup;
    startup = (async () => {
      await get().initialize();
      if (get().initialized && get().autoCheck) await get().check();
    })();
    return startup;
  },

  check: async () => {
    if (get().checking) return;
    set({ checking: true, error: null });
    try {
      await get().initialize();
      if (!get().initialized) return;
      const result = await invoke<UpdateResult>("check_for_updates");
      set({ result, checkedAt: Date.now() });
    } catch (error) {
      const key = typeof error === "string" && [
        "updates.networkError", "updates.rateLimited", "updates.serverError", "updates.invalidRelease",
      ].includes(error) ? error : "updates.checkError";
      set({ error: key, result: null });
    } finally {
      set({ checking: false });
    }
  },

  setAutoCheck: async (enabled) => {
    if (get().saving) return;
    set({ saving: true, error: null });
    try {
      await invokeStorage("set_setting", { key: "auto_check_updates", value: enabled ? "1" : "0" });
      set({ autoCheck: enabled });
    } catch {
      set({ error: "updates.saveError" });
    } finally {
      set({ saving: false });
    }
  },

  openLink: async (url) => {
    try {
      await invoke("open_external_link", { url });
    } catch {
      set({ error: "updates.openError" });
    }
  },
}));
