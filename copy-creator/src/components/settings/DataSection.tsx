import { useEffect, useId, useRef, useState } from "react";
import FileDownloadRoundedIcon from "@mui/icons-material/FileDownloadRounded";
import FileUploadRoundedIcon from "@mui/icons-material/FileUploadRounded";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { useVaultStore } from "../../stores/vaultStore";
import { lifecycleErrorKey, withStorageOperation } from "../../lib/lifecycle";
import { isCurrentStorageIdentity, onStorageIdentity, type StorageEvent } from "../../lib/storageIdentity";

interface TransferResult {
  path: string;
  settings_count: number;
  favorites_count: number;
  api_keys_count: number;
  vault_count: number;
  vault_skipped: number;
  notes_count: number;
  note_refs_count: number;
  notes_skipped: number;
  notes_conflicts: number;
}

interface ImportFile { token: string; path: string; encrypted: boolean }
interface ImportPreview extends Omit<TransferResult, "path" | "vault_skipped"> {
  vault_mode: "none" | "restore" | "merge";
  needs_vault_passwords: boolean;
}

interface DataSectionProps {
  onImported: () => Promise<void>;
}

export function DataSection({ onImported }: DataSectionProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"export" | "import" | null>(null);
  const [file, setFile] = useState<ImportFile | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [currentMaster, setCurrentMaster] = useState("");
  const [sourceMaster, setSourceMaster] = useState("");
  const id = useId();
  const pendingToken = useRef<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const clearPasswords = () => {
      setPassword(""); setConfirmation(""); setCurrentMaster(""); setSourceMaster("");
    };
    const onHidden = () => { if (document.hidden) clearPasswords(); };
    document.addEventListener("visibilitychange", onHidden);
    const unlisten = listen<StorageEvent<null>>("vault-locked", ({ payload }) => {
      if (isCurrentStorageIdentity(payload?.storage_epoch)) clearPasswords();
    });
    const stopIdentity = onStorageIdentity(clearPasswords);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onHidden);
      stopIdentity();
      unlisten.then((stop) => stop()).catch(() => {});
      if (pendingToken.current) invoke("cancel_user_data_import", { token: pendingToken.current }).catch(() => {});
    };
  }, []);

  const clearForm = () => {
    if (pendingToken.current) invoke("cancel_user_data_import", { token: pendingToken.current }).catch(() => {});
    pendingToken.current = null;
    setMode(null); setFile(null); setPreview(null);
    setPassword(""); setConfirmation(""); setCurrentMaster(""); setSourceMaster("");
  };

  const showError = (error: unknown) => {
    if (!mounted.current || String(error) === "cancelled") return;
    const message = String(error);
    setStatus(t("settings.transferFailed") + ": " + (message.startsWith("backup.") || message.startsWith("vault.") ? t(message) : message));
  };

  const selectImport = async () => {
    setBusy(true);
    setStatus("");
    clearForm();
    try {
      const selected = await invoke<ImportFile>("select_user_data_import");
      if (!mounted.current) {
        await invoke("cancel_user_data_import", { token: selected.token });
        return;
      }
      pendingToken.current = selected.token;
      setFile(selected); setMode("import");
    } catch (error) { showError(error); }
    finally { if (mounted.current) setBusy(false); }
  };

  const previewImport = async () => {
    if (!file) return;
    setBusy(true); setStatus("");
    try {
      const result = await invoke<ImportPreview>("preview_user_data_import", { token: file.token, backupPassword: password });
      if (mounted.current) setPreview(result);
    } catch (error) { showError(error); }
    finally { if (mounted.current) setBusy(false); }
  };

  const runTransfer = async () => {
    if (mode === "export") {
      if (Array.from(password).length < 12 || password.length > 1024 || !password.trim()) { setStatus(t("backup.passwordLength")); return; }
      if (password !== confirmation) { setStatus(t("backup.passwordMismatch")); return; }
    }
    if (mode === "import" && (!file || !preview)) return;
    const exporting = mode === "export";
    setBusy(true); setStatus("");
    try {
      const result = await withStorageOperation(exporting ? "export" : "import", (operationToken) =>
        invoke<TransferResult>(exporting ? "export_user_data" : "import_user_data", exporting ? { operationToken, backupPassword: password } : {
          operationToken, token: file!.token, backupPassword: password, currentMasterPassword: currentMaster, sourceMasterPassword: sourceMaster,
        }));
      if (!exporting) {
        if (preview?.vault_mode !== "none") {
          useVaultStore.getState().clearLocked();
          await useVaultStore.getState().initialize();
        }
        await onImported();
      }
      if (!mounted.current) return;
      clearForm();
      setStatus(
        t(exporting ? "settings.exportSuccess" : "settings.importSuccess", {
          settings: result.settings_count,
          favorites: result.favorites_count,
          apiKeys: result.api_keys_count,
          vault: result.vault_count,
        }) + (result.vault_skipped ? " " + t("backup.skipped", { count: result.vault_skipped }) : "")
        + " " + t("backup.noteResult", { count: result.notes_count, conflicts: result.notes_conflicts, skipped: result.notes_skipped }),
      );
    } catch (error) { showError(error instanceof Error ? t(lifecycleErrorKey(error)) : error); }
    finally { if (mounted.current) setBusy(false); }
  };

  return (
    <div className="settings-section">
      <div className="settings-section-title">{t("settings.dataTransfer")}</div>
      <div className="settings-card">
        <div className="settings-row settings-transfer-row">
          <button
            className="settings-transfer-btn"
            type="button"
            disabled={busy}
            onClick={() => { clearForm(); setStatus(""); setMode("export"); }}
            title={t("settings.exportData")}
          >
            <FileDownloadRoundedIcon />
            <span>{t("settings.exportData")}</span>
          </button>
          <button
            className="settings-transfer-btn"
            type="button"
            disabled={busy}
            onClick={selectImport}
            title={t("settings.importData")}
          >
            <FileUploadRoundedIcon />
            <span>{t("settings.importData")}</span>
          </button>
        </div>
        <div className="settings-transfer-status">{t("settings.vaultBackupHint")}</div>
        {mode && (
          <form className="settings-backup-form" onSubmit={(event) => {
            event.preventDefault();
            if (mode === "import" && !preview) void previewImport();
            else void runTransfer();
          }}>
            <p>{t(mode === "export" ? "backup.exportHint" : file?.encrypted ? "backup.importHint" : "backup.legacyHint")}</p>
            {file && <p className="settings-backup-path">{file.path}</p>}
            {(mode === "export" || file?.encrypted) && (
              <label htmlFor={`${id}-password`}>{t("backup.password")}
                <input id={`${id}-password`} className="settings-input" type="password" autoComplete={mode === "export" ? "new-password" : "off"}
                  spellCheck={false} maxLength={1024} value={password} disabled={busy} required
                  onChange={(event) => { setPassword(event.target.value); setPreview(null); setCurrentMaster(""); setSourceMaster(""); }} />
              </label>
            )}
            {mode === "export" && (
              <label htmlFor={`${id}-confirm`}>{t("backup.confirmPassword")}
                <input id={`${id}-confirm`} className="settings-input" type="password" autoComplete="new-password" spellCheck={false}
                  maxLength={1024} value={confirmation} disabled={busy} required onChange={(event) => setConfirmation(event.target.value)} />
              </label>
            )}
            {preview && (
              <div className="settings-backup-preview" aria-live="polite">
                <p>{t("backup.previewCounts", { settings: preview.settings_count, favorites: preview.favorites_count, apiKeys: preview.api_keys_count, vault: preview.vault_count })}</p>
                <p>{t("backup.notePreview", { count: preview.notes_count, refs: preview.note_refs_count, conflicts: preview.notes_conflicts, skipped: preview.notes_skipped })}</p>
                <p>{t("backup.noteScope")}</p>
                <p>{t("backup.importPolicy")}</p>
                {preview.vault_mode !== "none" && <p>{t(preview.vault_mode === "restore" ? "backup.restoreHint" : "backup.mergeHint")}</p>}
                {preview.needs_vault_passwords && <>
                  <label htmlFor={`${id}-source`}>{t("backup.sourceMaster")}
                    <input id={`${id}-source`} className="settings-input" type="password" autoComplete="off" spellCheck={false}
                      value={sourceMaster} disabled={busy} required onChange={(event) => setSourceMaster(event.target.value)} />
                  </label>
                  <label htmlFor={`${id}-current`}>{t("backup.currentMaster")}
                    <input id={`${id}-current`} className="settings-input" type="password" autoComplete="off" spellCheck={false}
                      value={currentMaster} disabled={busy} required onChange={(event) => setCurrentMaster(event.target.value)} />
                  </label>
                </>}
              </div>
            )}
            <div className="settings-backup-actions">
              <button className="settings-transfer-btn" type="button" disabled={busy} onClick={clearForm}>{t("backup.cancel")}</button>
              <button className="settings-transfer-btn" type="submit" disabled={busy}>
                {t(busy ? "backup.processing" : mode === "export" ? "backup.createBackup" : preview ? "backup.confirmImport" : "backup.preview")}
              </button>
            </div>
          </form>
        )}
        {status && <div className="settings-transfer-status" role="status">{status}</div>}
      </div>
    </div>
  );
}
