import { useState } from "react";
import { useTranslation } from "react-i18next";
import SearchInput from "../../components/SearchInput";
import { Icons } from "../../components/Icons";

export default function TemplatePicker({ identity, onChoose, onBack }: { identity: boolean; onChoose: (preset: string) => void; onBack: () => void }) {
  const { t } = useTranslation(); const [more, setMore] = useState(false); const [search, setSearch] = useState("");
  const option = (preset: string) => <button type="button" className="v2-template" key={preset} onClick={() => onChoose(preset)}><span className="v2-symbol">{preset === "custom" || preset === "identityCustom" ? Icons.add : preset === "login" ? Icons.link : Icons.vault}</span><span><strong>{t(`vault2.presets.${preset}`)}</strong><small>{t(`vault2.presetHints.${preset}`)}</small></span><span aria-hidden="true">›</span></button>;
  return <div className="vault-view"><div className="vault-subheader"><button type="button" className="vault-text-button" onClick={onBack}>← {t("vault.back")}</button><strong>{t(identity ? "vault2.newIdentity" : "vault.newEntry")}</strong></div><p className="vault-caption">{t("vault2.chooseHint")}</p><div className="v2-template-list">{(identity ? ["identityPersonal", "identityWork", "identityCustom"] : ["custom", "login", "server"]).map(option)}</div>{!identity && <><button type="button" className="vault-text-button" aria-expanded={more} onClick={() => setMore(!more)}>{more ? "−" : "+"} {t("vault2.morePresets")}</button>{more && <div className="v2-more-presets"><SearchInput value={search} onChange={setSearch} placeholder={t("vault2.searchPresets")} /><div className="v2-preset-scroll">{["database", "api", "recovery", "personal", "work"].filter(preset => t(`vault2.presets.${preset}`).toLowerCase().includes(search.toLowerCase())).map(option)}</div></div>}</>}</div>;
}
