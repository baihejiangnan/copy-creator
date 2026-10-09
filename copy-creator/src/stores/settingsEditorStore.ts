import { getStorageIdentity, invokeStorage, isCurrentStorageIdentity } from "../lib/storageIdentity";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { isEnabled } from "@tauri-apps/plugin-autostart";
import { useSettingsStore } from "./settingsStore";
import i18n from "../i18n";

const FIELD_PROPS = {
  clipboard_retention: "clipboardRetention", dedupe_window_seconds: "dedupeWindowSeconds",
  default_translate_engine: "defaultEngine", ai_api_url: "apiUrl", ai_api_key: "apiKey",
  ai_model: "model", google_api_key: "googleApiKey", translate_proxy: "translateProxy",
  language: "language", shortcut_key: "shortcutKey", radial_menu_enabled: "radialMenuEnabled",
  autostart: "autostartEnabled", max_history_items: "maxHistoryItems", max_storage_mb: "maxStorageMb",
  image_max_dimension: "imageMaxDimension", image_compression_quality: "imageCompressionQuality",
  large_image_handling: "largeImageHandling", clipboard_notifications: "clipboardNotifications",
} as const;
export type SettingField = keyof typeof FIELD_PROPS;
type Values = Record<SettingField, string>;
const FIELDS = Object.keys(FIELD_PROPS) as SettingField[];
const SECRETS = new Set<SettingField>(["ai_api_key", "google_api_key"]);
const NUMBERS = new Set<SettingField>(["dedupe_window_seconds", "max_history_items", "max_storage_mb", "image_max_dimension", "image_compression_quality"]);
const BOOLEANS = new Set<SettingField>(["autostart", "radial_menu_enabled", "clipboard_notifications"]);

function snapshot(): Values {
  const settings = useSettingsStore.getState();
  return Object.fromEntries(FIELDS.map((key) => {
    const value = settings[FIELD_PROPS[key]];
    return [key, SECRETS.has(key) ? "" : typeof value === "boolean" ? value ? "1" : "0" : String(value)];
  })) as Values;
}

function updateEffective(field: SettingField, value: string) {
  if (SECRETS.has(field)) {
    useSettingsStore.setState(field === "ai_api_key" ? { apiKeyConfigured: value !== "" } : { googleApiKeyConfigured: value !== "" });
  } else {
    useSettingsStore.setState({ [FIELD_PROPS[field]]: BOOLEANS.has(field) ? value === "1" : NUMBERS.has(field) ? Number(value) : value });
  }
}

function validate(field: SettingField, value: string): string | null {
  if (value.length > 4096) return "settings.inputTooLong";
  if (["ai_api_url", "translate_proxy"].includes(field) && value) {
    const protocols = field === "translate_proxy" ? ["http:", "https:", "socks5:", "socks5h:"] : ["http:", "https:"];
    const error = field === "translate_proxy" ? "settings.invalidProxy" : "settings.invalidUrl";
    try { const url = new URL(value); if (!url.hostname || !protocols.includes(url.protocol)) return error; }
    catch { return error; }
  }
  const bounds: Partial<Record<SettingField, [number, number]>> = {
    max_history_items: [100, 100000], max_storage_mb: [50, 100000], image_compression_quality: [40, 100],
  };
  const range = bounds[field];
  if (range && (!/^\d+$/.test(value) || Number(value) < range[0] || Number(value) > range[1])) return field === "max_history_items"
    ? "settings.invalidHistoryLimit" : field === "max_storage_mb" ? "settings.invalidStorageLimit" : "settings.invalidNumber";
  return null;
}

export interface LimitConfirmation { field: SettingField; value: string; revision: number; count: number }
interface EditorState {
  values: Values;
  savedValues: Values;
  initialized: boolean;
  loadError: boolean;
  paused: boolean;
  pending: number;
  hasSaved: boolean;
  errors: Partial<Record<SettingField, string>>;
  limitConfirmation: LimitConfirmation | null;
  initialize: (reload?: boolean) => Promise<void>;
  edit: (field: SettingField, value: string) => void;
  commit: (field: SettingField, value?: string, confirmedCount?: number, force?: boolean, fromBarrier?: boolean) => Promise<void>;
  clearSecret: (field: "ai_api_key" | "google_api_key") => void;
  change: (field: SettingField, value: string) => void;
  commitAll: (fromBarrier?: boolean) => Promise<void>;
  retry: () => void;
  cancelLimit: () => void;
  confirmLimit: () => void;
  prepareImport: () => Promise<void>;
  pause: () => void;
  flushPaused: () => Promise<void>;
  resume: () => void;
}

let queue: Promise<void> = Promise.resolve();
let initialization: Promise<void> | null = null;
const revisions: Partial<Record<SettingField, number>> = {};
const submitted = new Map<SettingField, number>();
const clearRequests = new Set<SettingField>();

export const useSettingsEditorStore = create<EditorState>((set, get) => ({
  values: snapshot(), savedValues: snapshot(), initialized: false, loadError: false,
  paused: false, pending: 0, hasSaved: false, errors: {}, limitConfirmation: null,

  initialize: async (reload = false) => {
    if (get().initialized && !reload) return;
    if (initialization) return initialization;
    set({ initialized: false, loadError: false });
    initialization = (async () => {
      let storageEpoch: number | undefined;
      try {
        storageEpoch = await getStorageIdentity();
        const raw = await invokeStorage<Record<string, string>>("get_all_settings", {}, storageEpoch);
        const values = snapshot();
        for (const field of FIELDS) {
          if (!SECRETS.has(field) && field !== "autostart" && raw[field] !== undefined) values[field] = raw[field];
        }
        try { values.autostart = await isEnabled() ? "1" : "0"; } catch { /* The switch reports OS errors when changed. */ }
        if (!isCurrentStorageIdentity(storageEpoch)) return;
        for (const field of FIELDS) updateEffective(field, values[field]);
        useSettingsStore.setState({ apiKeyConfigured: raw.ai_api_key_configured === "true", googleApiKeyConfigured: raw.google_api_key_configured === "true" });
        clearRequests.clear();
        set({ values, savedValues: { ...values }, initialized: true, loadError: false, errors: {}, limitConfirmation: null });
      } catch { if (storageEpoch === undefined || isCurrentStorageIdentity(storageEpoch)) set({ loadError: true }); }
      finally { initialization = null; }
    })();
    return initialization;
  },

  edit: (field, value) => {
    if (get().paused || !get().initialized) return;
    if (get().values[field] === value) return;
    revisions[field] = (revisions[field] ?? 0) + 1;
    if (value !== "") clearRequests.delete(field);
    set((state) => {
      const errors = { ...state.errors }; delete errors[field];
      return { values: { ...state.values, [field]: value }, errors,
        limitConfirmation: state.limitConfirmation?.field === field ? null : state.limitConfirmation };
    });
  },

  commit: async (field, rawValue = get().values[field], confirmedCount, force = false, fromBarrier = false) => {
    if (!get().initialized || (get().paused && !fromBarrier)) return;
    const value = SECRETS.has(field) || ["ai_api_url", "translate_proxy", "ai_model"].includes(field) ? rawValue.trim() : rawValue;
    if (value !== get().values[field]) get().edit(field, value);
    if (SECRETS.has(field) && !value && !force && !clearRequests.has(field)) return;
    if (value === get().savedValues[field] && !force && !clearRequests.has(field) && !submitted.has(field)) return;
    const invalid = validate(field, value);
    if (invalid) { set((state) => ({ errors: { ...state.errors, [field]: invalid } })); return; }
    const revision = revisions[field] ?? 0;
    if (submitted.get(field) === revision) return;
    submitted.set(field, revision);
    set((state) => ({ pending: state.pending + 1 }));
    const task = queue.then(async () => {
      if ((revisions[field] ?? 0) !== revision) return;
      if (value === get().savedValues[field] && !force && !clearRequests.has(field)) return;
      try {
        if (field === "max_history_items" || field === "max_storage_mb") {
          if (get().limitConfirmation && get().limitConfirmation?.field !== field) return;
          const result = await invokeStorage<{ saved: boolean; cleanup_count: number }>("save_clipboard_limit", { key: field, value, confirmedCount: confirmedCount ?? null });
          if (!result.saved) {
            if ((revisions[field] ?? 0) === revision) set({ limitConfirmation: { field, value, revision, count: result.cleanup_count } });
            return;
          }
        } else if (field === "shortcut_key") {
          await invokeStorage("save_shortcut", { newShortcut: value });
        } else if (field === "radial_menu_enabled") {
          await invokeStorage("set_radial_menu_enabled", { enabled: value === "1" });
        } else if (field === "autostart") {
          await useSettingsStore.getState().setAutostart(value === "1");
        } else {
          await useSettingsStore.getState().setSetting(field, value);
        }
        updateEffective(field, value);
        if ((revisions[field] ?? 0) === revision) clearRequests.delete(field);
        if (field === "language") {
          await i18n.changeLanguage(value);
          // Saving is complete even if an auxiliary tray/window notification fails.
          void emit("language-changed", { language: value }).catch(console.error);
          void invoke("update_tray_language").catch(console.error);
        }
        set((state) => {
          const errors = { ...state.errors };
          if ((revisions[field] ?? 0) === revision) delete errors[field];
          return { savedValues: { ...state.savedValues, [field]: SECRETS.has(field) ? "" : value },
            values: SECRETS.has(field) && (revisions[field] ?? 0) === revision ? { ...state.values, [field]: "" } : state.values,
            errors, hasSaved: true, limitConfirmation: state.limitConfirmation?.field === field ? null : state.limitConfirmation };
        });
      } catch (error) {
        if ((revisions[field] ?? 0) === revision) set((state) => ({ errors: { ...state.errors,
          [field]: error === "settings.shortcutUnavailable" ? "settings.shortcutUnavailable" : "settings.autoSaveFailed" } }));
      }
    }).finally(() => {
      if (submitted.get(field) === revision) submitted.delete(field);
      set((state) => ({ pending: state.pending - 1 }));
    });
    queue = task.catch(() => {});
    await task;
  },

  change: (field, value) => { get().edit(field, value); void get().commit(field, value); },
  clearSecret: (field) => {
    get().edit(field, "");
    clearRequests.add(field);
    revisions[field] = (revisions[field] ?? 0) + 1;
    void get().commit(field, "", undefined, true);
  },
  commitAll: async (fromBarrier = false) => {
    await Promise.all(FIELDS.filter((field) => !get().errors[field] && get().limitConfirmation?.field !== field)
      .map((field) => get().commit(field, undefined, undefined, false, fromBarrier)));
    await queue;
  },
  retry: () => {
    if (get().loadError) { void get().initialize(true); return; }
    for (const field of Object.keys(get().errors) as SettingField[]) void get().commit(field);
  },
  cancelLimit: () => {
    const proposal = get().limitConfirmation;
    if (!proposal) return;
    get().edit(proposal.field, get().savedValues[proposal.field]);
    set({ limitConfirmation: null });
    void get().commitAll();
  },
  confirmLimit: () => {
    const proposal = get().limitConfirmation;
    if (!proposal || (revisions[proposal.field] ?? 0) !== proposal.revision) return;
    void get().commit(proposal.field, proposal.value, proposal.count).then(() => {
      if (!get().limitConfirmation) void get().commitAll();
    });
  },
  prepareImport: async () => {
    set({ paused: true });
    await get().flushPaused();
  },
  pause: () => set({ paused: true }),
  flushPaused: async () => {
    await get().commitAll(true);
    if (get().loadError || Object.keys(get().errors).length || get().limitConfirmation) throw new Error("settings.pendingSaveError");
  },
  resume: () => set({ paused: false }),
}));
