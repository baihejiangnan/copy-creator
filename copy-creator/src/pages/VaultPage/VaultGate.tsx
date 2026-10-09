import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useVaultStore } from "../../stores/vaultStore";
import { Icons } from "../../components/Icons";

export default function VaultGate() {
  const { t } = useTranslation();
  const { status, authenticate, busy, error, setError } = useVaultStore();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const setup = !status?.configured;
  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (setup && password !== confirmation) { setError("vault.passwordMismatch"); return; }
    await authenticate(password, setup);
    setPassword(""); setConfirmation("");
  };
  return (
    <div className="vault-gate">
      <div className="vault-gate-icon">{Icons.vault}</div>
      <span className="vault-eyebrow">{t("vault.eyebrow")}</span>
      <h2>{t(setup ? "vault.setupTitle" : "vault.unlockTitle")}</h2>
      <p>{t(setup ? "vault.setupDescription" : "vault.unlockDescription")}</p>
      <form onSubmit={submit} className="vault-gate-form">
        <label className="vault-form-field">{t("vault.masterPassword")}
          <input type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required placeholder={t(setup ? "vault.masterPlaceholder" : "vault.unlockPlaceholder")} />
        </label>
        {setup && <label className="vault-form-field">{t("vault.confirmPassword")}<input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label>}
        {error && <p className="vault-error" role="alert">{t(error)}</p>}
        <button className="vault-button primary full" type="submit" disabled={busy}>{t(busy ? "vault.unlocking" : setup ? "vault.createVault" : "vault.unlock")}</button>
      </form>
      <p className="vault-gate-footnote">{t(setup ? "vault.masterReminder" : "vault.clipboardHint")}</p>
    </div>
  );
}
