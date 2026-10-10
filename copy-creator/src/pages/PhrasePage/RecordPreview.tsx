import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LatestQuery } from "../../lib/latestQuery";
import { invokeStorage, isCurrentStorageIdentity } from "../../lib/storageIdentity";
import type { Note, NoteSummary, StorageResult } from "../../types/note";

// Preview reads never occupy the editor's recoverable draft cache.
const previews = new LatestQuery<StorageResult<Note>>();
function FullText({ note, epoch }: { note: NoteSummary; epoch: number }) {
  const { t } = useTranslation();
  const [body, setBody] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    void previews.run(`${epoch}:${note.id}:${note.revision}:${attempt}`, () => invokeStorage("get_note", { id: note.id }, epoch)).then(result => {
      if (!alive || !result || !isCurrentStorageIdentity(epoch) || result.storage_epoch !== epoch) return;
      setBody(result.value.body || note.summary);
    }).catch(() => { if (alive && isCurrentStorageIdentity(epoch)) setFailed(true); });
    return () => { alive = false; };
  }, [note.id, note.revision, note.summary, epoch, attempt]);
  if (failed) return <div className="suiji-preview-error" role="alert">{t("notes.readFailed")} <button onClick={event => { event.stopPropagation(); setFailed(false); setAttempt(value => value + 1); }}>{t("notes.retry")}</button></div>;
  return <div className="suiji-preview-text is-expanded" tabIndex={0} aria-label={t("notes.body")} aria-busy={body === null} onKeyDown={event => event.stopPropagation()}>{body ?? t("notes.loading")}</div>;
}

export default function RecordPreview({ note, epoch, expanded, toggle }: { note: NoteSummary; epoch: number; expanded: boolean; toggle(): void }) {
  const { t } = useTranslation();
  const text = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const truncated = note.char_count > Array.from(note.summary).length;
  useEffect(() => {
    const element = text.current;
    if (!element) return;
    const measure = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    void document.fonts.ready.then(measure);
    return () => observer.disconnect();
  }, [note.summary, expanded]);
  return <div className="notibody phrase-card-body">
    {expanded ? <FullText note={note} epoch={epoch} /> : <div ref={text} className={`suiji-preview-text${overflow || truncated ? " is-clipped" : ""}`}>{note.summary || t("notes.untitled")}</div>}
    {(expanded || overflow || truncated) && <button className="suiji-text-toggle" aria-expanded={expanded} onKeyDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); toggle(); }}>
      {t(expanded ? "suiji.collapseText" : "suiji.expandText")}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>}
  </div>;
}
