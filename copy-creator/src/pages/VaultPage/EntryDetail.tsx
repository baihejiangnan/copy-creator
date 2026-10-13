import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Icons } from "../../components/Icons";
import { useVaultStore } from "../../stores/vaultStore";
import type { VaultEntry } from "../../types/vault";
import { vaultFieldLabel } from "../../lib/vaultModel";
import { IdentityLinks } from "./IdentityPicker";

export function VaultFields({ entry }: { entry: VaultEntry }) {
  const { t } = useTranslation(); const { busy, copyField, pasteField, setError } = useVaultStore();
  const [revealed, setRevealed] = useState<string[]>([]);
  return <div className="v2-fields">{entry.fields.filter(field => field.value).map(field => <div className="vault-detail-row" key={field.id}>
    <div className="vault-detail-content">{field.purpose && !field.purpose.startsWith("legacy_base:") && <span className="vault-method-badge">{t(`vault.methods.${field.purpose.replace(/_note$/, "")}`)}{field.purpose.endsWith("_note") && ` · ${t("vault.verificationNote")}`}</span>}<span className="vault-detail-label">{vaultFieldLabel(field, t)}</span><button type="button" className={`v2-field-value ${field.sensitive ? "secret" : ""}`} disabled={busy} aria-label={`${t("vault2.paste")} ${vaultFieldLabel(field, t)}`} onClick={event => {
      const selection = window.getSelection();
      if (selection?.toString() && (event.currentTarget.contains(selection.anchorNode) || event.currentTarget.contains(selection.focusNode))) return;
      void pasteField(entry.id, `field:${field.id}`);
    }}>{field.sensitive && !revealed.includes(field.id) ? "••••••••••••" : field.value}</button></div>
    <div className="vault-detail-actions">
      {field.sensitive && <button type="button" className="vault-text-button" disabled={busy} aria-label={`${t(revealed.includes(field.id) ? "vault.hide" : "vault.show")} ${vaultFieldLabel(field, t)}`} onClick={() => setRevealed(ids => ids.includes(field.id) ? ids.filter(id => id !== field.id) : [...ids, field.id])}>{t(revealed.includes(field.id) ? "vault.hide" : "vault.show")}</button>}
      {field.type === "url" && <button type="button" className="vault-icon-button" aria-label={`${t("vault2.openUrl")} ${vaultFieldLabel(field, t)}`} disabled={busy} onClick={() => void invoke("open_external_link", { url: field.value }).catch(error => setError(String(error)))}>{Icons.link}</button>}
      <button type="button" className="vault-icon-button" aria-label={`${t("vault.copy")} ${vaultFieldLabel(field, t)}`} disabled={busy} onClick={() => void copyField(entry.id, `field:${field.id}`)}>{Icons.copy}</button>
    </div>
  </div>)}</div>;
}

export default function EntryDetail({ entry, onEdit, onDeleted, onIdentity, identityProfile = false }: { entry: VaultEntry; onEdit: () => void; onDeleted: () => void; onIdentity: (id: string) => void; identityProfile?: boolean }) {
  const { t } = useTranslation(); const { busy, deleteEntry } = useVaultStore(); const [deleting, setDeleting] = useState(false);
  return <div className={`v2-entry-detail ${identityProfile ? "v2-profile" : ""}`}>
    <div className="v2-detail-tools"><button type="button" className="vault-icon-button" aria-label={t(identityProfile ? "vault2.editIdentity" : "vault.editEntry")} disabled={busy} onClick={onEdit}>{Icons.edit}</button><button type="button" className="vault-icon-button danger-text" aria-label={t(identityProfile ? "vault2.deleteIdentity" : "vault.deleteEntry")} disabled={busy} onClick={() => setDeleting(true)}>{Icons.delete}</button></div>
    {deleting && <div className="vault-confirm" role="alert"><p>{t(identityProfile ? "vault2.deleteIdentityHint" : "vault.deleteConfirm", { title: entry.title })}</p><div className="vault-actions"><button type="button" className="vault-button secondary" autoFocus disabled={busy} onClick={() => setDeleting(false)}>{t("vault.cancel")}</button><button type="button" className="vault-button danger" disabled={busy} onClick={async () => { if (await deleteEntry(entry.id)) onDeleted(); }}>{t(identityProfile ? "vault2.deleteIdentity" : "vault.deleteEntry")}</button></div></div>}
    {!identityProfile && <IdentityLinks ids={entry.identity_ids} onIdentity={onIdentity} />}
    {entry.template === "login" && <p className="vault-caption">{t("vault2.loginMethod")} · {t(`vault2.loginMethods.${entry.login_method || "password"}`)}{entry.login_note && <span className="v2-login-note">{entry.login_note}</span>}</p>}
    {identityProfile ? <details className="v2-profile-fields" open><summary>{t("vault2.identityDetails")}</summary><VaultFields key={entry.id} entry={entry} /></details> : <VaultFields key={entry.id} entry={entry} />}
    {entry.fields.every(field => !field.value) && <p className="vault-caption">{t("vault2.emptyFields")}</p>}
    {entry.tags.length > 0 && <div className="vault-tags">{entry.tags.map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</div>}
    <p className="vault-caption v2-field-hint">{t(identityProfile ? "vault2.identityHint" : "vault2.clickHint")}</p>
    <p className="vault-caption v2-updated">{t("vault.updatedAt", { date: new Date(entry.updated_at).toLocaleString() })}</p>
  </div>;
}
