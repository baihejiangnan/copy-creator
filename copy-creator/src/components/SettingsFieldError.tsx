import { useTranslation } from "react-i18next";

export default function SettingsFieldError({ field, error }: { field: string; error?: string }) {
  const { t } = useTranslation();
  return error ? <p id={`setting-error-${field}`} className="settings-field-error" role="alert">{t(error)}</p> : null;
}
