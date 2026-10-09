import "../../styles/vault.css";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "../../components/Icons";
import SearchInput from "../../components/SearchInput";
import { useVaultStore } from "../../stores/vaultStore";
import { emptyVaultEntry } from "../../types/vault";
import VaultGate from "./VaultGate";
import EntryEditor from "./EntryEditor";
import EntryDetail from "./EntryDetail";
import PasswordGenerator from "./PasswordGenerator";
import ChangeMaster from "./ChangeMaster";
import VaultToolbar from "./VaultToolbar";

function domain(website: string) {
  try { return new URL(website).hostname.replace(/^www\./, ""); } catch { return website; }
}

function UnlockedVault() {
  const { t } = useTranslation();
  const { entries, selected, search, busy, error, notice, setSearch, refresh, openEntry, clearSelected } = useVaultStore();
  const [mode, setMode] = useState<"list" | "detail" | "new" | "edit" | "generator" | "master">("list");
  const topRef = useRef<HTMLDivElement>(null);
  useEffect(() => { topRef.current?.closest(".panel-window-body")?.scrollTo({ top: 0 }); }, [mode]);
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 250);
    return () => clearTimeout(timer);
  }, [refresh, search]);
  const back = () => { clearSelected(); setMode("list"); };
  return <>
    <div ref={topRef}><VaultToolbar onChangeMaster={() => { clearSelected(); setMode("master"); }} masterDisabled={mode === "edit" || mode === "new"} /></div>
    {error && <p className="vault-error" role="alert">{t(error)}</p>}
    {notice && <p className="vault-feedback" role="status">{t(notice)}</p>}
    {mode === "master" ? <ChangeMaster onBack={back} /> : mode === "generator" ? <><button type="button" className="vault-text-button" onClick={back}>← {t("vault.back")}</button><section className="vault-section"><PasswordGenerator /></section></> : mode === "new" || (mode === "edit" && selected) ? <EntryEditor key={selected?.id || "new"} initial={mode === "edit" && selected ? selected : emptyVaultEntry()} onCancel={mode === "edit" ? () => setMode("detail") : back} onSaved={() => setMode("detail")} /> : mode === "detail" && selected ? <EntryDetail entry={selected} onBack={back} onEdit={() => setMode("edit")} /> : <>
      <div className="vault-list-heading"><div><span className="vault-eyebrow">{t("vault.eyebrow")}</span><h2>{t("vault.yourWebsites")}</h2><p className="vault-caption">{t("vault.multipleAccounts")}</p></div><button className="vault-button primary" type="button" onClick={() => { clearSelected(); setMode("new"); }}>{Icons.add}{t("vault.newEntry")}</button></div>
      <SearchInput placeholder={t("vault.searchPlaceholder")} value={search} onChange={setSearch} />
      <div className="vault-list-meta"><span>{t("vault.entryCount", { count: entries.length })}</span><button type="button" className="vault-text-button" onClick={() => setMode("generator")}>{Icons.key}{t("vault.generator")}</button></div>
      {entries.length === 0 ? <div className="vault-empty"><div className="vault-empty-icon">{Icons.vault}</div><h3>{t(search ? "vault.noResults" : "vault.emptyTitle")}</h3><p>{t(search ? "vault.noResultsHint" : "vault.emptyHint")}</p>{search && <button type="button" className="vault-text-button" onClick={() => setSearch("")}>{t("vault.clearSearch")}</button>}</div> : <div className="vault-list">{entries.map((entry) => <button type="button" className="vault-site-card" key={entry.id} disabled={busy} onClick={async () => { if (await openEntry(entry.id)) setMode("detail"); }}>
        <span className="vault-site-avatar">{entry.title.slice(0, 1).toUpperCase()}</span><span className="vault-site-card-body"><span className="vault-site-title">{entry.title}</span><span className="vault-site-domain">{domain(entry.website) || t("vault.noWebsite")}</span><span className="vault-site-account">{entry.username || entry.email || t("vault.noAccountInfo")}</span>{entry.tags.length > 0 && <span className="vault-tags">{entry.tags.slice(0, 3).map((tag, index) => <span key={`${tag}-${index}`}>{tag}</span>)}</span>}</span><span className="vault-site-card-end">{entry.has_password && Icons.key}<span>›</span></span>
      </button>)}</div>}
      <p className="vault-list-footnote">{t("vault.clipboardHint")}</p>
    </>}
  </>;
}

export default function VaultPage() {
  const { t } = useTranslation();
  const { status, initialize, error } = useVaultStore();
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => { pageRef.current?.closest(".panel-window-body")?.scrollTo({ top: 0 }); }, [status?.unlocked]);
  return <div className="vault-page" ref={pageRef}>
    {status && !status.unlocked && <VaultToolbar />}
    {status === null ? <div className="vault-empty"><p role="status">{t(error || "vault.loading")}</p>{error && <button className="vault-button secondary" type="button" onClick={() => void initialize()}>{t("vault.retry")}</button>}</div> : status.unlocked ? <UnlockedVault /> : <VaultGate />}
  </div>;
}
