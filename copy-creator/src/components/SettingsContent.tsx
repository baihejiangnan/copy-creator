import { invokeStorage } from "../lib/storageIdentity";
import "../styles/settings.css";
import { useState, useEffect, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useSettingsStore } from "../stores/settingsStore";
import { useSettingsEditorStore } from "../stores/settingsEditorStore";
import type { SettingField } from "../stores/settingsEditorStore";
import { StorageSection, ClipboardSection, ImageSection, DataSection, LanguageSection,
  ShortcutSection, TranslationSection, StartupSection, RetentionSection } from "./settings";
import type { ClipboardStorageStats } from "./settings";
import { UpdateSection } from "./settings/UpdateSection";
import { useUpdateStore } from "../stores/updateStore";
import SettingsSaveStatus from "./SettingsSaveStatus";

const SETTINGS_TABS = ["general", "clipboard", "translation", "data", "updates"] as const;
type SettingsTab = typeof SETTINGS_TABS[number];

export default function SettingsContent({ embedded }: { embedded?: boolean }) {
  const { i18n, t } = useTranslation();
  const settings = useSettingsStore();
  const editor = useSettingsEditorStore();
  const values = editor.values;
  const [storageStats, setStorageStats] = useState<ClipboardStorageStats | null>(null);
  const [storagePath, setStoragePath] = useState("");
  const [recording, setRecording] = useState<"shortcut_key" | "note_shortcut_key" | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const categoryBodyRef = useRef<HTMLFieldSetElement>(null);
  const keydownHandlerRef = useRef<((event: KeyboardEvent) => void) | null>(null);

  const loadStorageStats = useCallback(async () => {
    try { setStorageStats(await invoke<ClipboardStorageStats>("get_clipboard_storage_stats")); }
    catch (error) { console.error("Failed to load storage stats:", error); }
  }, []);

  useEffect(() => {
    void useSettingsEditorStore.getState().initialize();
    void invoke<string>("get_storage_path").then(setStoragePath).catch(console.error);
    const onHidden = () => { if (document.hidden) void useSettingsEditorStore.getState().commitAll(); };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      if (keydownHandlerRef.current) document.removeEventListener("keydown", keydownHandlerRef.current, true);
      void useSettingsEditorStore.getState().commitAll();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    void invoke<ClipboardStorageStats>("get_clipboard_storage_stats")
      .then((stats) => { if (!disposed) setStorageStats(stats); }).catch(console.error);
    return () => { disposed = true; };
  }, [settings.maxHistoryItems, settings.maxStorageMb]);

  const stopRecording = () => {
    setRecording(null);
    if (keydownHandlerRef.current) document.removeEventListener("keydown", keydownHandlerRef.current, true);
    keydownHandlerRef.current = null;
  };
  const startRecording = (field: "shortcut_key" | "note_shortcut_key") => {
    stopRecording(); setRecording(field);
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); stopRecording(); return; }
      if (["Control", "Alt", "Shift", "Meta", "CapsLock", "NumLock", "ScrollLock", "Dead"].includes(event.key)
        || (!event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey)) return;
      event.preventDefault(); event.stopPropagation();
      const parts = [];
      if (event.ctrlKey) parts.push("Ctrl");
      if (event.altKey) parts.push("Alt");
      if (event.shiftKey) parts.push("Shift");
      if (event.metaKey) parts.push("Super");
      const key = event.code.startsWith("Key") ? event.code[3] : event.code.startsWith("Digit") ? event.code[5]
        : event.code.startsWith("Numpad") ? `NumPad${event.code.substring(6)}` : event.key === " " ? "Space" : event.key;
      parts.push(key); stopRecording();
      useSettingsEditorStore.getState().change(field, parts.join("+"));
    };
    keydownHandlerRef.current = handler;
    document.addEventListener("keydown", handler, true);
  };

  const change = (field: SettingField) => (value: string) => editor.change(field, value);
  const toggle = (field: SettingField) => (enabled: boolean) => editor.change(field, enabled ? "1" : "0");
  const commit = (field: SettingField) => { void editor.commit(field); };
  const handleImported = async () => {
    const previousShortcut = settings.shortcutKey;
    await settings.loadSettings();
    await useUpdateStore.getState().initialize(true);
    const imported = useSettingsStore.getState();
    if (previousShortcut !== imported.shortcutKey) await invoke("update_shortcut", {
      oldShortcut: previousShortcut, newShortcut: imported.shortcutKey,
    }).catch(console.error);
    await invokeStorage("save_note_shortcut", { newShortcut: imported.noteShortcutKey }).catch(console.error);
    await invokeStorage("set_radial_menu_enabled", { enabled: imported.radialMenuEnabled }).catch(console.error);
    if (imported.language !== i18n.language) {
      await i18n.changeLanguage(imported.language);
      void emit("language-changed", { language: imported.language }).catch(console.error);
      void invoke("update_tray_language").catch(console.error);
    }
    await editor.initialize(true);
    await loadStorageStats();
  };

  const categoryContent: Record<SettingsTab, ReactNode> = {
    general: <>
      <LanguageSection localLang={values.language} setLocalLang={change("language")} />
      <StartupSection localAutostart={values.autostart === "1"} setLocalAutostart={toggle("autostart")} />
      <ShortcutSection localShortcutKey={settings.shortcutKey} setLocalShortcutKey={change("shortcut_key")}
        error={editor.errors.shortcut_key}
        recording={recording} startRecording={startRecording} stopRecording={stopRecording}
        noteShortcutKey={settings.noteShortcutKey} noteError={editor.errors.note_shortcut_key} clearNoteShortcut={() => editor.change("note_shortcut_key", "")}
        localRadialMenuEnabled={values.radial_menu_enabled === "1"} setLocalRadialMenuEnabled={toggle("radial_menu_enabled")} />
    </>,
    clipboard: <>
      <RetentionSection retention={values.clipboard_retention} setRetention={change("clipboard_retention")} />
      <ClipboardSection dedupeWindowSeconds={Number(values.dedupe_window_seconds)}
        setDedupeWindowSeconds={(value) => editor.change("dedupe_window_seconds", String(value))}
        maxHistoryItems={values.max_history_items} setMaxHistoryItems={(value) => editor.edit("max_history_items", value)}
        maxStorageMb={values.max_storage_mb} setMaxStorageMb={(value) => editor.edit("max_storage_mb", value)}
        notifications={values.clipboard_notifications === "1"} setNotifications={toggle("clipboard_notifications")}
        stats={storageStats} onCleanup={loadStorageStats} onCommit={commit} errors={editor.errors} />
      <ImageSection maxDimension={Number(values.image_max_dimension)}
        setMaxDimension={(value) => editor.change("image_max_dimension", String(value))}
        compressionQuality={Number(values.image_compression_quality)}
        setCompressionQuality={(value) => editor.edit("image_compression_quality", String(value))}
        onCommitCompression={(value) => void editor.commit("image_compression_quality", String(value))}
        largeImageHandling={values.large_image_handling} setLargeImageHandling={change("large_image_handling")} />
    </>,
    translation: <TranslationSection localEngine={values.default_translate_engine} setLocalEngine={change("default_translate_engine")}
      localApiUrl={values.ai_api_url} setLocalApiUrl={(value) => editor.edit("ai_api_url", value)}
      localApiKey={values.ai_api_key} setLocalApiKey={(value) => editor.edit("ai_api_key", value)}
      apiKeyConfigured={settings.apiKeyConfigured} onClearApiKey={() => editor.clearSecret("ai_api_key")}
      localModel={values.ai_model} setLocalModel={(value) => editor.edit("ai_model", value)}
      localGoogleApiKey={values.google_api_key} setLocalGoogleApiKey={(value) => editor.edit("google_api_key", value)}
      googleApiKeyConfigured={settings.googleApiKeyConfigured} onClearGoogleApiKey={() => editor.clearSecret("google_api_key")}
      localTranslateProxy={values.translate_proxy} setLocalTranslateProxy={(value) => editor.edit("translate_proxy", value)}
      onCommit={commit} errors={editor.errors} />,
    data: <>
      <StorageSection storagePath={storagePath} setStoragePath={setStoragePath} />
      <DataSection onImported={handleImported} />
    </>,
    updates: <UpdateSection />,
  };
  const selectTab = (tab: SettingsTab) => {
    stopRecording(); void editor.commitAll(); setActiveTab(tab);
    if (categoryBodyRef.current) categoryBodyRef.current.scrollTop = 0;
  };

  return (
    <div className={`settings-categorized${embedded ? " settings-panel-content" : ""}`}>
      <div className="settings-tabs" role="tablist" aria-label={t("settings.title")}>
        {SETTINGS_TABS.map((tab, index) => (
          <button key={tab} id={`settings-tab-${tab}`} role="tab" aria-selected={activeTab === tab}
            aria-controls={`settings-panel-${tab}`} className={`settings-tab${activeTab === tab ? " active" : ""}`}
            tabIndex={activeTab === tab ? 0 : -1} onClick={() => selectTab(tab)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? SETTINGS_TABS[0] : event.key === "End" ? SETTINGS_TABS[SETTINGS_TABS.length - 1]
                : SETTINGS_TABS[(index + (event.key === "ArrowRight" ? 1 : -1) + SETTINGS_TABS.length) % SETTINGS_TABS.length];
              selectTab(next); document.getElementById(`settings-tab-${next}`)?.focus();
            }}>{t(`settings.categories.${tab}`)}</button>
        ))}
      </div>
      <SettingsSaveStatus />
      <fieldset className="settings-category-body" ref={categoryBodyRef} disabled={!editor.initialized || editor.paused}>
        {SETTINGS_TABS.map((tab) => (
          <div key={tab} id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`} hidden={activeTab !== tab}>
            {categoryContent[tab]}
          </div>
        ))}
      </fieldset>
    </div>
  );
}
