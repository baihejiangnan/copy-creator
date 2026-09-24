import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useSettingsStore } from "../stores/settingsStore";
import {
  StorageSection,
  ClipboardSection,
  ImageSection,
  DataSection,
  LanguageSection,
  ShortcutSection,
  TranslationSection,
  StartupSection,
} from "./settings";
import type { ClipboardStorageStats } from "./settings";

interface Props {
  embedded?: boolean;
}

export default function SettingsContent({ embedded }: Props) {
  const { i18n, t } = useTranslation();
  const settings = useSettingsStore();

  const [localRetention, setLocalRetention] = useState(settings.clipboardRetention);
  const [localDedupeWindow, setLocalDedupeWindow] = useState(settings.dedupeWindowSeconds);
  const [localEngine, setLocalEngine] = useState(settings.defaultEngine);
  const [localApiUrl, setLocalApiUrl] = useState(settings.apiUrl);
  const [localApiKey, setLocalApiKey] = useState(settings.apiKey);
  const [localModel, setLocalModel] = useState(settings.model);
  const [localGoogleApiKey, setLocalGoogleApiKey] = useState(settings.googleApiKey);
  const [localTranslateProxy, setLocalTranslateProxy] = useState(settings.translateProxy);
  const [localLang, setLocalLang] = useState(i18n.language);
  const [localShortcutKey, setLocalShortcutKey] = useState(settings.shortcutKey);
  const [localRadialMenuEnabled, setLocalRadialMenuEnabled] = useState(settings.radialMenuEnabled);
  const [localAutostart, setLocalAutostart] = useState(settings.autostartEnabled);
  const [localMaxHistoryItems, setLocalMaxHistoryItems] = useState(settings.maxHistoryItems);
  const [localMaxStorageMb, setLocalMaxStorageMb] = useState(settings.maxStorageMb);
  const [localImageMaxDimension, setLocalImageMaxDimension] = useState(settings.imageMaxDimension);
  const [localImageCompressionQuality, setLocalImageCompressionQuality] = useState(settings.imageCompressionQuality);
  const [localLargeImageHandling, setLocalLargeImageHandling] = useState(settings.largeImageHandling);
  const [localClipboardNotifications, setLocalClipboardNotifications] = useState(settings.clipboardNotifications);
  const [storageStats, setStorageStats] = useState<ClipboardStorageStats | null>(null);
  const [recording, setRecording] = useState(false);
  const recordingRef = useRef(false);
  const keydownHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const [storagePath, setStoragePath] = useState("");
  const [saved, setSaved] = useState(false);

  const loadStorageStats = useCallback(async () => {
    try {
      setStorageStats(await invoke<ClipboardStorageStats>("get_clipboard_storage_stats"));
    } catch (e) {
      console.error("Failed to load clipboard storage stats:", e);
    }
  }, []);

  useEffect(() => {
    settings.loadSettings();
    invoke<string>("get_storage_path").then(setStoragePath).catch(console.error);
    invoke<ClipboardStorageStats>("get_clipboard_storage_stats")
      .then(setStorageStats)
      .catch(console.error);
  }, []);

  useEffect(() => {
    setLocalRetention(settings.clipboardRetention);
    setLocalDedupeWindow(settings.dedupeWindowSeconds);
    setLocalEngine(settings.defaultEngine);
    setLocalApiUrl(settings.apiUrl);
    setLocalApiKey(settings.apiKey);
    setLocalModel(settings.model);
    setLocalGoogleApiKey(settings.googleApiKey);
    setLocalTranslateProxy(settings.translateProxy);
    setLocalLang(i18n.language);
    setLocalShortcutKey(settings.shortcutKey);
    setLocalRadialMenuEnabled(settings.radialMenuEnabled);
    setLocalAutostart(settings.autostartEnabled);
    setLocalMaxHistoryItems(settings.maxHistoryItems);
    setLocalMaxStorageMb(settings.maxStorageMb);
    setLocalImageMaxDimension(settings.imageMaxDimension);
    setLocalImageCompressionQuality(settings.imageCompressionQuality);
    setLocalLargeImageHandling(settings.largeImageHandling);
    setLocalClipboardNotifications(settings.clipboardNotifications);
  }, [settings, i18n.language]);

  const startRecording = () => {
    recordingRef.current = true;
    setRecording(true);
    setLocalShortcutKey("");

    const cleanup = () => {
      document.removeEventListener("keydown", handler, true);
      keydownHandlerRef.current = null;
    };

    const handler = (e: KeyboardEvent) => {
      if (!recordingRef.current) {
        cleanup();
        return;
      }

      // Ignore modifier-only presses
      if (["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock", "ScrollLock", "Dead"].includes(e.key)) {
        return;
      }

      // Require at least one modifier
      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Ctrl");
      if (e.altKey) parts.push("Alt");
      if (e.shiftKey) parts.push("Shift");
      if (e.metaKey) parts.push("Super");

      // Map physical key code to layout-independent name
      const code = e.code;
      let keyName: string;
      if (code.startsWith("Key")) {
        keyName = code[3]; // KeyA → A
      } else if (code.startsWith("Digit")) {
        keyName = code[5]; // Digit1 → 1
      } else if (code.startsWith("Numpad")) {
        keyName = "NumPad" + code.substring(6);
      } else {
        keyName = e.key;
        if (keyName === " ") keyName = "Space";
      }
      parts.push(keyName);

      const shortcut = parts.join("+");
      setLocalShortcutKey(shortcut);
      recordingRef.current = false;
      setRecording(false);
      cleanup();
    };

    keydownHandlerRef.current = handler;
    document.addEventListener("keydown", handler, true);
  };

  const stopRecording = () => {
    recordingRef.current = false;
    setRecording(false);
    if (keydownHandlerRef.current) {
      document.removeEventListener("keydown", keydownHandlerRef.current, true);
      keydownHandlerRef.current = null;
    }
  };

  const handleSave = async () => {
    const maxHistoryItems = Math.min(100000, Math.max(100, Math.round(localMaxHistoryItems || 2000)));
    const maxStorageMb = Math.min(100000, Math.max(50, Math.round(localMaxStorageMb || 500)));
    setLocalMaxHistoryItems(maxHistoryItems);
    setLocalMaxStorageMb(maxStorageMb);

    await settings.setSettingsBatch({
      clipboard_retention: localRetention,
      dedupe_window_seconds: String(localDedupeWindow),
      default_translate_engine: localEngine,
      ai_api_url: localApiUrl,
      ai_model: localModel,
      translate_proxy: localTranslateProxy,
      language: localLang,
      max_history_items: String(maxHistoryItems),
      max_storage_mb: String(maxStorageMb),
      image_max_dimension: String(localImageMaxDimension),
      image_compression_quality: String(localImageCompressionQuality),
      large_image_handling: localLargeImageHandling,
      clipboard_notifications: localClipboardNotifications ? "1" : "0",
    });

    if (localApiKey) await settings.setSetting("ai_api_key", localApiKey);
    if (localGoogleApiKey) await settings.setSetting("google_api_key", localGoogleApiKey);
    setLocalApiKey("");
    setLocalGoogleApiKey("");

    const oldKey = settings.shortcutKey;
    const newKey = localShortcutKey;
    if (oldKey !== newKey) {
      try {
        await invoke("update_shortcut", { oldShortcut: oldKey, newShortcut: newKey });
        await settings.setSetting("shortcut_key", newKey);
      } catch (e) {
        console.error("Failed to update shortcut:", e);
      }
    }

    try {
      await invoke("set_radial_menu_enabled", { enabled: localRadialMenuEnabled });
    } catch (e) {
      console.error("Failed to set radial menu enabled:", e);
    }

    await settings.setAutostart(localAutostart);
    await loadStorageStats();

    if (localLang !== i18n.language) {
      i18n.changeLanguage(localLang);
      emit("language-changed", { language: localLang });
      invoke("update_tray_language").catch(console.error);
    }

    await settings.loadSettings();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleImported = async () => {
    const previousShortcut = settings.shortcutKey;
    await settings.loadSettings();
    const imported = useSettingsStore.getState();
    if (previousShortcut !== imported.shortcutKey) {
      await invoke("update_shortcut", {
        oldShortcut: previousShortcut,
        newShortcut: imported.shortcutKey,
      }).catch(console.error);
    }
    await invoke("set_radial_menu_enabled", {
      enabled: imported.radialMenuEnabled,
    }).catch(console.error);
    if (imported.language !== i18n.language) {
      await i18n.changeLanguage(imported.language);
      emit("language-changed", { language: imported.language });
      invoke("update_tray_language").catch(console.error);
    }
    await loadStorageStats();
  };

  const content = (
    <>
      <StorageSection
        storagePath={storagePath}
        setStoragePath={setStoragePath}
        localRetention={localRetention}
        setLocalRetention={setLocalRetention}
      />

      <ClipboardSection
        dedupeWindowSeconds={localDedupeWindow}
        setDedupeWindowSeconds={setLocalDedupeWindow}
        maxHistoryItems={localMaxHistoryItems}
        setMaxHistoryItems={setLocalMaxHistoryItems}
        maxStorageMb={localMaxStorageMb}
        setMaxStorageMb={setLocalMaxStorageMb}
        notifications={localClipboardNotifications}
        setNotifications={setLocalClipboardNotifications}
        stats={storageStats}
        onCleanup={loadStorageStats}
      />

      <ImageSection
        maxDimension={localImageMaxDimension}
        setMaxDimension={setLocalImageMaxDimension}
        compressionQuality={localImageCompressionQuality}
        setCompressionQuality={setLocalImageCompressionQuality}
        largeImageHandling={localLargeImageHandling}
        setLargeImageHandling={setLocalLargeImageHandling}
      />

      <LanguageSection
        localLang={localLang}
        setLocalLang={setLocalLang}
      />

      <ShortcutSection
        localShortcutKey={localShortcutKey}
        setLocalShortcutKey={setLocalShortcutKey}
        recording={recording}
        startRecording={startRecording}
        stopRecording={stopRecording}
        localRadialMenuEnabled={localRadialMenuEnabled}
        setLocalRadialMenuEnabled={setLocalRadialMenuEnabled}
      />

      <StartupSection
        localAutostart={localAutostart}
        setLocalAutostart={setLocalAutostart}
      />

      <DataSection onImported={handleImported} />

      <TranslationSection
        localEngine={localEngine}
        setLocalEngine={setLocalEngine}
        localApiUrl={localApiUrl}
        setLocalApiUrl={setLocalApiUrl}
        localApiKey={localApiKey}
        apiKeyConfigured={settings.apiKeyConfigured}
        onClearApiKey={() => { invoke("set_setting", { key: "ai_api_key", value: "" }).then(() => { setLocalApiKey(""); settings.loadSettings(); }).catch(console.error); }}
        setLocalApiKey={setLocalApiKey}
        localModel={localModel}
        setLocalModel={setLocalModel}
        localGoogleApiKey={localGoogleApiKey}
        googleApiKeyConfigured={settings.googleApiKeyConfigured}
        onClearGoogleApiKey={() => { invoke("set_setting", { key: "google_api_key", value: "" }).then(() => { setLocalGoogleApiKey(""); settings.loadSettings(); }).catch(console.error); }}
        setLocalGoogleApiKey={setLocalGoogleApiKey}
        localTranslateProxy={localTranslateProxy}
        setLocalTranslateProxy={setLocalTranslateProxy}
      />

      <div className="settings-actions">
        <button className={`settings-save-btn${saved ? " saved" : ""}`} onClick={handleSave}>
          {saved ? t("common.saved") : t("common.save")}
        </button>
      </div>
    </>
  );

  if (embedded) {
    return <div className="settings-panel-content">{content}</div>;
  }

  return content;
}
