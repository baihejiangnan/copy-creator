import { useTranslation } from "react-i18next";
import SettingsFieldError from "../SettingsFieldError";

interface ShortcutSectionProps {
  error?: string;
  localShortcutKey: string;
  setLocalShortcutKey: (key: string) => void;
  recording: boolean;
  startRecording: () => void;
  stopRecording: () => void;
  localRadialMenuEnabled: boolean;
  setLocalRadialMenuEnabled: (enabled: boolean) => void;
}

export function ShortcutSection({
  localShortcutKey,
  recording,
  startRecording,
  stopRecording,
  localRadialMenuEnabled,
  setLocalRadialMenuEnabled,
  error,
}: ShortcutSectionProps) {
  const { t } = useTranslation();

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.shortcut")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.windowShortcut")}</div>
          <div className="shortcut-setting">
            <div className="shortcut-keyboard-row">
              <span className={`shortcut-display${recording ? " recording" : ""}`}>
                {recording ? t("settings.recording") : (localShortcutKey || t("settings.shortcutPlaceholder"))}
              </span>
              <button
                className="shortcut-record-btn"
                onClick={recording ? stopRecording : startRecording}
              >
                {recording ? t("settings.stopRecord") : t("settings.recordShortcut")}
              </button>
            </div>
          </div>
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
    </div>
  );
}
