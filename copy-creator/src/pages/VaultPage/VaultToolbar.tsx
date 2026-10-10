import { useTranslation } from "react-i18next";
import SelectMenu from "../../components/SelectMenu";
import { Icons } from "../../components/Icons";
import { useVaultStore } from "../../stores/vaultStore";
import { normalizeVaultAutoLock, VAULT_AUTO_LOCK_OPTIONS } from "../../types/vault";

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
    <div className="vault-lock-setting-row">
      <span>{t("vault.autoLockShort")}</span>
      <SelectMenu value={autoLock} title={t(`vault.autoLockHints.${autoLock}`)} ariaLabel={t("vault.autoLock")}
        disabled={busy || settingBusy} onChange={value => void setAutoLock(value)}
        options={VAULT_AUTO_LOCK_OPTIONS.map(value => ({ value, label: t(`vault.autoLockOptions.${value}`) }))} />
    </div>
    {status?.unlocked && <div className="vault-actions">
      <button type="button" className="vault-text-button" onClick={onChangeMaster} disabled={masterDisabled}>{t("vault.changeMaster")}</button>
      <button type="button" className="vault-button secondary small" onClick={() => void lock()}>{Icons.vault}{t("vault.lock")}</button>
    </div>}
  </div>;
}
