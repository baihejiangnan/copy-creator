import { useTranslation } from "react-i18next";
import SelectMenu from "../../components/SelectMenu";
import type { RecordGroup } from "../../lib/suiji";

interface Props {
  groups: RecordGroup[];
  value: string | null;
  disabled: boolean;
  title: string;
  onChange(value: string | null): void;
}

export default function RecordGroupSelect({ groups, value, disabled, title, onChange }: Props) {
  const { t } = useTranslation();
  return <div className="suiji-editor-group"><SelectMenu
    className="suiji-editor-group-trigger" value={value} disabled={disabled} title={disabled ? title : undefined}
    ariaLabel={t("suiji.group")} onChange={onChange}
    options={[{ value: null, label: t("suiji.ungrouped"), color: "var(--text-tertiary)" }, ...groups.map(group => ({ value: group.id, label: group.name, color: group.color }))]}
  /></div>;
}
