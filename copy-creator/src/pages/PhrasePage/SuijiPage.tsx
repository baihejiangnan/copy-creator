import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useNotesWorkspace } from "../../stores/notesWorkspace";
import { NoteEditor } from "../NotesPage";
import { useWindowVisible } from "../../lib/documentVisible";
import { onStorageIdentity } from "../../lib/storageIdentity";
import { organizeNote, pasteNote } from "../../lib/suiji";
import { useRecordGroups } from "../../lib/useRecordGroups";
import type { NoteFilter, NoteSummary } from "../../types/note";
import type { NoteCoordinator } from "../../lib/noteCoordinator";
import type { NoteFeed } from "../../lib/noteFeed";
import GroupManager from "./GroupManager";
import RecordMenu from "./RecordMenu";
import RecordPreview from "./RecordPreview";
import SearchInput from "../../components/SearchInput";
import "../../styles/phrases.css";
import "../../styles/suiji.css";
const fail = (error: unknown) => useNotesWorkspace.getState().setError(error);


function Workspace({ coordinator, feed }: { coordinator: NoteCoordinator; feed: NoteFeed }) {
  const { t } = useTranslation();
  const selectedId = useNotesWorkspace(state => state.selectedId);
  const quickId = useNotesWorkspace(state => state.quickId);
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const recovery = useSyncExternalStore(listener => coordinator.subscribeBudget(listener), () => coordinator.getRecoveryIds().join("|"));
  const visible = useWindowVisible();
  const { groups, ready, refresh } = useRecordGroups();
  const [search, setSearch] = useState(state.search);
  const [composing, setComposing] = useState(false);
  const [groupSearch, setGroupSearch] = useState("");
  const [picker, setPicker] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [manager, setManager] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [collapsedId, setCollapsedId] = useState<string | null>(null);
  const expanded = !!selectedId && (selectedId === quickId ? expandedId === selectedId : collapsedId !== selectedId);
  const [context, setContext] = useState<{ note: NoteSummary; x: number; y: number; epoch: number } | null>(null);
  const pickerRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picker) return;
    const frame = requestAnimationFrame(() => pickerRoot.current?.querySelector<HTMLInputElement>("input")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [picker]);
  useEffect(() => { feed.setVisible(visible); return () => feed.setVisible(false); }, [feed, visible]);
  useEffect(() => onStorageIdentity(() => { setSearch(""); setPicker(false); setManager(false); setContext(null); setPreviewId(null); }), []);
  useEffect(() => {
    const captured = () => { setSearch(""); setPicker(false); setContext(null); };
    window.addEventListener("open-note", captured);
    return () => window.removeEventListener("open-note", captured);
  }, []);
  useEffect(() => { if (ready && state.groupId && !groups.some(group => group.id === state.groupId)) void feed.setQuery("active", state.search).catch(fail); }, [ready, groups, state.groupId, state.search, feed]);
  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => { void feed.setQuery(state.filter, search, state.groupId ?? null).catch(fail); }, 200);
    return () => clearTimeout(timer);
  }, [feed, state.filter, state.groupId, search, composing]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!pickerRoot.current?.contains(event.target as Node)) setPicker(false); };
    document.addEventListener("mousedown", close); return () => document.removeEventListener("mousedown", close);
  }, []);
  const choose = (filter: NoteFilter, groupId: string | null = null) => { setPicker(false); void feed.setQuery(filter, search, groupId).catch(fail); };
  const currentGroup = groups.find(group => group.id === state.groupId);
  const filterLabel = currentGroup?.name ?? t(`suiji.${state.filter === "active" ? "all" : state.filter}`);
  return <>
    <div className="suiji-toolbar">
      <div className="page-search suiji-search"><SearchInput ariaLabel={t("suiji.search")} placeholder={t("suiji.search")} value={search} maxLength={256} onChange={setSearch} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} /></div>
      <div className="suiji-picker-root" ref={pickerRoot} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setPicker(false); pickerRoot.current?.querySelector<HTMLButtonElement>(".suiji-group-trigger")?.focus(); } }}>
        <button className="suiji-group-trigger" title={filterLabel} aria-label={t("suiji.chooseGroup")} aria-expanded={picker} aria-controls="suiji-group-picker" onClick={() => setPicker(!picker)}><span className="suiji-ellipsis">{!currentGroup && state.filter === "active" ? t("suiji.allShort") : filterLabel}</span><svg className="suiji-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg></button>
        <div id="suiji-group-picker" className={`app-context-menu suiji-picker suiji-menu${picker ? " is-open" : ""}`} inert={!picker} aria-hidden={!picker}>
          <input type="search" aria-label={t("suiji.searchGroups")} placeholder={t("suiji.searchGroups")} value={groupSearch} onChange={event => setGroupSearch(event.target.value)} />
          <div className="suiji-picker-list">
            {(["active", "starred", "ungrouped"] as NoteFilter[]).filter(filter => !groupSearch || t(`suiji.${filter === "active" ? "all" : filter}`).includes(groupSearch)).map(filter => <button key={filter} aria-pressed={!state.groupId && state.filter === filter} onClick={() => choose(filter)}>{t(`suiji.${filter === "active" ? "all" : filter}`)}</button>)}
            <div className="suiji-menu-divider" />
            {groups.filter(group => group.name.toLocaleLowerCase().includes(groupSearch.toLocaleLowerCase())).map(group => <button key={group.id} title={group.name} aria-pressed={state.groupId === group.id} onClick={() => choose("active", group.id)}><i style={{ background: group.color }} /><span className="suiji-ellipsis">{group.name}</span><small>{group.count}</small></button>)}
          </div>
          <div className="suiji-picker-footer"><button onClick={() => { setPicker(false); setManager(true); }}>{t("suiji.addGroup")}</button><button onClick={() => { setPicker(false); setManager(true); }}>{t("suiji.manageGroups")}</button></div>
        </div>
      </div>
      <button className="phrase-add-btn suiji-create" aria-label={t("suiji.create")} title={t("suiji.create")} onClick={() => useNotesWorkspace.getState().create()}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" /></svg></button>
    </div>
    {selectedId && <section className={`suiji-composer notes-page ${expanded ? "expanded" : ""}`} aria-label={t("suiji.editor")}>
      <NoteEditor key={selectedId} id={selectedId} coordinator={coordinator} groups={groups} compact={selectedId === quickId} expanded={expanded} onExpand={() => {
        if (selectedId === quickId) setExpandedId(expanded ? null : selectedId);
        else setCollapsedId(expanded ? selectedId : null);
      }} />
    </section>}
    <div className="suiji-list-head"><span className="suiji-ellipsis" title={filterLabel}>{filterLabel}</span><small>· {t("suiji.pageCount", { count: state.records.length })}</small><button className="suiji-sort" title={t("suiji.switchSort")} onClick={() => { void feed.setSort(state.sort === "updated" ? "created" : "updated").catch(fail); }}>{t(state.sort === "updated" ? "suiji.recentEdited" : "suiji.createdTime")} <span aria-hidden="true">↓</span></button></div>
    <div className="phrase-list suiji-list">
      {state.filter === "trash" && <p className="notes-hint">{t("notes.trashHint")}</p>}
      {recovery && <div className="suiji-recovery"><small>{t("notes.recovery")}</small>{recovery.split("|").filter(id => id !== selectedId).map(id => <button key={id} onClick={() => useNotesWorkspace.getState().select(id)}>{coordinator.getSession(id)?.draft.title || coordinator.getSession(id)?.draft.body.slice(0, 80) || t("notes.untitled")}</button>)}</div>}
      {state.error && <div role="alert" className="notes-error">{t(state.error.code)}<button onClick={() => { void feed.load(); }}>{t("notes.retry")}</button></div>}
      {state.loading && !state.records.length && <p role="status" className="notes-hint">{t("notes.loading")}</p>}
      {!state.loading && !state.error && !state.records.length && <p className="suiji-empty">{t("suiji.empty")}</p>}
      {state.records.map((note, index) => {
        const group = groups.find(group => group.id === note.group_id);
        const epoch = state.storageEpoch ?? coordinator.storageEpoch;
        const action = () => { void (note.deleted_at_ms ? useNotesWorkspace.getState().open(note.id, epoch) : pasteNote(note.id, epoch)).catch(fail); };
        return <div role="button" tabIndex={0} key={note.id} className="notification phrase-card suiji-card" style={{ "--enter-delay": Math.min(index, 5), "--color": group?.color ?? "#8e8e93" } as CSSProperties}
          aria-label={`${t(note.deleted_at_ms ? "suiji.edit" : "suiji.paste")} ${note.title || t("notes.untitled")}`} onClick={action}
          onContextMenu={event => { event.preventDefault(); setContext({ note, epoch, x: event.clientX, y: event.clientY }); }}
          onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === "Enter" || event.key === " ") { event.preventDefault(); action(); } if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setContext({ note, epoch, x: rect.left + 20, y: rect.top + 20 }); } }}>
          <div className="notibar" /><div className="noticontent"><RecordPreview key={`${epoch}:${note.id}:${note.revision}`} note={note} epoch={epoch} expanded={previewId === note.id} toggle={() => setPreviewId(previewId === note.id ? null : note.id)} />
          <div className="notititle phrase-card-footer"><span className="phrase-card-remark">{note.title || t("notes.untitled")}</span><small title={group?.name}>{group?.name || t("suiji.ungrouped")}</small>
            {!note.deleted_at_ms && <div className="phrase-card-actions" onKeyDown={event => event.stopPropagation()}>
              <button className="card-edit-btn suiji-card-action" aria-label={t("suiji.edit")} title={t("suiji.edit")} onClick={event => { event.stopPropagation(); void useNotesWorkspace.getState().open(note.id, epoch); }}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m15 5 4 4M4 20l4-1L20 7l-4-4L4 15z" /></svg></button>
              <button className="card-edit-btn suiji-card-action" aria-label={t(note.starred ? "suiji.unstar" : "suiji.star")} aria-pressed={!!note.starred} title={t(note.starred ? "suiji.unstar" : "suiji.star")} onClick={event => { event.stopPropagation(); void organizeNote(note.id, { starred: !note.starred }, epoch).catch(fail); }}><svg viewBox="0 0 24 24" fill={note.starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6"><path d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2-5.7-3-5.7 3 1.1-6.2L3.2 9.6l6.1-.9z" /></svg></button>
            </div>}
          </div></div>
        </div>;
      })}
    </div>
    <footer className="suiji-footer"><span>{t("suiji.localSaved")}</span>
      {(state.page > 1 || state.nextCursor) && <div className="suiji-pagination"><button disabled={state.loading || !state.canPrevious} aria-label={t("notes.previous")} onClick={() => { void feed.back(); }}>‹</button><small>{state.page}</small><button disabled={state.loading || !state.nextCursor} aria-label={t("notes.next")} onClick={() => { void feed.next(); }}>›</button></div>}
      <button className="suiji-archive-filter" aria-pressed={state.filter === "archived"} onClick={() => choose(state.filter === "archived" ? "active" : "archived")}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 7h12v9H4zM3 3h14v4H3zM8 10h4" /></svg>{t("notes.archived")}</button><button className="suiji-trash-filter" aria-pressed={state.filter === "trash"} onClick={() => choose(state.filter === "trash" ? "active" : "trash")}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M7 5V3h6v2M5 5l1 12h8l1-12M8 8v6M12 8v6" /></svg>{t("notes.trash")}</button>
    </footer>
    {manager && <GroupManager groups={groups} refresh={refresh} close={() => setManager(false)} />}
    {context && <RecordMenu {...context} groups={groups} close={() => setContext(null)} />}
  </>;
}

export default function SuijiPage() {
  const { t } = useTranslation();
  const { coordinator, feed, error, initialize } = useNotesWorkspace();
  useEffect(() => { void initialize(); }, [initialize]);
  return <div className="phrase-page suiji-page">
    {error && <div className="notes-error" role="alert">{t(error.code, { defaultValue: t("notes.saveFailed") })}<button onClick={() => fail(null)}>{t("notes.dismiss")}</button></div>}
    {coordinator && feed ? <Workspace coordinator={coordinator} feed={feed} /> : <p role="status">{t("notes.loading")}</p>}
  </div>;
}
