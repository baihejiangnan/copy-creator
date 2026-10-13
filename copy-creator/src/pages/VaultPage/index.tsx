import "../../styles/vault.css";
import "../../styles/vault-v2.css";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import SearchInput from "../../components/SearchInput";
import RestartAsAdminButton from "../../components/RestartAsAdminButton";
import { useVaultStore } from "../../stores/vaultStore";
import type { VaultEntry } from "../../types/vault";
import { createVaultEntry } from "../../lib/vaultModel";
import VaultGate from "./VaultGate";
import EntryEditor from "./EntryEditor";
import EntryDetail from "./EntryDetail";
import PasswordGenerator from "./PasswordGenerator";
import ChangeMaster from "./ChangeMaster";
import VaultToolbar from "./VaultToolbar";
import TemplatePicker from "./TemplatePicker";
import IdentityPicker, { VaultPagination } from "./IdentityPicker";

function UnlockedVault() {
  const { t } = useTranslation();
  const { entries, selected, search, busy, listing, error, notice, total, identityTotal, detailTotal, independentTotal, queryKind, queryIdentity, offset, setSearch, setQuery, refresh, openEntry, clearSelected } = useVaultStore();
  const [mode, setMode] = useState<"list" | "templates" | "editor" | "generator" | "master" | "filter">("list");
  const [organization, setOrganization] = useState<"identities" | "all">("identities");
  const [profile, setProfile] = useState<VaultEntry | null>(null); const [draft, setDraft] = useState<VaultEntry | null>(null);
  const [createIdentity, setCreateIdentity] = useState(false); const [filterTitle, setFilterTitle] = useState("");
  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => { clearSelected(); setSearch(""); setQuery("identity"); return () => clearSelected(); }, [clearSelected, setSearch, setQuery]);
  useEffect(() => { topRef.current?.closest(".panel-window-body")?.scrollTo({ top: 0 }); }, [mode, profile?.id]);
  useEffect(() => { const timer = setTimeout(() => void refresh(), 200); return () => clearTimeout(timer); }, [refresh, search, queryKind, queryIdentity, offset]);
  const back = () => { setDraft(null); setMode("list"); clearSelected(); };
  const root = (organization: "identities" | "all", identity = "") => {
    setProfile(null); setOrganization(organization); setDraft(null); setMode("list"); clearSelected(); setSearch(""); setQuery(organization === "identities" ? "identity" : "entry", identity);
  };
  const showIdentity = async (id: string) => {
    if (!await openEntry(id)) return;
    const identity = useVaultStore.getState().selected;
    if (identity?.kind !== "identity") return;
    setProfile(identity); setOrganization("identities"); clearSelected(); setSearch(""); setQuery("entry", id); setMode("list");
  };
  const overview = organization === "identities" && !profile;
  const newItem = (identity: boolean) => { clearSelected(); setCreateIdentity(identity); setMode("templates"); };
  const edit = (entry: VaultEntry) => { setDraft(entry); clearSelected(); setMode("editor"); };
  return <>
    <div ref={topRef}><VaultToolbar onChangeMaster={() => { clearSelected(); setMode("master"); }} masterDisabled={mode === "editor"} /></div>
    {error && <div className="vault-error" role="alert">{t(error)}{error === "vault.pasteRequiresElevation" && <RestartAsAdminButton />}</div>}
    {notice && <p className="vault-feedback" role="status">{t(notice)}</p>}
    <div className="vault-view" key={mode}>
      {mode === "master" ? <ChangeMaster onBack={back} /> : mode === "generator" ? <><button type="button" className="vault-text-button" onClick={back}>← {t("vault.back")}</button><section className="vault-section"><PasswordGenerator /></section></> : mode === "templates" ? <TemplatePicker identity={createIdentity} onBack={back} onChoose={preset => { setDraft(createVaultEntry(preset, t, profile ? [profile.id] : queryIdentity && queryIdentity !== "independent" ? [queryIdentity] : [])); setMode("editor"); }} /> : mode === "editor" && draft ? <EntryEditor key={draft.id || draft.template} initial={draft} onCancel={back} onSaved={() => {
        const saved = useVaultStore.getState().selected;
        if (saved?.kind === "identity") { setProfile(saved); setOrganization("identities"); clearSelected(); setSearch(""); setQuery("entry", saved.id); }
        else if (profile && saved && !saved.identity_ids.includes(profile.id)) { setProfile(null); setOrganization("all"); setSearch(""); setQuery("entry"); }
        else setQuery(queryKind, queryIdentity, 0);
        setDraft(null); setMode("list");
      }} /> : mode === "filter" ? <><button type="button" className="vault-text-button" onClick={back}>← {t("vault.back")}</button><h3>{t("vault2.filterIdentity")}</h3><IdentityPicker selected={[]} onPick={identity => { root("all", identity.id); setFilterTitle(identity.title); }} /></> : <>
        <nav className="v2-tabs" aria-label={t("tabs.vault")}><button type="button" aria-pressed={organization === "all"} disabled={busy} onClick={() => root("all")}>{t("vault2.allDetails")}<span>{detailTotal}</span></button><button type="button" aria-pressed={organization === "identities"} disabled={busy} onClick={() => root("identities")}>{t("vault2.identities")}<span>{identityTotal}</span></button></nav>
        {profile ? <><button type="button" className="vault-text-button v2-back-identities" disabled={busy} onClick={() => root("identities")}>‹ {t("vault2.allIdentities")}</button><div className="vault-detail-heading"><span className="v2-avatar">{profile.title.slice(0, 1)}</span><h2>{profile.title}</h2></div><EntryDetail key={profile.id + profile.updated_at} entry={profile} identityProfile onIdentity={id => void showIdentity(id)} onEdit={() => edit(profile)} onDeleted={() => root("identities")} /><h3 className="v2-related-heading">{t("vault2.relatedDetails")}</h3></> : overview && <div className="vault-list-heading"><div><h2>{t("vault2.overviewHeading")}</h2><p className="vault-caption">{t("vault2.overviewHint")}</p></div></div>}
        <div className="vault-search-row"><SearchInput value={search} onChange={value => { clearSelected(); setSearch(value); }} placeholder={t(overview ? "vault2.identitySearch" : "vault2.search")} /><button type="button" className="vault-button primary v2-create" aria-label={t(overview ? "vault2.newIdentity" : "vault.newEntry")} disabled={busy} onClick={() => newItem(overview)}>{Icons.add}<span>{t(overview ? "vault2.newIdentity" : "vault2.new")}</span></button></div>
        {organization === "all" && <div className="v2-filter"><select aria-label={t("vault2.filterIdentity")} value={queryIdentity && queryIdentity !== "independent" ? "identity" : queryIdentity} disabled={busy} onChange={event => { if (event.target.value === "identity") setMode("filter"); else { clearSelected(); setQuery("entry", event.target.value); } }}><option value="">{t("vault2.allDetails")}</option><option value="independent">{t("vault2.independentDetails")}</option><option value="identity">{queryIdentity && queryIdentity !== "independent" ? filterTitle || t("vault2.filterIdentity") : t("vault2.filterIdentity")}</option></select>{queryIdentity && queryIdentity !== "independent" && <button type="button" className="vault-text-button" onClick={() => setMode("filter")}>{t("vault2.changeFilter")}</button>}</div>}
        <div className="vault-list-meta"><span>{t("vault.entryCount", { count: total })}</span><button type="button" className="vault-text-button" disabled={busy} onClick={() => { clearSelected(); setMode("generator"); }}>{Icons.key}{t("vault.generator")}</button></div>
        {(busy || listing) && <p className="vault-caption" role="status">{t("vault.loading")}</p>}
        {entries.length === 0 && !listing ? <div className="vault-empty"><h3>{t(search ? "vault.noResults" : overview ? "vault2.noIdentities" : profile ? "vault2.noRelated" : "vault.emptyTitle")}</h3><p>{t(search ? "vault.noResultsHint" : "vault2.emptyHint")}</p>{search ? <button type="button" className="vault-text-button" onClick={() => setSearch("")}>{t("vault.clearSearch")}</button> : <button type="button" className="vault-text-button" disabled={busy} onClick={() => newItem(overview)}>{Icons.add}{t(overview ? "vault2.newIdentity" : "vault.newEntry")}</button>}</div> : <div className="v2-list">{entries.map(entry => overview ? <article className="v2-identity-card" key={entry.id}><button type="button" className="v2-identity-main" disabled={busy} onClick={() => void showIdentity(entry.id)}><span className={`v2-avatar ${entry.template === "identityWork" ? "work" : ""}`}>{entry.title.slice(0, 1)}</span><span><strong>{entry.title}</strong>{entry.summary && <small>{entry.summary}</small>}<small>{t("vault2.linkedCount", { count: entry.related_count })}</small></span><span className="v2-chevron" aria-hidden="true">›</span></button><button type="button" className="vault-icon-button" aria-label={`${t("vault2.editIdentity")} ${entry.title}`} disabled={busy} onClick={async () => { if (await openEntry(entry.id)) { const value = useVaultStore.getState().selected; if (value) edit(value); } }}>{Icons.edit}</button></article> : <article className={`v2-service-card ${selected?.id === entry.id ? "open" : ""}`} key={entry.id}><div className="v2-service-heading"><button type="button" className="v2-service-toggle" aria-expanded={selected?.id === entry.id} disabled={busy} onClick={() => { if (selected?.id === entry.id) clearSelected(); else void openEntry(entry.id); }}><span className="v2-symbol">{entry.template === "login" ? Icons.link : Icons.vault}</span><span><strong>{entry.title}</strong>{entry.summary && <small>{entry.summary}</small>}</span><span className="v2-chevron" aria-hidden="true">›</span></button><button type="button" className="vault-icon-button" aria-label={`${t("vault.editEntry")} ${entry.title}`} disabled={busy} onClick={async () => { if (await openEntry(entry.id)) { const value = useVaultStore.getState().selected; if (value) edit(value); } }}>{Icons.edit}</button></div>{selected?.id === entry.id && <EntryDetail key={selected.id} entry={selected} onEdit={() => edit(selected)} onDeleted={() => { clearSelected(); void refresh(); }} onIdentity={id => void showIdentity(id)} />}</article>)}</div>}
        <VaultPagination total={total} offset={offset} disabled={busy} onChange={value => { clearSelected(); setQuery(queryKind, queryIdentity, value); }} />
        {overview && <button type="button" className="v2-independent" disabled={busy} onClick={() => root("all", "independent")}><span><strong>{t("vault2.independentDetails")}</strong><small>{t("vault2.independentHint")}</small></span><span>{independentTotal} ›</span></button>}
        <p className="vault-list-footnote">{t("vault.clipboardHint")}</p>
      </>}
    </div>
  </>;
}

export default function VaultPage() {
  const { t } = useTranslation(); const { status, initialize, error } = useVaultStore(); const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => { pageRef.current?.closest(".panel-window-body")?.scrollTo({ top: 0 }); }, [status?.unlocked]);
  return <div className="vault-page" ref={pageRef}>{status && !status.unlocked && <VaultToolbar />}{status === null ? <div className="vault-empty"><p role="status">{t(error || "vault.loading")}</p>{error && <button type="button" className="vault-button secondary" onClick={() => void initialize()}>{t("vault.retry")}</button>}</div> : status.unlocked ? <UnlockedVault /> : <VaultGate />}</div>;
}
