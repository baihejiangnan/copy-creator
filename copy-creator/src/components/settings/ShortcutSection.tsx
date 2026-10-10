import { useTranslation } from "react-i18next";
import SettingsFieldError from "../SettingsFieldError";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface ShortcutSectionProps {
  error?: string;
  localShortcutKey: string;
  setLocalShortcutKey: (key: string) => void;
  recording: "shortcut_key" | "note_shortcut_key" | null;
  startRecording: (field: "shortcut_key" | "note_shortcut_key") => void;
  stopRecording: () => void;
  localRadialMenuEnabled: boolean;
  setLocalRadialMenuEnabled: (enabled: boolean) => void;
  noteShortcutKey: string;
  noteError?: string;
  clearNoteShortcut(): void;
}

export function ShortcutSection({
  localShortcutKey,
  recording,
  startRecording,
  stopRecording,
  localRadialMenuEnabled,
  setLocalRadialMenuEnabled,
  error,
  noteShortcutKey, noteError, clearNoteShortcut,
}: ShortcutSectionProps) {
  const { t } = useTranslation();
  const [actualNoteShortcut, setActualNoteShortcut] = useState<string | null>(null);
  useEffect(() => { let alive = true; void invoke<string>("note_shortcut_status").then(value => { if (alive) setActualNoteShortcut(value); }).catch(() => {}); return () => { alive = false; }; }, [noteShortcutKey, noteError]);

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.shortcut")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.windowShortcut")}</div>
          <div className="shortcut-setting">
            <div className="shortcut-keyboard-row">
              <span className={`shortcut-display${recording === "shortcut_key" ? " recording" : ""}`}>
                {recording === "shortcut_key" ? t("settings.recording") : (localShortcutKey || t("settings.shortcutPlaceholder"))}
              </span>
              <button
                className="shortcut-record-btn"
                onClick={recording === "shortcut_key" ? stopRecording : () => startRecording("shortcut_key")}
              >
                {recording === "shortcut_key" ? t("settings.stopRecord") : t("settings.recordShortcut")}
              </button>
            </div>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("suiji.newShortcut")}</div>
          <div className="shortcut-setting"><div className="shortcut-keyboard-row">
            <span className={`shortcut-display${recording === "note_shortcut_key" ? " recording" : ""}`}>{recording === "note_shortcut_key" ? t("settings.recording") : noteShortcutKey || t("settings.shortcutPlaceholder")}</span>
            <button className="shortcut-record-btn" onClick={recording === "note_shortcut_key" ? stopRecording : () => startRecording("note_shortcut_key")}>{recording === "note_shortcut_key" ? t("settings.stopRecord") : t("settings.recordShortcut")}</button>
            {noteShortcutKey && <button className="shortcut-record-btn" onClick={clearNoteShortcut}>{t("suiji.disableShortcut")}</button>}
          </div></div>
        </div>
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.radialShortcut")}</div>
          <div className="radial-shortcut-right">
            <span className="radial-shortcut-key">{t("settings.radialShortcutDesc")}</span>
            <button
              className={`toggle-switch ${localRadialMenuEnabled ? "on" : "off"}`}
              role="switch" aria-checked={localRadialMenuEnabled} aria-label={t("settings.radialShortcut")}
              onClick={() => setLocalRadialMenuEnabled(!localRadialMenuEnabled)}
              title={localRadialMenuEnabled ? t("common.on") : t("common.off")}
            >
              <span className="toggle-thumb" />
            </button>
          </div>
        </div>
      </div>
      <SettingsFieldError field="shortcut_key" error={error} />
      <SettingsFieldError field="note_shortcut_key" error={noteError} />
      {noteShortcutKey && actualNoteShortcut !== null && actualNoteShortcut !== noteShortcutKey && !noteError && <p className="notes-hint" role="status">{t("suiji.shortcutUnavailable")}</p>}
    </div>
  );
}
