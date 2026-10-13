import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import { useVaultStore } from "../../stores/vaultStore";
import { createVaultField, moveVaultField, vaultFieldLabel, VAULT_ADDITIONAL_FIELDS } from "../../lib/vaultModel";
import type { VaultEntry, VaultField, VaultFieldType } from "../../types/vault";
import PasswordGenerator from "./PasswordGenerator";
import IdentityPicker from "./IdentityPicker";
import { saveBarrier } from "../../lib/lifecycle";
import { ownVaultNavigation } from "../../lib/vaultNavigation";

interface Props { initial: VaultEntry; onCancel: () => void; onSaved: () => void }
export default function EntryEditor({ initial, onCancel, onSaved }: Props) {
  const { t } = useTranslation(); const { saveEntry, busy } = useVaultStore();
  const [entry, setEntry] = useState(() => structuredClone(initial)); const [tags, setTags] = useState(initial.tags.join(", "));
  const [dirty, setDirty] = useState(false); const [revealed, setRevealed] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const dirtyRef = useRef(false);
  const [picker, setPicker] = useState(false); const [generator, setGenerator] = useState("");
  const [confirm, setConfirm] = useState<{ text: string; run: () => void } | null>(null);
  const identity = entry.kind === "identity";
  const update = (patch: Partial<VaultEntry>) => { setEntry(current => ({ ...current, ...patch })); dirtyRef.current = true; setDirty(true); };
  useEffect(() => saveBarrier.register("vault-editor", {
    pause: () => setPaused(true), resume: () => setPaused(false),
    flush: async () => { if (dirtyRef.current) throw new Error("vault.unsavedDraft"); },
  }), []);
  useEffect(() => ownVaultNavigation(proceed => {
    if (dirty) setConfirm({ text: t("vault.discardConfirm"), run: proceed }); else proceed();
  }, () => dirtyRef.current), [dirty, t]);
  const updateField = (id: string, patch: Partial<VaultField>) => update({ fields: entry.fields.map(field => field.id === id ? { ...field, ...patch } : field) });
  const cancel = () => { if (dirty) setConfirm({ text: t("vault.discardConfirm"), run: onCancel }); else onCancel(); };
  return <form className="vault-editor v2-editor" autoComplete="off" onSubmit={async event => {
    event.preventDefault();
    if (busy || paused) return;
    if (await saveEntry({ ...entry, tags: tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean) })) { dirtyRef.current = false; onSaved(); }
  }}>
    <div className="vault-subheader"><button type="button" className="vault-text-button" disabled={busy} onClick={cancel}>← {t("vault.back")}</button><strong>{t(identity ? entry.created_at ? "vault2.editIdentity" : "vault2.newIdentity" : entry.created_at ? "vault.editEntry" : "vault.newEntry")}</strong></div>
    {confirm && <div className="vault-confirm" role="alert"><p>{confirm.text}</p><div className="vault-actions"><button type="button" className="vault-button secondary" autoFocus disabled={busy} onClick={() => setConfirm(null)}>{t("vault.cancel")}</button><button type="button" className="vault-button danger" disabled={busy} onClick={() => { confirm.run(); setConfirm(null); }}>{t("vault2.confirm")}</button></div></div>}
    <fieldset disabled={busy || paused} className="v2-editor-body">
      <label className="vault-form-field v2-title-input">{t(identity ? "vault2.identityName" : "vault2.entryTitle")}<input required autoFocus value={entry.title} maxLength={120} placeholder={t(identity ? "vault2.identityNameHint" : "vault2.titleHint")} onChange={event => update({ title: event.target.value })} /></label>
      {identity ? <p className="vault-caption">{t("vault2.identityHint")}</p> : <details className="v2-assignment" open={initial.identity_ids.length > 0 || undefined}><summary>{t("vault2.linkIdentities")} · {entry.identity_ids.length}</summary><p className="vault-caption">{t("vault2.relationshipHint")}</p><IdentityPicker selected={entry.identity_ids} onChange={ids => update({ identity_ids: ids })} disabled={busy} /></details>}
      {entry.template === "login" && <div className="v2-login-editor"><label className="vault-form-field">{t("vault2.loginMethod")}<select value={entry.login_method || "password"} onChange={event => update({ login_method: event.target.value })}>{["password", "email_code", "sms_code", "sso", "other"].map(method => <option value={method} key={method}>{t(`vault2.loginMethods.${method}`)}</option>)}</select></label><label className="vault-form-field">{t("vault2.loginNote")}<input value={entry.login_note} maxLength={200} onChange={event => update({ login_note: event.target.value })} /></label><p className="vault-caption">{t("vault2.loginHint")}</p></div>}
      <div className="v2-editor-fields">{entry.fields.map((field, index) => {
        const visible = !field.sensitive || revealed.includes(field.id);
        const fieldLabel = vaultFieldLabel(field, t);
        return <section className="vault-custom-field" key={field.id}>
          <div className="vault-custom-heading"><input required aria-label={t("vault.fieldName")} maxLength={80} value={fieldLabel} placeholder={t("vault.fieldName")} onChange={event => updateField(field.id, { label: event.target.value, purpose: field.purpose?.startsWith("legacy_base:") ? "" : field.purpose })} />
            <button type="button" className="vault-icon-button" disabled={index === 0} aria-label={t("vault2.moveUp")} onClick={() => update({ fields: moveVaultField(entry.fields, field.id, -1) })}>↑</button><button type="button" className="vault-icon-button" disabled={index === entry.fields.length - 1} aria-label={t("vault2.moveDown")} onClick={() => update({ fields: moveVaultField(entry.fields, field.id, 1) })}>↓</button><button type="button" className="vault-icon-button danger-text" aria-label={t("vault.removeField")} onClick={() => {
              const run = () => { update({ fields: entry.fields.filter(value => value.id !== field.id) }); if (generator === field.id) setGenerator(""); };
              if (field.value) setConfirm({ text: t("vault2.removeFieldHint"), run }); else run();
            }}>{Icons.delete}</button></div>
          <div className="vault-input-actions">{field.type === "multiline" ? <textarea rows={3} aria-label={fieldLabel || t("vault.fieldValue")} maxLength={16384} readOnly={!visible} value={visible ? field.value : "••••••••••••"} onChange={event => updateField(field.id, { value: event.target.value })} /> : <input aria-label={fieldLabel || t("vault.fieldValue")} type={visible ? "text" : "password"} autoComplete="off" maxLength={16384} value={field.value} onChange={event => updateField(field.id, { value: event.target.value })} />}
            {field.sensitive && <button type="button" className="vault-text-button" onClick={() => setRevealed(ids => ids.includes(field.id) ? ids.filter(id => id !== field.id) : [...ids, field.id])}>{t(visible ? "vault.hide" : "vault.show")}</button>}</div>
          <div className="vault-custom-footer"><select aria-label={`${fieldLabel} ${t("vault2.fieldType")}`} value={field.type} onChange={event => { const type = event.target.value as VaultFieldType; updateField(field.id, { type, sensitive: field.sensitive || type === "secret" }); }}>{["text", "secret", "url", "multiline"].map(type => <option value={type} key={type}>{t(`vault2.types.${type}`)}</option>)}</select><label><input type="checkbox" checked={field.sensitive} onChange={event => {
            if (event.target.checked) updateField(field.id, { sensitive: true });
            else setConfirm({ text: t("vault2.sensitiveHint"), run: () => updateField(field.id, { sensitive: false }) });
          }} />{t("vault.sensitiveField")}</label></div>
          {field.type === "secret" && <button type="button" className="vault-text-button" onClick={() => setGenerator(generator === field.id ? "" : field.id)}>{Icons.key}{t("vault.generator")}</button>}
          {generator === field.id && <PasswordGenerator onUse={password => { updateField(field.id, { value: password }); setGenerator(""); setRevealed(ids => ids.filter(id => id !== field.id)); }} />}
        </section>;
      })}</div>
      <button type="button" className="vault-text-button v2-add-field" disabled={entry.fields.length >= Math.max(128, initial.fields.length)} onClick={() => setPicker(!picker)} aria-expanded={picker}>{Icons.add}{t("vault.addField")}</button>
      {picker && <div className="v2-field-picker">{VAULT_ADDITIONAL_FIELDS.map(preset => <button type="button" className="vault-text-button" key={preset[0]} onClick={() => { update({ fields: [...entry.fields, createVaultField(preset, t)] }); setPicker(false); }}>{t(`vault2.fields.${preset[0]}`)}</button>)}</div>}
      <details className="v2-optional"><summary>{t("vault2.moreOptions")}</summary><label className="vault-form-field">{t("vault.tags")}<input value={tags} maxLength={900} onChange={event => { setTags(event.target.value); dirtyRef.current = true; setDirty(true); }} /></label><label className="vault-form-field">{t("vault2.summary")}<select value={entry.fields.some(field => field.id === entry.summary_field_id && !field.sensitive) ? entry.summary_field_id : ""} onChange={event => update({ summary_field_id: event.target.value })}><option value="">{t("vault2.automatic")}</option>{entry.fields.filter(field => !field.sensitive).map(field => <option value={field.id} key={field.id}>{vaultFieldLabel(field, t)}</option>)}</select></label></details>
    </fieldset>
    <div className="vault-editor-footer"><button type="button" className="vault-button secondary" disabled={busy} onClick={cancel}>{t("vault.cancel")}</button><button type="submit" className="vault-button primary" disabled={busy}>{t(busy ? "vault.saving" : identity ? "vault2.saveIdentity" : "vault.save")}</button></div>
  </form>;
}
