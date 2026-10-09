import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { lifecycleErrorKey, withStorageOperation } from "../../lib/lifecycle";

interface StorageSectionProps {
  storagePath: string;
  setStoragePath: (path: string) => void;
}

export function StorageSection({
  storagePath,
  setStoragePath,
}: StorageSectionProps) {
  const { t } = useTranslation();
  const [needRestart, setNeedRestart] = useState(false);
  const [storageError, setStorageError] = useState("");

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.storage")}</div>
      <div className="settings-card">
        <div className="settings-row vertical">
          <div className="settings-row-label">{t("settings.storagePath")}</div>
          <div className="settings-storage-row">
            <span className="settings-storage-path">{storagePath}</span>
            <button
              className="settings-storage-btn"
              onClick={async () => {
                setStorageError("");
                try {
                  const folder = await invoke<string>("select_storage_folder");
                  await withStorageOperation("storage", (operationToken) => invoke<number>("change_storage_directory", { operationToken, newPath: folder }));
                  setStoragePath(folder);
                  setNeedRestart(true);
                } catch (error) { if (String(error) !== "cancelled") setStorageError(error instanceof Error ? lifecycleErrorKey(error) : String(error)); }
              }}
            >
              {t("settings.changeFolder")}
            </button>
          </div>
          <div className="settings-storage-hint">
            {t("settings.storagePathHint")}
          </div>
          {storageError && <p className="vault-error" role="alert">{t(storageError)}</p>}
          {needRestart && (
            <div className="settings-restart-hint">
              <span>{t("settings.restartHint")}</span>
              <button
                className="settings-restart-btn"
                onClick={() => { void invoke("request_app_restart").catch((error) => setStorageError(String(error))); }}
              >
                {t("settings.restartNow")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
