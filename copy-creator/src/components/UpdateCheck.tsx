import { useTranslation } from "react-i18next";
import { useUpdateStore } from "../stores/updateStore";

export default function UpdateCheck() {
  const { t, i18n } = useTranslation();
  const { info, checking, result, error, errorDetail, checkedAt, check, openLink,
    downloading, launching, downloaded, progress, download, launch } = useUpdateStore();
  const busy = checking || downloading || launching;
  const status = checking ? t("updates.checking") : downloading ? t("updates.downloading") : error ? t(error) : downloaded ? t("updates.downloaded") : result
    ? t(`updates.${result.status}`, { version: result.latestVersion }) : t("updates.hint");

  return (
    <div className="update-check">
      <div className="update-buttons">
        <button className="dialog-btn primary" disabled={busy} onClick={() => void check()}>
          {checking ? t("updates.checking") : t("updates.check")}
        </button>
        {result?.status === "available" && result.releaseUrl && (
          <>
            {result.canDownload && !downloaded && <button className="dialog-btn secondary" disabled={busy} onClick={() => void download()}>
              {t("updates.downloadSigned")}
            </button>}
            {downloaded && <button className="dialog-btn secondary" disabled={busy} onClick={() => void launch()}>
              {t(downloaded.mode === "installed" ? "updates.install" : "updates.openNewVersion")}
            </button>}
            <button className="project-link" onClick={() => void openLink(result.releaseUrl!)}>{t("updates.viewReleases")}</button>
          </>
        )}
      </div>
      <p className={`update-status${error ? " error" : ""}`} role="status" aria-live="polite">
        {status}
        {errorDetail && ` (${errorDetail})`}
      </p>
      {downloading && progress && <div className="update-progress" role="status">
        <progress value={progress.total ? progress.downloaded : undefined} max={progress.total ?? 1} />
        <span>{t("updates.downloadProgress", { received: (progress.downloaded / 1048576).toFixed(1),
          total: progress.total ? (progress.total / 1048576).toFixed(1) : "?" })}</span>
      </div>}
      {result?.status === "available" && result.downloadError && !downloaded && <p className="update-status">{t(result.downloadError)}</p>}
      {downloaded && <p className="update-setting-hint">{t(downloaded.mode === "installed" ? "updates.installHint" : "updates.portableHint")}</p>}
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
