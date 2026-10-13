import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import SearchInput from "../../components/SearchInput";
import { getStorageIdentity, invokeStorage } from "../../lib/storageIdentity";
import { LatestQuery } from "../../lib/latestQuery";
import type { VaultQueryPage, VaultSummary } from "../../types/vault";

export function VaultPagination({ offset, total, onChange, disabled }: { offset: number; total: number; onChange: (offset: number) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  if (total <= 50 && offset === 0) return null;
  return <nav className="v2-pagination" aria-label={t("vault2.pagination")}>
    <button type="button" className="vault-text-button" disabled={disabled || offset === 0} onClick={() => onChange(Math.max(0, offset - 50))}>{t("vault2.previous")}</button>
    <span>{t("vault2.page", { page: Math.floor(offset / 50) + 1, total: Math.max(1, Math.ceil(total / 50)) })}</span>
    <button type="button" className="vault-text-button" disabled={disabled || offset + 50 >= total} onClick={() => onChange(offset + 50)}>{t("vault2.next")}</button>
  </nav>;
}

export default function IdentityPicker({ selected, onChange, onPick, disabled = false }: { selected: string[]; onChange?: (ids: string[]) => void; onPick?: (identity: VaultSummary) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(""); const [offset, setOffset] = useState(0);
  const [queries] = useState(() => new LatestQuery<VaultQueryPage>());
  const [page, setPage] = useState<VaultQueryPage | null>(null); const [error, setError] = useState(""); const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      void getStorageIdentity().then(origin => queries.run(JSON.stringify([origin, search, offset]), () => {
        if (!active) return Promise.reject("notes.storageChanged");
        return invokeStorage<VaultQueryPage>("query_vault_entries", { search, kind: "identity", identity: "", offset }, origin);
      })).then(result => {
        if (active && result) setPage(result);
      }).catch(reason => { if (active) setError(String(reason)); }).finally(() => { if (active) setLoading(false); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [search, offset, queries]);
  return <div className="v2-identity-picker">
    <SearchInput value={search} placeholder={t("vault2.identitySearch")} onChange={value => { setSearch(value); setOffset(0); }} />
    {onChange && <p className="vault-caption">{t("vault2.selectedCount", { count: selected.length })}<button type="button" className="vault-text-button" disabled={disabled || selected.length === 0} onClick={() => onChange([])}>{t("vault2.clearLinks")}</button></p>}
    {loading && <p className="vault-caption" role="status">{t("vault.loading")}</p>}
    {error && <p className="vault-error" role="alert">{t(error)}</p>}
    <div className="v2-identity-choices">{page?.entries.map(identity => onPick ? <button type="button" className="v2-identity-choice" key={identity.id} disabled={disabled || loading} onClick={() => onPick(identity)}><strong>{identity.title}</strong><small>{identity.summary}</small></button> : <label className={`v2-identity-choice ${selected.includes(identity.id) ? "chosen" : ""}`} key={identity.id}>
      <input type="checkbox" checked={selected.includes(identity.id)} disabled={disabled || loading || (!selected.includes(identity.id) && selected.length >= 128)} onChange={event => onChange?.(event.target.checked ? [...selected, identity.id] : selected.filter(id => id !== identity.id))} /><span><strong>{identity.title}</strong><small>{identity.summary}</small></span>
    </label>)}</div>
    {!loading && page?.total === 0 && <p className="vault-caption">{t(search ? "vault.noResults" : "vault2.noIdentities")}</p>}
    <VaultPagination offset={offset} total={page?.total ?? 0} onChange={setOffset} disabled={disabled || loading} />
  </div>;
}

export function IdentityLinks({ ids, onIdentity }: { ids: string[]; onIdentity: (id: string) => void }) {
  const { t } = useTranslation(); const [entries, setEntries] = useState<VaultSummary[]>([]);
  const token = JSON.stringify(ids);
  useEffect(() => {
    let active = true;
    if (ids.length) void invokeStorage<VaultSummary[]>("get_vault_summaries", { ids: JSON.parse(token) as string[] }).then(result => { if (active) setEntries(result); }).catch(() => { /* Parent refresh exposes storage or lock errors. */ });
    return () => { active = false; };
  }, [token, ids.length]);
  return <div className="v2-identity-links">{ids.length ? ids.map(id => <button type="button" className="vault-text-button" key={id} onClick={() => onIdentity(id)}>{entries.find(identity => identity.id === id)?.title ?? t("vault2.viewIdentity")} ↗</button>) : <span className="vault-caption">{t("vault2.independent")}</span>}</div>;
}
