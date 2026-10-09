import { invokeStorage } from "../../lib/storageIdentity";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { DEFAULT_PASSWORD_OPTIONS } from "../../types/vault";
import { Icons } from "../../components/Icons";

export default function PasswordGenerator({ onUse }: { onUse?: (password: string) => void }) {
  const { t } = useTranslation();
  const [options, setOptions] = useState(DEFAULT_PASSWORD_OPTIONS);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generate = async () => {
    setBusy(true); setMessage("");
    try { setPassword(await invoke<string>("generate_vault_password", { options })); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await invokeStorage("copy_vault_generated_password", { password }); setMessage("vault.copied"); }
    catch (error) { setMessage(String(error)); }
  };
  return (
    <div className="vault-generator">
      <div className="vault-section-heading"><span>{t("vault.generator")}</span><span className="vault-caption">{t("vault.generatorHint")}</span></div>
      <label className="vault-length-label">{t("vault.length")}<strong>{options.length}</strong>
        <input type="range" aria-label={t("vault.length")} min="12" max="64" value={options.length} disabled={busy} onChange={(event) => { setOptions({ ...options, length: Number(event.target.value) }); setPassword(""); }} />
      </label>
      <div className="vault-generator-options">
        {(["uppercase", "lowercase", "digits", "symbols", "exclude_ambiguous"] as const).map((key) => (
          <label key={key}><input type="checkbox" checked={options[key]} disabled={busy} onChange={(event) => { setOptions({ ...options, [key]: event.target.checked }); setPassword(""); }} />{t(`vault.${key}`)}</label>
        ))}
      </div>
      {password && <output className="vault-generated-password" aria-label={t("vault.generatedPassword")}>{password}</output>}
      <div className="vault-actions">
        <button className="vault-button secondary" type="button" onClick={generate} disabled={busy}>{Icons.key}{t(password ? "vault.regenerate" : "vault.generate")}</button>
        {password && <button className="vault-icon-button" type="button" onClick={copy} title={t("vault.copy")} aria-label={t("vault.copy")}>{Icons.copy}</button>}
        {password && onUse && <button className="vault-button primary" type="button" onClick={() => onUse(password)}>{t("vault.usePassword")}</button>}
      </div>
      {message && <p className="vault-feedback" role="status">{t(message)}</p>}
    </div>
  );
}
