import { useState } from "react";
import { useTranslation } from "react-i18next";
import SelectMenu from "../../components/SelectMenu";
import { Icons } from "../../components/Icons";
import { useVaultStore } from "../../stores/vaultStore";
import { PERSONAL_TEMPLATES, VERIFICATION_KINDS } from "../../types/vault";
import type { VaultEntry } from "../../types/vault";
import PasswordGenerator from "./PasswordGenerator";

interface Props { initial: VaultEntry; onCancel: () => void; onSaved: () => void }

export default function EntryEditor({ initial, onCancel, onSaved }: Props) {
  const { t } = useTranslation();
  const { saveEntry, busy } = useVaultStore();
  const [entry, setEntry] = useState(() => structuredClone(initial));
  const [tags, setTags] = useState(initial.tags.join(", "));
  const [showPassword, setShowPassword] = useState(false);
  const [showGenerator, setShowGenerator] = useState(false);
  const [revealed, setRevealed] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [template, setTemplate] = useState<keyof typeof PERSONAL_TEMPLATES>("personal");
  const [verificationKind, setVerificationKind] = useState<string>("email");
  const update = (patch: Partial<VaultEntry>) => { setEntry((current) => ({ ...current, ...patch })); setDirty(true); };
  const toggleReveal = (id: string) => setRevealed((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  const addTemplate = () => {
    const fields = PERSONAL_TEMPLATES[template].filter((key) => !entry.fields.some((field) => field.label === t(`vault.profile.${key}`)))
      .map((key) => ({ id: crypto.randomUUID(), label: t(`vault.profile.${key}`), value: "", sensitive: false }));
    update({ fields: [...entry.fields, ...fields] });
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await saveEntry({ ...entry, tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean) })) onSaved();
  };
  const cancel = () => { if (dirty) setDiscard(true); else onCancel(); };
  return <form className="vault-editor" onSubmit={submit} autoComplete="off">
    <div className="vault-subheader"><button type="button" className="vault-text-button" onClick={cancel}>← {t("vault.back")}</button><strong>{t(entry.id ? "vault.editEntry" : "vault.newEntry")}</strong></div>
    {discard && <div className="vault-confirm" role="alert"><p>{t("vault.discardConfirm")}</p><div className="vault-actions"><button className="vault-button secondary" type="button" onClick={() => setDiscard(false)}>{t("vault.keepEditing")}</button><button className="vault-button danger" type="button" onClick={onCancel}>{t("vault.discard")}</button></div></div>}
    <section className="vault-section">
      <h3>{t("vault.websiteSection")}</h3>
      <label className="vault-form-field">{t("vault.siteName")}<input value={entry.title} onChange={(event) => update({ title: event.target.value })} placeholder={t("vault.siteNamePlaceholder")} required maxLength={120} /></label>
      <label className="vault-form-field">{t("vault.website")}<input value={entry.website} onChange={(event) => update({ website: event.target.value })} placeholder="https://example.com" maxLength={2048} /></label>
      <label className="vault-form-field">{t("vault.tags")}<input value={tags} onChange={(event) => { setTags(event.target.value); setDirty(true); }} placeholder={t("vault.tagsPlaceholder")} maxLength={800} /></label>
    </section>
    <section className="vault-section">
      <h3>{t("vault.basicAccount")}</h3>
      <div className="vault-form-grid">
        <label className="vault-form-field">{t("vault.username")}<input value={entry.username} onChange={(event) => update({ username: event.target.value })} maxLength={2048} /></label>
        <label className="vault-form-field">{t("vault.email")}<input inputMode="email" value={entry.email} onChange={(event) => update({ email: event.target.value })} maxLength={2048} /></label>
        <label className="vault-form-field">{t("vault.phone")}<input inputMode="tel" value={entry.phone} onChange={(event) => update({ phone: event.target.value })} maxLength={2048} /></label>
      </div>
      <label className="vault-form-field">{t("vault.password")}<div className="vault-input-actions"><input aria-label={t("vault.password")} type={showPassword ? "text" : "password"} autoComplete="new-password" value={entry.password} onChange={(event) => update({ password: event.target.value })} maxLength={2048} /><button type="button" className="vault-text-button" onClick={() => setShowPassword(!showPassword)}>{t(showPassword ? "vault.hide" : "vault.show")}</button></div></label>
      <button type="button" className="vault-text-button" onClick={() => setShowGenerator(!showGenerator)}>{Icons.key}{t(showGenerator ? "vault.closeGenerator" : "vault.generateStrong")}</button>
      {showGenerator && <PasswordGenerator onUse={(password) => { update({ password }); setShowPassword(false); setShowGenerator(false); }} />}
    </section>
    <section className="vault-section">
      <div className="vault-section-heading"><h3>{t("vault.personalInfo")}</h3><span className="vault-caption">{t("vault.optional")}</span></div>
      <p className="vault-caption">{t("vault.personalHint")}</p>
      <div className="vault-template-actions"><SelectMenu<keyof typeof PERSONAL_TEMPLATES> ariaLabel={t("vault.profileTemplate")} value={template} onChange={setTemplate} options={[{ value: "personal", label: t("vault.personalTemplate") }, { value: "work", label: t("vault.workTemplate") }]} /><button type="button" className="vault-button secondary small" onClick={addTemplate} disabled={entry.fields.length >= 60}>{t("vault.applyTemplate")}</button></div>
      {entry.fields.map((field, index) => <div className="vault-custom-field" key={field.id}>
        <div className="vault-custom-heading"><input aria-label={t("vault.fieldName")} value={field.label} placeholder={t("vault.fieldName")} onChange={(event) => update({ fields: entry.fields.map((value, i) => i === index ? { ...value, label: event.target.value } : value) })} required maxLength={80} /><button className="vault-icon-button danger-text" type="button" aria-label={t("vault.removeField")} onClick={() => update({ fields: entry.fields.filter((_, i) => i !== index) })}>{Icons.delete}</button></div>
        <textarea aria-label={field.label || t("vault.fieldValue")} rows={2} value={field.sensitive && !revealed.includes(field.id) && field.value ? "••••••••" : field.value} readOnly={field.sensitive && !revealed.includes(field.id)} onChange={(event) => update({ fields: entry.fields.map((value, i) => i === index ? { ...value, value: event.target.value } : value) })} maxLength={16384} placeholder={t("vault.fieldValue")} />
        <div className="vault-custom-footer"><label><input type="checkbox" checked={field.sensitive} onChange={(event) => update({ fields: entry.fields.map((value, i) => i === index ? { ...value, sensitive: event.target.checked } : value) })} />{t("vault.sensitiveField")}</label>{field.sensitive && <button className="vault-text-button" type="button" onClick={() => toggleReveal(field.id)}>{t(revealed.includes(field.id) ? "vault.hide" : "vault.revealEdit")}</button>}</div>
      </div>)}
      <button className="vault-text-button" type="button" disabled={entry.fields.length >= 64} onClick={() => update({ fields: [...entry.fields, { id: crypto.randomUUID(), label: "", value: "", sensitive: false }] })}>{Icons.add}{t("vault.addField")}</button>
    </section>
    <section className="vault-section">
      <div className="vault-section-heading"><h3>{t("vault.verification")}</h3><span className="vault-caption">{t("vault.optional")}</span></div>
      <p className="vault-caption">{t("vault.verificationHint")}</p>
      {entry.verification.map((method, index) => {
        const sensitive = !["email", "sms", "passkey", "authenticator"].includes(method.kind);
        return <div className="vault-custom-field" key={method.id}>
          <div className="vault-custom-heading"><input aria-label={t("vault.verificationName")} value={method.label} onChange={(event) => update({ verification: entry.verification.map((value, i) => i === index ? { ...value, label: event.target.value } : value) })} required maxLength={80} /><button className="vault-icon-button danger-text" type="button" aria-label={t("vault.removeVerification")} onClick={() => update({ verification: entry.verification.filter((_, i) => i !== index) })}>{Icons.delete}</button></div>
          <span className="vault-method-badge">{t(`vault.methods.${method.kind}`)}</span>
          <textarea aria-label={method.label} rows={method.kind === "recovery_codes" ? 4 : 2} value={sensitive && !revealed.includes(method.id) && method.value ? "••••••••" : method.value} readOnly={sensitive && !revealed.includes(method.id)} onChange={(event) => update({ verification: entry.verification.map((value, i) => i === index ? { ...value, value: event.target.value } : value) })} placeholder={t(`vault.methodHints.${method.kind}`)} maxLength={16384} />
          {sensitive && <button className="vault-text-button" type="button" onClick={() => toggleReveal(method.id)}>{t(revealed.includes(method.id) ? "vault.hide" : "vault.revealEdit")}</button>}
          <label className="vault-form-field compact">{t("vault.verificationNote")}<input value={method.note} onChange={(event) => update({ verification: entry.verification.map((value, i) => i === index ? { ...value, note: event.target.value } : value) })} maxLength={4096} /></label>
        </div>;
      })}
      <div className="vault-template-actions"><SelectMenu<string> ariaLabel={t("vault.verificationTemplate")} value={verificationKind} onChange={setVerificationKind} options={VERIFICATION_KINDS.map(kind => ({ value: kind, label: t(`vault.methods.${kind}`) }))} /><button className="vault-button secondary small" type="button" disabled={entry.verification.length >= 32} onClick={() => {
        const id = crypto.randomUUID();
        update({ verification: [...entry.verification, { id, kind: verificationKind, label: t(`vault.methods.${verificationKind}`), value: "", note: "" }] });
        setRevealed((current) => [...current, id]);
      }}>{Icons.add}{t("vault.addVerification")}</button></div>
    </section>
    <section className="vault-section"><label className="vault-form-field">{t("vault.notes")}<textarea rows={4} value={entry.notes} onChange={(event) => update({ notes: event.target.value })} maxLength={16384} placeholder={t("vault.notesPlaceholder")} /></label></section>
    <div className="vault-editor-footer"><button className="vault-button secondary" type="button" onClick={cancel} disabled={busy}>{t("vault.cancel")}</button><button className="vault-button primary" type="submit" disabled={busy}>{t(busy ? "vault.saving" : "vault.save")}</button></div>
  </form>;
}
