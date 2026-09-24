import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";

type ThemeMode = "light" | "dark";

interface SettingsState {
  themeMode: ThemeMode;
  clipboardRetention: string;
  dedupeWindowSeconds: number;
  defaultEngine: string;
  apiUrl: string;
  apiKey: string;
  apiKeyConfigured: boolean;
  model: string;
  baiduAppId: string;
  baiduSecret: string;
  googleApiKey: string;
  googleApiKeyConfigured: boolean;
  translateProxy: string;
  language: string;
  shortcutKey: string;
  radialMenuEnabled: boolean;
  autostartEnabled: boolean;
  maxHistoryItems: number;
  maxStorageMb: number;
  imageMaxDimension: number;
  imageCompressionQuality: number;
  largeImageHandling: string;
  clipboardNotifications: boolean;

  toggleTheme: () => void;
  loadSettings: () => Promise<void>;
  setSetting: (key: string, value: string) => Promise<void>;
  setSettingsBatch: (settings: Record<string, string>) => Promise<void>;
  setAutostart: (enabled: boolean) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  themeMode: "light",
  clipboardRetention: "1month",
  dedupeWindowSeconds: 900,
  defaultEngine: "google",
  apiUrl: "",
  apiKey: "",
  apiKeyConfigured: false,
  model: "",
  baiduAppId: "",
  baiduSecret: "",
  googleApiKey: "",
  googleApiKeyConfigured: false,
  translateProxy: "",
  language: "zh-CN",
  shortcutKey: "",
  radialMenuEnabled: true,
  autostartEnabled: false,
  maxHistoryItems: 2000,
  maxStorageMb: 500,
  imageMaxDimension: 4096,
  imageCompressionQuality: 90,
  largeImageHandling: "compress",
  clipboardNotifications: false,

  toggleTheme: () => {
    const next = get().themeMode === "light" ? "dark" : "light";
    set({ themeMode: next });
    // Persist to DB so radial menu reads the correct theme on re-open
    get().setSetting("theme", next);
    emit("theme-changed", { theme: next });
  },

  loadSettings: async () => {
    try {
      const settings = await invoke<Record<string, string>>("get_all_settings");

      set({
        themeMode: settings.theme === "dark" ? "dark" : "light",
        clipboardRetention: settings.clipboard_retention || "1month",
        dedupeWindowSeconds: Number(settings.dedupe_window_seconds) || 900,
        defaultEngine: settings.default_translate_engine || "google",
        apiUrl: settings.ai_api_url || "",
        apiKey: "",
        apiKeyConfigured: settings.ai_api_key_configured === "true",
        model: settings.ai_model || "",
        baiduAppId: settings.baidu_appid || "",
        baiduSecret: settings.baidu_secret || "",
        googleApiKey: "",
        googleApiKeyConfigured: settings.google_api_key_configured === "true",
        translateProxy: settings.translate_proxy || "",
        language: settings.language || "zh-CN",
        shortcutKey: settings.shortcut_key || "",
        radialMenuEnabled: settings.radial_menu_enabled !== "0",
        maxHistoryItems: Number(settings.max_history_items) || 2000,
        maxStorageMb: Number(settings.max_storage_mb) || 500,
        imageMaxDimension: Number(settings.image_max_dimension) || 4096,
        imageCompressionQuality: Number(settings.image_compression_quality) || 90,
        largeImageHandling: settings.large_image_handling || "compress",
        clipboardNotifications: settings.clipboard_notifications === "1",
      });

      // Read autostart state from the OS (plugin)
      try {
        const auto = await isEnabled();
        set({ autostartEnabled: auto });
      } catch { /* plugin not available */ }
    } catch {
      // Settings not yet initialized, use defaults
    }
  },

  setSetting: async (key: string, value: string) => {
    try {
      await invoke("set_setting", { key, value });
    } catch (e) {
      console.error("Failed to save setting:", e);
    }
  },

  setSettingsBatch: async (settings: Record<string, string>) => {
    try {
      await invoke("set_settings_batch", { settings });
    } catch (e) {
      console.error("Failed to batch save settings:", e);
    }
  },

  setAutostart: async (enabled: boolean) => {
    try {
      if (enabled) {
        await enable();
      } else {
        await disable();
      }
      set({ autostartEnabled: enabled });
    } catch (e) {
      console.error("Failed to set autostart:", e);
    }
  },
}));
