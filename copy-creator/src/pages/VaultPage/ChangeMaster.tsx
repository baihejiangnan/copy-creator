import { invokeStorage } from "../../lib/storageIdentity";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export default function ChangeMaster({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (next !== confirmation) { setError("vault.passwordMismatch"); return; }
    setBusy(true); setError("");
    try { await invokeStorage("change_vault_master", { currentPassword: current, newPassword: next }); onBack(); }
    catch (failure) { setError(String(failure)); }
    finally { setCurrent(""); setNext(""); setConfirmation(""); setBusy(false); }
  };
  return <form className="vault-section" onSubmit={submit}>
    <h3>{t("vault.changeMaster")}</h3>
    <p className="vault-caption">{t("vault.masterReminder")}</p>
    <label className="vault-form-field">{t("vault.currentPassword")}<input type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required /></label>
    <label className="vault-form-field">{t("vault.newPassword")}<input type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} required /></label>
    <label className="vault-form-field">{t("vault.confirmPassword")}<input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required /></label>
    {error && <p className="vault-error" role="alert">{t(error)}</p>}
    <div className="vault-actions"><button className="vault-button secondary" type="button" onClick={onBack} disabled={busy}>{t("vault.cancel")}</button><button className="vault-button primary" type="submit" disabled={busy}>{t(busy ? "vault.saving" : "vault.save")}</button></div>
  </form>;
}
