import "../styles/settings-status.css";
import { useTranslation } from "react-i18next";
import { useSettingsEditorStore } from "../stores/settingsEditorStore";
import type { SettingField } from "../stores/settingsEditorStore";

export default function SettingsSaveStatus() {
  const { t } = useTranslation();
  const state = useSettingsEditorStore();
  const errors = Object.values(state.errors);
  const dirty = (Object.keys(state.values) as SettingField[]).some((key) => state.values[key] !== state.savedValues[key]);
  const key = state.loadError ? "settings.settingsLoadFailed" : !state.initialized ? "common.loading"
    : state.paused ? "settings.restoringSettings" : state.pending ? "settings.autoSaving"
    : errors.length ? errors[0]! : state.limitConfirmation ? "settings.awaitingLimitConfirmation"
    : dirty ? "settings.finishInput" : state.hasSaved ? "settings.autoSaved" : "settings.autoSaveHint";
  return (
    <div className={`settings-save-status${errors.length || state.loadError ? " error" : ""}`}>
      <span role="status" aria-live="polite">{t(key)}</span>
      {(errors.length > 0 || state.loadError) && <button type="button" className="project-link"
        disabled={state.pending > 0 || state.paused} onClick={state.retry}>{t("settings.retrySave")}</button>}
    </div>
  );
}
