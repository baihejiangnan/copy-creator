import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icons } from "../../components/Icons";
import StarBorderRoundedIcon from "@mui/icons-material/StarBorderRounded";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNotesWorkspace } from "../../stores/notesWorkspace";
import { organizeNote, pasteNote } from "../../lib/suiji";
import type { RecordGroup } from "../../lib/suiji";
import { changeNoteState } from "../../lib/noteActions";
import { readNote } from "../../lib/notes";
import type { NoteSummary } from "../../types/note";
import { isCurrentStorageIdentity } from "../../lib/storageIdentity";

export default function RecordMenu({ note, groups, x, y, epoch, close }: { note: NoteSummary; groups: RecordGroup[]; x: number; y: number; epoch: number; close(): void }) {
  const { t } = useTranslation();
  const [submenu, setSubmenu] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuWidth = Math.min(192, window.innerWidth - 24);
  const left = Math.max(12, Math.min(x, window.innerWidth - menuWidth - 12));
  const top = Math.max(12, Math.min(y, window.innerHeight - 264));
  const submenuLeft = Math.max(12 - left, Math.min(left + menuWidth + 172 > window.innerWidth ? -162 : menuWidth - 2, window.innerWidth - left - 176));
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const fittedTop = Math.max(12, Math.min(y, window.innerHeight - element.offsetHeight - 12));
    element.style.top = `${fittedTop}px`;
    element.style.setProperty("--menu-top", `${fittedTop}px`);
  }, [y]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    const dismiss = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("mousedown", dismiss); window.addEventListener("resize", close);
    return () => { document.removeEventListener("mousedown", dismiss); window.removeEventListener("resize", close); };
  }, [close]);
  const run = (operation: () => Promise<unknown>) => { close(); void operation().catch(useNotesWorkspace.getState().setError); };
  const state = async (action: "archive" | "unarchive" | "delete" | "restore") => { if (!isCurrentStorageIdentity(epoch)) throw { code: "notes.storageChanged" }; await readNote(note.id); await changeNoteState(note.id, action, epoch); };
  return createPortal(<div ref={root} role="menu" aria-label={t("suiji.recordActions")} className="app-context-menu suiji-context" style={{ left, top, width: menuWidth }} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
    if (event.key === "Tab") close();
    if (event.key === "ArrowLeft") { event.preventDefault(); setSubmenu(false); root.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  }}>
    {!note.deleted_at_ms && <>
      <button className="ctx-menu-item" role="menuitem" onClick={() => run(() => pasteNote(note.id, epoch))}>{Icons.clipboard}{t("suiji.paste")}</button>
      <button className="ctx-menu-item" role="menuitem" onClick={() => run(() => useNotesWorkspace.getState().open(note.id, epoch))}>{Icons.notes}{t("suiji.edit")}</button>
      <button className="ctx-menu-item" role="menuitem" onClick={() => run(() => organizeNote(note.id, { starred: !note.starred }, epoch))}><StarBorderRoundedIcon />{t(note.starred ? "suiji.unstar" : "suiji.star")}</button>
      <div onMouseEnter={() => setSubmenu(true)} onMouseLeave={() => setSubmenu(false)}>
        <button className="ctx-menu-item" role="menuitem" aria-haspopup="menu" aria-expanded={submenu} onClick={() => setSubmenu(true)} onKeyDown={event => { if (event.key === "ArrowRight") { event.preventDefault(); setSubmenu(true); } }}>{Icons.phrases}{t("suiji.group")}<span className="ctx-menu-trailing" aria-hidden="true">›</span></button>
        {submenu && <div className="app-context-menu suiji-group-submenu" role="menu" aria-label={t("suiji.group")} style={{ left: submenuLeft, maxHeight: "min(240px, calc(100dvh - var(--menu-top) - 14px))" }}>
          <button className="ctx-menu-item" role="menuitemradio" aria-checked={!note.group_id} onClick={() => run(() => organizeNote(note.id, { groupId: null }, epoch))}>{t("suiji.ungrouped")}{!note.group_id && <small className="ctx-menu-trailing" aria-hidden="true">✓</small>}</button>
          {groups.map(group => <button className="ctx-menu-item" key={group.id} role="menuitemradio" aria-checked={note.group_id === group.id} title={group.name} onClick={() => run(() => organizeNote(note.id, { groupId: group.id }, epoch))}>
            <i className="ctx-menu-dot" style={{ background: group.color }} /><span className="suiji-ellipsis">{group.name}</span>{note.group_id === group.id && <small className="ctx-menu-trailing" aria-hidden="true">✓</small>}
          </button>)}
        </div>}
      </div>
      <div className="ctx-menu-sep" />
      <button className="ctx-menu-item" role="menuitem" onClick={() => run(() => state(note.archived_at_ms ? "unarchive" : "archive"))}>{Icons.notes}{t(note.archived_at_ms ? "notes.unarchive" : "notes.archive")}</button>
      <button className="ctx-menu-item danger" role="menuitem" onClick={() => run(() => state("delete"))}>{Icons.delete}{t("notes.delete")}</button>
    </>}
    {!!note.deleted_at_ms && <button className="ctx-menu-item" role="menuitem" onClick={() => run(() => state("restore"))}>{t("notes.restore")}</button>}
  </div>, document.body);
}
