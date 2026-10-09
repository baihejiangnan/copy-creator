import { useTranslation } from "react-i18next";
import IosSelect from "../IosSelect";
import type { SettingField } from "../../stores/settingsEditorStore";
import SettingsFieldError from "../SettingsFieldError";

interface TranslationSectionProps {
  onCommit: (field: SettingField) => void;
  errors: Partial<Record<SettingField, string>>;
  localEngine: string;
  setLocalEngine: (engine: string) => void;
  localApiUrl: string;
  setLocalApiUrl: (url: string) => void;
  localApiKey: string;
  apiKeyConfigured: boolean;
  onClearApiKey: () => void;
  setLocalApiKey: (key: string) => void;
  localModel: string;
  setLocalModel: (model: string) => void;
  localGoogleApiKey: string;
  googleApiKeyConfigured: boolean;
  onClearGoogleApiKey: () => void;
  setLocalGoogleApiKey: (key: string) => void;
  localTranslateProxy: string;
  setLocalTranslateProxy: (proxy: string) => void;
}

export function TranslationSection({
  localEngine,
  setLocalEngine,
  localApiUrl,
  setLocalApiUrl,
  localApiKey,
  apiKeyConfigured,
  onClearApiKey,
  setLocalApiKey,
  localModel,
  setLocalModel,
  localGoogleApiKey,
  googleApiKeyConfigured,
  onClearGoogleApiKey,
  setLocalGoogleApiKey,
  localTranslateProxy,
  setLocalTranslateProxy,
  onCommit,
  errors,
}: TranslationSectionProps) {
  const { t } = useTranslation();

  const engineOptions = [
    { value: "google", label: t("settings.googleTranslation") },
    { value: "ai", label: t("settings.aiTranslation") },
  ];

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.translation")}</div>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-label">{t("settings.defaultEngine")}</div>
          <IosSelect
            value={localEngine}
            options={engineOptions}
            onChange={setLocalEngine}
          />
        </div>
        {localEngine === "google" && (
          <>
            <div className="settings-row vertical">
              <div className="settings-row-label">{t("settings.googleApiKey")}</div>
              <input
                className="settings-input"
                type="password"
                value={localGoogleApiKey}
                onChange={(e) => setLocalGoogleApiKey(e.target.value)}
                onBlur={() => onCommit("google_api_key")}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}
                aria-label={t("settings.googleApiKey")}
                aria-invalid={!!errors.google_api_key}
                placeholder={googleApiKeyConfigured ? t("settings.savedKeyPlaceholder") : t("settings.googleNote")}
              />
              <SettingsFieldError field="google_api_key" error={errors.google_api_key} />
              {googleApiKeyConfigured && <button type="button" onClick={onClearGoogleApiKey}>{t("settings.clearSavedKey")}</button>}
            </div>
            <div className="settings-row vertical">
              <div className="settings-row-label">{t("settings.translateProxy")}</div>
              <input
                className="settings-input"
                value={localTranslateProxy}
                onChange={(e) => setLocalTranslateProxy(e.target.value)}
                onBlur={() => onCommit("translate_proxy")}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}
                aria-label={t("settings.translateProxy")}
                aria-invalid={!!errors.translate_proxy}
                placeholder={t("settings.translateProxyPlaceholder")}
              />
              <SettingsFieldError field="translate_proxy" error={errors.translate_proxy} />
            </div>
          </>
        )}
        {localEngine === "ai" && (
          <>
            <div className="settings-row vertical">
              <div className="settings-row-label">{t("settings.apiUrl")}</div>
              <input
                className="settings-input"
                value={localApiUrl}
                onChange={(e) => setLocalApiUrl(e.target.value)}
                onBlur={() => onCommit("ai_api_url")}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}
                aria-label={t("settings.apiUrl")}
                aria-invalid={!!errors.ai_api_url}
                placeholder={t("settings.apiUrlPlaceholder")}
              />
              <SettingsFieldError field="ai_api_url" error={errors.ai_api_url} />
            </div>
            <div className="settings-row vertical">
              <div className="settings-row-label">{t("settings.apiKey")}</div>
              <input
                className="settings-input"
                type="password"
                value={localApiKey}
                onChange={(e) => setLocalApiKey(e.target.value)}
                onBlur={() => onCommit("ai_api_key")}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}
                aria-label={t("settings.apiKey")}
                aria-invalid={!!errors.ai_api_key}
                placeholder={apiKeyConfigured ? t("settings.savedKeyPlaceholder") : t("settings.apiKey")}
              />
              <SettingsFieldError field="ai_api_key" error={errors.ai_api_key} />
              {apiKeyConfigured && <button type="button" onClick={onClearApiKey}>{t("settings.clearSavedKey")}</button>}
            </div>
            <div className="settings-row vertical">
              <div className="settings-row-label">{t("settings.model")}</div>
              <input
                className="settings-input"
                value={localModel}
                onChange={(e) => setLocalModel(e.target.value)}
                onBlur={() => onCommit("ai_model")}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur(); }}
                aria-label={t("settings.model")}
                aria-invalid={!!errors.ai_model}
                placeholder={t("settings.model")}
              />
              <SettingsFieldError field="ai_model" error={errors.ai_model} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
