import { invokeStorage } from "../../lib/storageIdentity";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useNotesWorkspace } from "../../stores/notesWorkspace";
import { changeNoteState } from "../../lib/noteActions";
import type { NoteCoordinator, NoteSession } from "../../lib/noteCoordinator";
import type { NoteFeed } from "../../lib/noteFeed";
import type { Note, NoteAction, NoteDraft, NoteFilter, NoteRef, StorageResult } from "../../types/note";
import "../../styles/notes.css";
import NoteBodyEditor from "./NoteBodyEditor";
import { useWindowVisible } from "../../lib/documentVisible";

const label = (session: NoteSession, fallback: string) => session.draft.title || session.draft.body.slice(0, 160).split(/\r?\n/)[0] || session.draft.refs[0]?.display_name || fallback;
function RecoveryRow({ coordinator, id }: { coordinator: NoteCoordinator; id: string }) {
  const { t } = useTranslation();
  const session = useSyncExternalStore((listener) => coordinator.subscribe(id, listener), () => coordinator.getSession(id));
  if (!session) return null;
  return <button className="notes-row" onClick={() => useNotesWorkspace.getState().select(id)}>
    <strong>{label(session, t("notes.untitled"))}</strong><small>{t(`notes.status.${session.status}`)}</small>
  </button>;
}
function NotesList({ coordinator, feed }: { coordinator: NoteCoordinator; feed: NoteFeed }) {
  const { t } = useTranslation();
  const windowVisible = useWindowVisible();
  const state = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const recovery = useSyncExternalStore((listener) => coordinator.subscribeBudget(listener), () => coordinator.getRecoveryIds().join("|"));
  const [search, setSearch] = useState(state.search);
  const [composing, setComposing] = useState(false);
  useEffect(() => { feed.setVisible(windowVisible); return () => feed.setVisible(false); }, [feed, windowVisible]);
  useEffect(() => {
    if (composing) return;
    const timer = setTimeout(() => { void feed.setQuery(state.filter, search).catch(useNotesWorkspace.getState().setError); }, 200);
    return () => clearTimeout(timer);
  }, [feed, state.filter, search, composing]);
  return <>
    <div className="notes-toolbar"><button onClick={() => useNotesWorkspace.getState().create()}>{t("notes.create")}</button>
      <input type="search" aria-label={t("notes.search")} placeholder={t("notes.search")} value={search} maxLength={512}
        onChange={(event) => setSearch(event.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
    </div>
    <div className="notes-toolbar" aria-label={t("notes.filters")}>
      {(["active", "archived", "trash"] as NoteFilter[]).map((filter) => <button key={filter} aria-pressed={state.filter === filter}
        onClick={() => { void feed.setQuery(filter, state.search); }}>{t(`notes.${filter}`)}</button>)}
    </div>
    {state.filter === "trash" && <p className="notes-hint">{t("notes.trashHint")}</p>}
    <div className="notes-scroll">
      {recovery && <section aria-label={t("notes.recovery")}><h3>{t("notes.recovery")}</h3>
        {recovery.split("|").map((id) => <RecoveryRow key={id} id={id} coordinator={coordinator} />)}</section>}
      {state.error && <div role="alert" className="notes-error">{t(state.error.code, { defaultValue: t("notes.readFailed") })}
        <button onClick={() => { void feed.load(); }}>{t("notes.retry")}</button></div>}
      {state.loading && <p role="status">{t("notes.loading")}</p>}
      {!state.loading && !state.error && !state.records.length && <p className="notes-hint">{t("notes.noRecords")}</p>}
      {state.records.map((note) => <button key={note.id} className="notes-row" onClick={() => { void useNotesWorkspace.getState().open(note.id); }}>
        <strong>{note.title || note.summary || t("notes.untitled")}</strong>
        <span>{note.summary}</span><small>{new Date(note.updated_at_ms).toLocaleString()} · {t("notes.referenceCount", { count: note.ref_count })}</small>
      </button>)}
    </div>
    <div className="notes-toolbar notes-pagination"><button disabled={state.loading || state.page === 1} onClick={() => { void feed.first(); }}>{t("notes.first")}</button>
      <button disabled={state.loading || !state.canPrevious} onClick={() => { void feed.back(); }}>{t("notes.previous")}</button>
      <span>{state.page}</span><button disabled={state.loading || !state.nextCursor} onClick={() => { void feed.next(); }}>{t("notes.next")}</button>
    </div>
  </>;
}
function NoteEditor({ coordinator, id }: { coordinator: NoteCoordinator; id: string }) {
  const { t } = useTranslation();
  const session = useSyncExternalStore((listener) => coordinator.subscribe(id, listener), () => coordinator.getSession(id));
  const [link, setLink] = useState("");
  const [showLink, setShowLink] = useState(false);
  const [confirmation, setConfirmation] = useState<"discard" | "reload" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  if (!session) return <button onClick={() => useNotesWorkspace.getState().back()}>{t("notes.back")}</button>;
  const readOnly = session.summary?.deleted_at_ms !== null && session.summary?.deleted_at_ms !== undefined;
  const run = async (operation: () => Promise<void>) => {
    if (busy) return;
    const current = generation.current, epoch = coordinator.storageEpoch; setBusy(true); useNotesWorkspace.getState().setError(null);
    try { await operation(); } catch (error) {
      if (current === generation.current && epoch === coordinator.storageEpoch) useNotesWorkspace.getState().setError(error);
    }
    finally { if (current === generation.current) setBusy(false); }
  };
  const edit = (patch: Partial<NoteDraft>) => { try { coordinator.edit(id, patch); return true; } catch (error) { useNotesWorkspace.getState().setError(error); return false; } };
  const state = (action: NoteAction) => run(async () => { await changeNoteState(id, action); useNotesWorkspace.getState().back(); });
  const addFiles = () => run(async () => {
    const epoch = coordinator.storageEpoch;
    const result = await invoke<StorageResult<NoteRef[]>>("select_note_files", { expectedStorageEpoch: epoch });
    if (result.storage_epoch !== coordinator.storageEpoch) throw { code: "notes.storageChanged" };
    const current = coordinator.getSession(id); if (!current) return;
    coordinator.edit(id, { refs: [...current.draft.refs, ...result.value] });
  });
  const reload = () => run(async () => {
    const result = await invoke<StorageResult<Note>>("get_note", { expectedStorageEpoch: coordinator.storageEpoch, id });
    if (result.storage_epoch !== coordinator.storageEpoch) throw { code: "notes.storageChanged" };
    await coordinator.discard(id); coordinator.load(result.value, result.storage_epoch); setConfirmation(null);
  });
  return <>
    <div className="notes-toolbar"><button onClick={() => useNotesWorkspace.getState().back()}>{t("notes.back")}</button>
      <span className="notes-save-status" role="status">{t(`notes.status.${session.status}`)}</span>
      {!readOnly && <button disabled={busy || session.composing} onClick={() => { void run(() => coordinator.flush(id)); }}>{t("notes.save")}</button>}
    </div>
    {session.error && <div className="notes-error" role="alert">{t(session.error.code, { defaultValue: t("notes.saveFailed") })}</div>}
    {session.status === "conflict" && <div className="notes-toolbar">
      <button onClick={() => { try { useNotesWorkspace.getState().select(coordinator.forkConflict(id)); } catch (error) { useNotesWorkspace.getState().setError(error); } }}>{t("notes.saveCopy")}</button>
      <button onClick={() => setConfirmation("reload")}>{t("notes.reload")}</button></div>}
    {confirmation && <div className="notes-confirm" role="alert">
      <p>{t(`notes.confirm${confirmation[0].toUpperCase()}${confirmation.slice(1)}`)}</p>
      <button disabled={busy} onClick={() => {
        if (confirmation === "reload") void reload();
        else if (confirmation === "delete") { setConfirmation(null); void state("delete"); }
        else void run(async () => { await coordinator.discard(id); useNotesWorkspace.getState().back(); });
      }}>{t("notes.confirm")}</button><button onClick={() => setConfirmation(null)}>{t("notes.cancel")}</button>
    </div>}
    <div className="notes-editor notes-scroll">
      <input className="notes-title" aria-label={t("notes.title")} placeholder={t("notes.title")} value={session.draft.title} readOnly={readOnly} maxLength={256}
        onChange={(event) => edit({ title: event.target.value })} onCompositionStart={() => coordinator.setComposing(id, true)} onCompositionEnd={() => coordinator.setComposing(id, false)} />
      <NoteBodyEditor label={t("notes.body")} value={session.draft.body} readOnly={readOnly}
        onChange={(body) => edit({ body })} onComposing={(composing) => coordinator.setComposing(id, composing)}
        onBlur={() => { void coordinator.flush(id).catch(() => {}); }}
        onTooLarge={() => useNotesWorkspace.getState().setError({ code: "notes.bodyTooLarge" })} />
      <p className="notes-hint">{t("notes.sizeHint")}</p>
      {session.source && <p className="notes-hint">{t("notes.source", { app: session.source.source_app || session.source.kind })}</p>}
      <div className="notes-refs">{session.draft.refs.map((reference) => <div className="notes-reference" key={reference.id}>
        <strong title={reference.target}>{reference.display_name || reference.target}</strong>
        <div className="notes-toolbar"><button disabled={busy} onClick={() => { void run(async () => {
          if (reference.kind === "url") await invoke("open_external_link", { url: reference.target });
          else { await coordinator.flush(id); await invoke("reveal_note_reference", { expectedStorageEpoch: coordinator.storageEpoch, id, referenceId: reference.id }); }
        }); }}>{t(reference.kind === "file" ? "notes.reveal" : "notes.openLink")}</button>
        <button onClick={() => { void run(async () => { await invokeStorage("copy_text", { text: reference.target }, coordinator.storageEpoch); }); }}>{t("notes.copyReference")}</button>
        {!readOnly && <button disabled={busy} onClick={() => edit({ refs: session.draft.refs.filter((ref) => ref.id !== reference.id) })}>{t("notes.removeReference")}</button>}</div>
      </div>)}</div>
      {!readOnly && <div className="notes-toolbar"><button disabled={busy} onClick={() => { void addFiles(); }}>{t("notes.addFile")}</button>
        <button onClick={() => setShowLink(!showLink)}>{t("notes.addLink")}</button></div>}
      {showLink && !readOnly && <form className="notes-toolbar" onSubmit={(event) => {
        event.preventDefault();
        try { const url = new URL(link); if (!/^https?:$/.test(url.protocol)) throw new Error(); }
        catch { useNotesWorkspace.getState().setError({ code: "notes.invalidRef" }); return; }
        try { coordinator.edit(id, { refs: [...session.draft.refs, { id: crypto.randomUUID(), kind: "url", target: link, display_name: link.slice(0, 512) }] }); setLink(""); setShowLink(false); }
        catch (error) { useNotesWorkspace.getState().setError(error); }
      }}><input aria-label={t("notes.linkAddress")} placeholder="https://" value={link} maxLength={32768} onChange={(event) => setLink(event.target.value)} /><button type="submit">{t("notes.addLink")}</button></form>}
    </div>
    <div className="notes-toolbar notes-actions">
      <button disabled={busy || !session.draft.body} onClick={() => { void run(async () => { await invokeStorage("copy_text", { text: session.draft.body }, coordinator.storageEpoch); }); }}>{t("notes.copyBody")}</button>
      {session.revision !== null && (readOnly ? <button disabled={busy} onClick={() => { void state("restore"); }}>{t("notes.restore")}</button> : <>
        <button disabled={busy} onClick={() => { void state(session.summary?.archived_at_ms ? "unarchive" : "archive"); }}>{t(session.summary?.archived_at_ms ? "notes.unarchive" : "notes.archive")}</button>
        <button disabled={busy} onClick={() => setConfirmation("delete")}>{t("notes.delete")}</button></>)}
      {!readOnly && <button disabled={busy} onClick={() => setConfirmation("discard")}>{t("notes.discard")}</button>}
    </div>
  </>;
}
export default function NotesPage() {
  const { t } = useTranslation();
  const { coordinator, feed, selectedId, opening, error, initialize } = useNotesWorkspace();
  useEffect(() => { void initialize(); }, [initialize]);
  return <div className="notes-page">
    {error && <div className="notes-error" role="alert">{t(error.code, { defaultValue: t("notes.saveFailed") })}<button onClick={() => useNotesWorkspace.getState().setError(null)}>{t("notes.dismiss")}</button></div>}
    {opening && <p role="status">{t("notes.loading")}</p>}
    {!coordinator || !feed ? <button onClick={() => { void initialize(); }}>{t("notes.retry")}</button> : selectedId
      ? <NoteEditor key={selectedId} id={selectedId} coordinator={coordinator} /> : <NotesList coordinator={coordinator} feed={feed} />}
  </div>;
}
