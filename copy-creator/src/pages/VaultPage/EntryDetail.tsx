import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../../components/Icons";
import { useVaultStore } from "../../stores/vaultStore";
import type { VaultEntry } from "../../types/vault";

export default function EntryDetail({ entry, onBack, onEdit }: { entry: VaultEntry; onBack: () => void; onEdit: () => void }) {
  const { t } = useTranslation();
  const { copyField, pasteField, deleteEntry, busy, setError } = useVaultStore();
  const [revealed, setRevealed] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const row = (key: string, label: string, value: string, sensitive = false) => value ? <div className="vault-detail-row" key={key}>
    <div className="vault-detail-content"><span className="vault-detail-label">{label}</span><span className={sensitive ? "vault-detail-value secret" : "vault-detail-value"}>{sensitive && !revealed.includes(key) ? "••••••••••••" : value}</span></div>
    <div className="vault-detail-actions">
      {sensitive && <button type="button" className="vault-text-button" disabled={busy} onClick={() => setRevealed((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])}>{t(revealed.includes(key) ? "vault.hide" : "vault.show")}</button>}
      <button type="button" className="vault-icon-button" disabled={busy} aria-label={`${t("vault.copy")} ${label}`} title={t("vault.copy")} onClick={() => void copyField(entry.id, key)}>{Icons.copy}</button>
      <button type="button" className="vault-button secondary small" disabled={busy} aria-label={`${t("vault.fill")} ${label}`} title={t("vault.fillHint")} onClick={() => void pasteField(entry.id, key)}>{Icons.paste}{t("vault.fill")}</button>
    </div>
  </div> : null;
  const openWebsite = async () => {
    try { await invoke("open_external_link", { url: entry.website }); }
    catch (error) { setError(String(error)); }
  };
  return <div className="vault-detail">
    <div className="vault-subheader"><button type="button" className="vault-text-button" onClick={onBack}>← {t("vault.back")}</button><div className="vault-actions"><button type="button" className="vault-icon-button" title={t("vault.editEntry")} aria-label={t("vault.editEntry")} onClick={onEdit}>{Icons.edit}</button><button type="button" className="vault-icon-button danger-text" title={t("vault.deleteEntry")} aria-label={t("vault.deleteEntry")} onClick={() => setDeleting(true)}>{Icons.delete}</button></div></div>
    <div className="vault-detail-heading"><div className="vault-site-avatar">{entry.title.slice(0, 1).toUpperCase()}</div><div><h2>{entry.title}</h2>{entry.website && <button className="vault-text-button vault-domain" type="button" onClick={openWebsite}>{entry.website} ↗</button>}</div></div>
    {entry.tags.length > 0 && <div className="vault-tags">{entry.tags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div>}
    <p className="vault-caption vault-fill-hint">{t("vault.fillHint")}</p>
    {deleting && <div className="vault-confirm" role="alert"><p>{t("vault.deleteConfirm", { title: entry.title })}</p><div className="vault-actions"><button type="button" className="vault-button secondary" onClick={() => setDeleting(false)}>{t("vault.cancel")}</button><button type="button" className="vault-button danger" disabled={busy} onClick={async () => { if (await deleteEntry(entry.id)) onBack(); }}>{t("vault.deleteEntry")}</button></div></div>}
    <section className="vault-section"><h3>{t("vault.basicAccount")}</h3>
      {row("username", t("vault.username"), entry.username)}{row("email", t("vault.email"), entry.email)}{row("phone", t("vault.phone"), entry.phone)}{row("password", t("vault.password"), entry.password, true)}
      {![entry.username, entry.email, entry.phone, entry.password].some(Boolean) && <p className="vault-caption">{t("vault.noAccountInfo")}</p>}
    </section>
    {entry.fields.length > 0 && <section className="vault-section"><h3>{t("vault.personalInfo")}</h3>{entry.fields.map((field) => row(`field:${field.id}`, field.label, field.value, field.sensitive))}</section>}
    {entry.verification.length > 0 && <section className="vault-section"><h3>{t("vault.verification")}</h3>{entry.verification.map((method) => <div className="vault-verification-detail" key={method.id}>
      <span className="vault-method-badge">{t(`vault.methods.${method.kind}`)}</span>
      {row(`verification:${method.id}`, method.label, method.value, !["email", "sms", "passkey", "authenticator"].includes(method.kind))}
      {!method.value && <p className="vault-caption">{method.label}</p>}
      {method.note && <p className="vault-caption">{method.note}</p>}
    </div>)}</section>}
    {entry.notes && <section className="vault-section"><h3>{t("vault.notes")}</h3>{row("notes", t("vault.notes"), entry.notes)}</section>}
    <p className="vault-caption vault-detail-footnote">{t("vault.updatedAt", { date: new Date(entry.updated_at).toLocaleString() })}</p>
  </div>;
}
