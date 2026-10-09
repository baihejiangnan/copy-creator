import { useTranslation } from "react-i18next";
import IosSelect from "../IosSelect";

interface RetentionSectionProps {
  retention: string;
  setRetention: (retention: string) => void;
}

export function RetentionSection({ retention, setRetention }: RetentionSectionProps) {
  const { t } = useTranslation();
  const options = [
    { value: "1week", label: t("settings.retention1week") },
    { value: "1month", label: t("settings.retention1month") },
    { value: "3months", label: t("settings.retention3months") },
  ];

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.fileRetention")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.fileRetention")}</div>
          <IosSelect value={retention} options={options} onChange={setRetention} />
        </div>
      </div>
    </div>
  );
}
