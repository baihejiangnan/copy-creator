import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import { useVaultStore } from "../../stores/vaultStore";
import { normalizeVaultAutoLock, VAULT_AUTO_LOCK_OPTIONS, type VaultAutoLock } from "../../types/vault";

interface VaultToolbarProps {
  onChangeMaster?: () => void;
  masterDisabled?: boolean;
}

export default function VaultToolbar({ onChangeMaster, masterDisabled }: VaultToolbarProps) {
  const { t } = useTranslation();
  const { status, busy, settingBusy, setAutoLock, lock } = useVaultStore();
  const autoLock = normalizeVaultAutoLock(status?.auto_lock);

  return <div className="vault-toolbar">
    <span className={`vault-status-indicator${status?.unlocked ? "" : " locked"}`}>
      {t(status?.unlocked ? "vault.unlocked" : "vault.lockedStatus")}
    </span>
    <label className="vault-lock-setting-row">
      <span>{t("vault.autoLockShort")}</span>
      <select
        value={autoLock}
        title={t(`vault.autoLockHints.${autoLock}`)}
        aria-label={t("vault.autoLock")}
        disabled={busy || settingBusy}
        onChange={(event) => void setAutoLock(event.target.value as VaultAutoLock)}
      >
        {VAULT_AUTO_LOCK_OPTIONS.map((value) => <option key={value} value={value}>{t(`vault.autoLockOptions.${value}`)}</option>)}
      </select>
    </label>
    {status?.unlocked && <div className="vault-actions">
      <button type="button" className="vault-text-button" onClick={onChangeMaster} disabled={masterDisabled}>{t("vault.changeMaster")}</button>
      <button type="button" className="vault-button secondary small" onClick={() => void lock()}>{Icons.vault}{t("vault.lock")}</button>
    </div>}
  </div>;
}
