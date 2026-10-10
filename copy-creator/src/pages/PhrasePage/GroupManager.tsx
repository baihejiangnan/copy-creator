import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { invokeStorage } from "../../lib/storageIdentity";
import { useNotesWorkspace } from "../../stores/notesWorkspace";
import type { RecordGroup } from "../../lib/suiji";
import { recordTones as tones } from "../../lib/recordColors";
export default function GroupManager({ groups, refresh, close }: { groups: RecordGroup[]; refresh(): void; close(): void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<RecordGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => { dialog.current?.querySelector<HTMLInputElement>("input")?.focus(); const previous = previousFocus.current; return () => previous?.focus(); }, []);
  const run = async (action: () => Promise<unknown>) => { if (inFlight.current) return; inFlight.current = true; setBusy(true); try { await action(); refresh(); } catch (error) { useNotesWorkspace.getState().setError(error); } finally { inFlight.current = false; setBusy(false); } };
  const save = (group: RecordGroup, patch: Partial<RecordGroup>, direction: number | null = null) => run(() => invokeStorage("save_suiji_group", { id: group.id, name: patch.name ?? group.name, color: patch.color ?? group.color, direction }));
  return createPortal(<div className="suiji-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="suiji-modal" role="dialog" aria-modal="true" aria-label={t("suiji.manageGroups")} ref={dialog} onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
      if (event.key === "Tab") {
        const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')];
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="suiji-modal-head"><strong>{t("suiji.manageGroups")}</strong><button onClick={close} aria-label={t("notes.dismiss")}>×</button></div>
      <form className="suiji-group-form" onSubmit={event => { event.preventDefault(); void run(async () => { await invokeStorage("save_suiji_group", { id: null, name, color: tones.find(tone => !groups.some(group => group.color === tone)) ?? tones[groups.length % tones.length], direction: null }); setName(""); }); }}>
        <input aria-label={t("suiji.groupName")} placeholder={t("suiji.groupName")} value={name} maxLength={128} onChange={event => setName(event.target.value)} />
        <button disabled={busy || !name.trim()}>{t("suiji.addGroup")}</button>
      </form>
      <div className="suiji-managed-groups">{groups.map((group, index) => <div className="suiji-managed-group" key={group.id}>
        <button className="suiji-color" style={{ background: group.color }} aria-label={t("suiji.changeColor")} title={t("suiji.changeColor")} disabled={busy} onClick={() => { void save(group, { color: tones[(tones.indexOf(group.color) + 1) % tones.length] }); }} />
        {editing?.id === group.id ? <input aria-label={t("suiji.groupName")} value={editing.name} maxLength={128} autoFocus onChange={event => setEditing({ ...editing, name: event.target.value })}
          onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void save(group, { name: editing.name }); setEditing(null); } }}
          onBlur={() => { if (editing.name.trim() && editing.name !== group.name) void save(group, { name: editing.name }); setEditing(null); }} />
          : <button className="suiji-group-name" title={group.name} onClick={() => setEditing(group)}>{group.name}</button>}
        <small>{group.count}</small>
        <button disabled={busy || index === 0} aria-label={t("suiji.moveUp")} onClick={() => { void save(group, {}, -1); }}>↑</button>
        <button disabled={busy || index === groups.length - 1} aria-label={t("suiji.moveDown")} onClick={() => { void save(group, {}, 1); }}>↓</button>
        <button disabled={busy} aria-label={t("suiji.deleteGroup")} title={t("suiji.deleteGroupHint")} onClick={() => { void run(() => invokeStorage("delete_phrase_group", { id: group.id })); }}>×</button>
      </div>)}</div>
      <p>{t("suiji.deleteGroupHint")}</p>
    </div>
  </div>, document.body);
}
