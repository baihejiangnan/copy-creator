import { useTranslation } from "react-i18next";
import { useUpdateStore } from "../stores/updateStore";

export default function UpdateCheck() {
  const { t, i18n } = useTranslation();
  const { info, checking, result, error, checkedAt, check, openLink } = useUpdateStore();
  const status = checking ? t("updates.checking") : error ? t(error) : result
    ? t(`updates.${result.status}`, { version: result.latestVersion }) : t("updates.hint");

  return (
    <div className="update-check">
      <div className="update-buttons">
        <button className="dialog-btn primary" disabled={checking} onClick={() => void check()}>
          {checking ? t("updates.checking") : t("updates.check")}
        </button>
        {result?.status === "available" && result.releaseUrl && (
          <button className="dialog-btn secondary" onClick={() => void openLink(result.releaseUrl!)}>
            {t("updates.download")}
          </button>
        )}
      </div>
      <p className={`update-status${error ? " error" : ""}`} role="status" aria-live="polite">
        {status}
      </p>
      {checkedAt && !checking && !error && (
        <p className="update-last-check">
          {t("updates.lastChecked", { time: new Date(checkedAt).toLocaleString(i18n.language) })}
        </p>
      )}
      {result?.status === "available" && result.notes && (
        <details className="update-notes">
          <summary>{t("updates.releaseNotes")}</summary>
          <p>{result.notes}</p>
        </details>
      )}
      {info && (result?.status === "noRelease" || error) && (
        <button className="project-link" onClick={() => void openLink(info.releasesUrl)}>
          {t("updates.viewReleases")}
        </button>
      )}
    </div>
  );
}
import "../styles/updates.css";
