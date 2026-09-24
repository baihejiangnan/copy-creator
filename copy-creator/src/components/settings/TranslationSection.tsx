import { useTranslation } from "react-i18next";
import IosSelect from "../IosSelect";

interface TranslationSectionProps {
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
                placeholder={googleApiKeyConfigured ? t("settings.savedKeyPlaceholder") : t("settings.googleNote")}
              />
              {googleApiKeyConfigured && <button type="button" onClick={onClearGoogleApiKey}>{t("settings.clearSavedKey")}</button>}
            </div>
            <div className="settings-row vertical">
              <div className="settings-row-label">{t("settings.translateProxy")}</div>
              <input
                className="settings-input"
                value={localTranslateProxy}
                onChange={(e) => setLocalTranslateProxy(e.target.value)}
                placeholder={t("settings.translateProxyPlaceholder")}
              />
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
                placeholder={t("settings.apiUrlPlaceholder")}
              />
            </div>
            <div className="settings-row vertical">
              <div className="settings-row-label">{t("settings.apiKey")}</div>
              <input
                className="settings-input"
                type="password"
                value={localApiKey}
                onChange={(e) => setLocalApiKey(e.target.value)}
                placeholder={apiKeyConfigured ? t("settings.savedKeyPlaceholder") : t("settings.apiKey")}
              />
              {apiKeyConfigured && <button type="button" onClick={onClearApiKey}>{t("settings.clearSavedKey")}</button>}
            </div>
            <div className="settings-row vertical">
              <div className="settings-row-label">{t("settings.model")}</div>
              <input
                className="settings-input"
                value={localModel}
                onChange={(e) => setLocalModel(e.target.value)}
                placeholder={t("settings.model")}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
