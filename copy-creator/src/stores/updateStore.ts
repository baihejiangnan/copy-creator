import { getStorageIdentity, invokeStorage, isCurrentStorageIdentity, onStorageIdentity } from "../lib/storageIdentity";
import { create } from "zustand";
import { Channel, invoke } from "@tauri-apps/api/core";
import { startLifecycle } from "../lib/lifecycle";

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
  mode: "installed" | "portable" | "nsis" | "unsupported";
  canDownload: boolean;
  downloadError: string | null;
  assetSize: number | null;
}

interface DownloadedUpdate { version: string; mode: string; path: string }
interface DownloadProgress { downloaded: number; total: number | null }

interface UpdateState {
  info: AppInfo | null;
  autoCheck: boolean;
  initialized: boolean;
  checking: boolean;
  saving: boolean;
  result: UpdateResult | null;
  error: string | null;
  errorDetail: string | null;
  checkedAt: number | null;
  downloading: boolean;
  launching: boolean;
  downloaded: DownloadedUpdate | null;
  progress: DownloadProgress | null;
  initialize: (reload?: boolean) => Promise<void>;
  start: () => Promise<void>;
  check: (automatic?: boolean) => Promise<void>;
  download: () => Promise<void>;
  launch: () => Promise<void>;
  setAutoCheck: (enabled: boolean) => Promise<void>;
  openLink: (url: string) => Promise<void>;
}

let initialization: Promise<void> | null = null;
let startup: Promise<void> | null = null;
let checking: Promise<void> | null = null;
let manualCheckRequested = false;
let settingsGeneration = 0;

function updateError(error: unknown, fallback: string) {
  const [candidate, detail] = typeof error === "string" ? error.split("|", 2) : [];
  // Only fixed translation keys and numeric HTTP status reach the UI. Native
  // errors never expose proxy URLs, credentials, or user filesystem errors.
  const known = /^updates\.(networkError|rateLimited|serverError|invalidRelease|timeout|metadataMissing|metadataTooLarge|busy|proxyError|platformUnsupported|installerUnsupported|packageMissing|signatureMissing|signatureInvalid|invalidAsset|packageTooLarge|sizeMismatch|fileError|fileExists|latestChanged|downloadRequired|launchError|cancelled)$/.test(candidate ?? "");
  return { error: known ? candidate : fallback, errorDetail: /^HTTP \d{3}$/.test(detail ?? "") ? detail : null };
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  info: null,
  autoCheck: true,
  initialized: false,
  checking: false,
  saving: false,
  result: null,
  error: null,
  errorDetail: null,
  checkedAt: null,
  downloading: false,
  launching: false,
  downloaded: null,
  progress: null,

  initialize: async (reload = false) => {
    if (get().initialized && !reload) return;
    if (initialization) return initialization;
    let generation = settingsGeneration;
    initialization = (async () => {
      try {
        const epoch = await getStorageIdentity();
        generation = settingsGeneration;
        const [info, settings] = await Promise.all([
          invoke<AppInfo>("get_app_info"),
          invoke<Record<string, string>>("get_all_settings"),
        ]);
        if (generation !== settingsGeneration || !isCurrentStorageIdentity(epoch)) return;
        set({ info, autoCheck: settings.auto_check_updates !== "0", initialized: true,
          ...(get().error === "updates.infoError" ? { error: null, errorDetail: null } : {}) });
      } catch {
        if (generation === settingsGeneration) set({ error: "updates.infoError", errorDetail: null });
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
      if (get().initialized && get().autoCheck) await get().check(true);
    })();
    return startup;
  },

  check: (automatic = false) => {
    if (checking) { if (!automatic) manualCheckRequested = true; return checking; }
    if (get().downloading || get().launching) return Promise.resolve();
    set({ checking: true, ...(!automatic ? { error: null, errorDetail: null } : {}) });
    manualCheckRequested = !automatic;
    checking = (async () => {
      try {
        await get().initialize();
        if (!get().initialized) return;
        let result = await invoke<UpdateResult | null>("check_for_updates", { automatic });
        // A manual action during an automatic cooldown still deserves a real
        // result. Share the one follow-up request with every waiting caller.
        if (!result && automatic && manualCheckRequested) result = await invoke<UpdateResult>("check_for_updates", { automatic: false });
        if (result) set({ result, checkedAt: Date.now(), error: null, errorDetail: null, downloaded: null, progress: null });
      } catch (error) {
        // A failed retry does not disprove a previously discovered update.
        // Keep its sidebar badge; download still rechecks native metadata.
        set(updateError(error, "updates.checkError"));
      } finally {
        set({ checking: false });
        checking = null;
        manualCheckRequested = false;
      }
    })();
    return checking;
  },

  download: async () => {
    const result = get().result;
    if (get().checking || get().downloading || get().launching || !result?.canDownload || !result.latestVersion) return;
    set({ downloading: true, error: null, errorDetail: null, progress: null, downloaded: null });
    try {
      const progress = new Channel<DownloadProgress>();
      progress.onmessage = (value) => { if (get().downloading) set({ progress: value }); };
      const downloaded = await invoke<DownloadedUpdate>("download_update", { expectedVersion: result.latestVersion, progress });
      set({ downloaded });
    } catch (error) {
      set(updateError(error, "updates.downloadError"));
    } finally {
      set({ downloading: false });
    }
  },

  launch: async () => {
    const downloaded = get().downloaded;
    if (!downloaded || get().checking || get().downloading || get().launching) return;
    set({ launching: true, error: null, errorDetail: null });
    try {
      await startLifecycle();
      await invoke("launch_update", { expectedVersion: downloaded.version });
    } catch (error) {
      set(updateError(error, "updates.launchError"));
    } finally {
      set({ launching: false });
    }
  },

  setAutoCheck: async (enabled) => {
    if (get().saving) return;
    set({ saving: true, error: null, errorDetail: null });
    const generation = settingsGeneration;
    try {
      await invokeStorage("set_setting", { key: "auto_check_updates", value: enabled ? "1" : "0" });
      if (generation === settingsGeneration) set({ autoCheck: enabled });
    } catch {
      if (generation === settingsGeneration) set({ error: "updates.saveError", errorDetail: null });
    } finally {
      set({ saving: false });
    }
  },

  openLink: async (url) => {
    try {
      await invoke("open_external_link", { url });
    } catch {
      set({ error: "updates.openError", errorDetail: null });
    }
  },
}));

onStorageIdentity(() => {
  settingsGeneration++;
  useUpdateStore.setState({ initialized: false });
  // Re-read only settings; storage switching never starts another auto check.
  void (initialization ?? Promise.resolve()).then(() => useUpdateStore.getState().initialize());
});
