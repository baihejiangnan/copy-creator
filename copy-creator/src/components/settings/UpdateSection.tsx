import { useTranslation } from "react-i18next";
import { useUpdateStore } from "../../stores/updateStore";
import UpdateCheck from "../UpdateCheck";

export function UpdateSection() {
  const { t } = useTranslation();
  const { info, autoCheck, saving, initialized, setAutoCheck } = useUpdateStore();
  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("updates.title")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <span className="settings-row-label">{t("updates.currentVersion")}</span>
          <span className="update-version">{info ? `v${info.version}` : t("common.loading")}</span>
        </div>
        <div className="settings-row vertical"><UpdateCheck /></div>
        <div className="settings-row">
          <label className="settings-row-label" htmlFor="auto-check-updates">{t("updates.autoCheck")}</label>
          <button id="auto-check-updates" className={`toggle-switch ${autoCheck ? "on" : "off"}`}
            role="switch" aria-checked={autoCheck} disabled={saving || !initialized}
            onClick={() => void setAutoCheck(!autoCheck)}>
            <span className="toggle-thumb" />
          </button>
        </div>
      </div>
      <p className="update-setting-hint">{t("updates.autoCheckHint")}</p>
    </div>
  );
}
