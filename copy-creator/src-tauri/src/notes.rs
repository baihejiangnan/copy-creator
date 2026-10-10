//! Notes are independent snapshots, never part of clipboard retention or capacity cleanup.
use crate::db::DbState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, OnceLock,
};
use std::time::Instant;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Semaphore;

const MAX_BODY_BYTES: usize = 256 * 1024;
const MAX_REFS: usize = 20;
const TRASH_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;

pub(crate) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
        summary TEXT NOT NULL, char_count INTEGER NOT NULL, byte_count INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK(revision > 0),
        archived_at_ms INTEGER, deleted_at_ms INTEGER, source_json TEXT,
        creation_mutation_id TEXT NOT NULL UNIQUE, creation_hash TEXT NOT NULL,
        last_mutation_id TEXT NOT NULL, last_mutation_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS note_refs (
        id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('file','url')), target TEXT NOT NULL,
        display_name TEXT NOT NULL, sort_order INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_note_refs_note ON note_refs(note_id, sort_order);
    CREATE INDEX IF NOT EXISTS idx_notes_active ON notes(updated_at_ms DESC, id DESC)
        WHERE deleted_at_ms IS NULL AND archived_at_ms IS NULL;
    CREATE INDEX IF NOT EXISTS idx_notes_archive ON notes(updated_at_ms DESC, id DESC)
        WHERE deleted_at_ms IS NULL AND archived_at_ms IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_notes_trash ON notes(deleted_at_ms DESC, id DESC)
        WHERE deleted_at_ms IS NOT NULL;",
    )?;
    crate::suiji::init_schema(conn)
}

#[derive(Debug, Serialize)]
pub struct NoteError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_revision: Option<i64>,
}
type Result<T> = std::result::Result<T, NoteError>;
fn error(code: &'static str) -> NoteError {
    NoteError {
        code,
        current_revision: None,
    }
}
fn database_error(e: rusqlite::Error) -> NoteError {
    log::warn!("notes database operation failed: {e}");
    error("notes.databaseFailed")
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NoteRef {
    pub id: String,
    pub kind: String,
    pub target: String,
    pub display_name: String,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct NoteDraft {
    pub title: String,
    pub body: String,
    pub refs: Vec<NoteRef>,
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct NoteSource {
    pub kind: String,
    pub record_id: String,
    pub source_app: String,
    pub captured_at_ms: i64,
}
#[derive(Debug, Clone, Serialize)]
pub struct NoteSummary {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub char_count: i64,
    pub byte_count: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub revision: i64,
    pub archived_at_ms: Option<i64>,
    pub deleted_at_ms: Option<i64>,
    pub ref_count: i64,
    pub group_id: Option<String>,
    pub starred: bool,
}
#[derive(Debug, Clone, Serialize)]
pub struct Note {
    #[serde(flatten)]
    pub summary: NoteSummary,
    pub body: String,
    pub refs: Vec<NoteRef>,
    pub source: Option<NoteSource>,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteFilter {
    Active,
    Ungrouped,
    Starred,
    Archived,
    Trash,
}
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteSort {
    Updated,
    Created,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NoteCursor {
    pub sort_at_ms: i64,
    pub id: String,
}
#[derive(Serialize)]
pub struct NotePage {
    pub records: Vec<NoteSummary>,
    pub next_cursor: Option<NoteCursor>,
}
#[derive(Serialize)]
pub struct StorageResult<T> {
    pub storage_epoch: u64,
    pub value: T,
}
#[derive(Debug, Serialize)]
pub struct MutationResult {
    pub note: Note,
    pub mutation_id: String,
    pub applied: bool,
}

fn valid_id(id: &str) -> Result<()> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(error("notes.invalidId"));
    }
    Ok(())
}
pub(crate) fn validate(draft: &NoteDraft) -> Result<()> {
    if draft.body.len() > MAX_BODY_BYTES {
        return Err(error("notes.bodyTooLarge"));
    }
    if draft.title.chars().count() > 128 {
        return Err(error("notes.titleTooLong"));
    }
    if draft.refs.len() > MAX_REFS {
        return Err(error("notes.tooManyRefs"));
    }
    let mut ids = std::collections::HashSet::new();
    for reference in &draft.refs {
        valid_id(&reference.id)?;
        if !ids.insert(&reference.id) {
            return Err(error("notes.duplicateRef"));
        }
        if reference.target.len() > 32 * 1024
            || reference.target.contains('\0')
            || reference.display_name.chars().count() > 512
        {
            return Err(error("notes.invalidRef"));
        }
        match reference.kind.as_str() {
            "file" if std::path::Path::new(&reference.target).is_absolute() => (),
            "url"
                if reqwest::Url::parse(&reference.target)
                    .map(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
                    .unwrap_or(false) =>
            {
                ()
            }
            _ => return Err(error("notes.invalidRef")),
        }
    }
    Ok(())
}
pub(crate) fn hash(value: &impl Serialize) -> Result<String> {
    let bytes = serde_json::to_vec(value).map_err(|_| error("notes.invalidRequest"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteSummary> {
    Ok(NoteSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        summary: row.get(2)?,
        char_count: row.get(3)?,
        byte_count: row.get(4)?,
        created_at_ms: row.get(5)?,
        updated_at_ms: row.get(6)?,
        revision: row.get(7)?,
        archived_at_ms: row.get(8)?,
        deleted_at_ms: row.get(9)?,
        ref_count: row.get(10)?,
        group_id: row.get(11)?,
        starred: row.get(12)?,
    })
}
const SUMMARY_COLUMNS: &str = "n.id,n.title,n.summary,n.char_count,n.byte_count,n.created_at_ms,
    n.updated_at_ms,n.revision,n.archived_at_ms,n.deleted_at_ms,
    (SELECT COUNT(*) FROM note_refs r WHERE r.note_id=n.id),
    (SELECT group_id FROM note_organization o WHERE o.note_id=n.id),
    COALESCE((SELECT starred FROM note_organization o WHERE o.note_id=n.id),0)";

pub(crate) fn read_note(conn: &Connection, id: &str) -> Result<Note> {
    let (summary, body, source_json): (NoteSummary, String, Option<String>) = conn
        .query_row(
            &format!("SELECT {SUMMARY_COLUMNS},n.body,n.source_json FROM notes n WHERE n.id=?1"),
            [id],
            |row| Ok((summary_row(row)?, row.get(13)?, row.get(14)?)),
        )
        .optional()
        .map_err(database_error)?
        .ok_or_else(|| error("notes.notFound"))?;
    let refs = conn.prepare("SELECT id,kind,target,display_name FROM note_refs WHERE note_id=?1 ORDER BY sort_order,id")
        .map_err(database_error)?.query_map([id], |row| Ok(NoteRef {
            id: row.get(0)?, kind: row.get(1)?, target: row.get(2)?, display_name: row.get(3)?,
        })).map_err(database_error)?.collect::<rusqlite::Result<_>>().map_err(database_error)?;
    let source = source_json
        .map(|json| serde_json::from_str(&json))
        .transpose()
        .map_err(|_| error("notes.invalidData"))?;
    Ok(Note {
        summary,
        body,
        refs,
        source,
    })
}
fn literal_pattern(search: &str) -> String {
    format!(
        "%{}%",
        search
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}
fn read_page(
    conn: &Connection,
    filter: NoteFilter,
    search: &str,
    cursor: Option<NoteCursor>,
    limit: usize,
) -> Result<NotePage> {
    read_scoped_page(conn, filter, search, cursor, limit, None)
}
fn read_scoped_page(conn: &Connection, filter: NoteFilter, search: &str, cursor: Option<NoteCursor>, limit: usize, group_id: Option<String>) -> Result<NotePage> {
    read_sorted_page(conn, filter, search, cursor, limit, group_id, None)
}
fn read_sorted_page(conn: &Connection, filter: NoteFilter, search: &str, cursor: Option<NoteCursor>, limit: usize, group_id: Option<String>, order: Option<NoteSort>) -> Result<NotePage> {
    if search.chars().count() > 256 {
        return Err(error("notes.searchTooLong"));
    }
    let candidates = if search.is_empty() { None } else {
        crate::note_search::candidates(conn, search).map_err(database_error)?
    };
    if matches!(&candidates, Some(ids) if ids.is_empty()) {
        return Ok(NotePage { records: Vec::new(), next_cursor: None });
    }
    let candidate_filter = if candidates.is_some() {
        "AND n.rowid IN (SELECT value FROM json_each(?7))"
    } else { "AND ?7 IS NULL" };
    let candidate_json = candidates.map(|ids| serde_json::to_string(&ids).unwrap());
    let (condition, sort) = match filter {
        NoteFilter::Active => (
            "n.deleted_at_ms IS NULL AND n.archived_at_ms IS NULL",
            "n.updated_at_ms",
        ),
        NoteFilter::Ungrouped => ("n.deleted_at_ms IS NULL AND n.archived_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM note_organization o WHERE o.note_id=n.id AND o.group_id IS NOT NULL)", "n.updated_at_ms"),
        NoteFilter::Starred => ("n.deleted_at_ms IS NULL AND n.archived_at_ms IS NULL AND EXISTS(SELECT 1 FROM note_organization o WHERE o.note_id=n.id AND o.starred=1)", "n.updated_at_ms"),
        NoteFilter::Archived => (
            "n.deleted_at_ms IS NULL AND n.archived_at_ms IS NOT NULL",
            "n.updated_at_ms",
        ),
        NoteFilter::Trash => (
            "n.deleted_at_ms IS NOT NULL AND n.deleted_at_ms > ?5",
            "n.deleted_at_ms",
        ),
    };
    let sort = match order {
        Some(NoteSort::Created) => "n.created_at_ms",
        Some(NoteSort::Updated) => "n.updated_at_ms",
        None => sort,
    };
    let sql = format!(
        "SELECT {SUMMARY_COLUMNS} FROM notes n WHERE {condition} {candidate_filter}
        AND (?1='' OR n.title LIKE ?2 ESCAPE '\\' OR n.body LIKE ?2 ESCAPE '\\'
            OR EXISTS(SELECT 1 FROM note_refs r WHERE r.note_id=n.id AND
                (r.display_name LIKE ?2 ESCAPE '\\' OR r.target LIKE ?2 ESCAPE '\\')))
        AND (?3 IS NULL OR {sort} < ?3 OR ({sort}=?3 AND n.id < ?4))
        AND (?8 IS NULL OR EXISTS(SELECT 1 FROM note_organization o WHERE o.note_id=n.id AND o.group_id=?8))
        AND ?5 IS NOT NULL ORDER BY {sort} DESC,n.id DESC LIMIT ?6"
    );
    let limit = limit.clamp(1, 100);
    let (at, id) = cursor
        .map(|c| (Some(c.sort_at_ms), c.id))
        .unwrap_or((None, String::new()));
    let mut records: Vec<NoteSummary> = conn
        .prepare(&sql)
        .map_err(database_error)?
        .query_map(
            params![
                search,
                literal_pattern(search),
                at,
                id,
                chrono::Utc::now().timestamp_millis() - TRASH_RETENTION_MS,
                (limit + 1) as i64,
                candidate_json,
                group_id
            ],
            summary_row,
        )
        .map_err(database_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(database_error)?;
    let has_more = records.len() > limit;
    records.truncate(limit);
    let next_cursor = if has_more {
        records.last().map(|last| NoteCursor {
            sort_at_ms: match order {
                Some(NoteSort::Created) => last.created_at_ms,
                Some(NoteSort::Updated) => last.updated_at_ms,
                None if matches!(filter, NoteFilter::Trash) => last.deleted_at_ms.unwrap(),
                None => last.updated_at_ms,
            },
            id: last.id.clone(),
        })
    } else {
        None
    };
    Ok(NotePage {
        records,
        next_cursor,
    })
}
pub(crate) fn write_refs(conn: &Connection, id: &str, refs: &[NoteRef]) -> Result<()> {
    conn.execute("DELETE FROM note_refs WHERE note_id=?1", [id])
        .map_err(database_error)?;
    for (index, reference) in refs.iter().enumerate() {
        conn.execute("INSERT INTO note_refs(id,note_id,kind,target,display_name,sort_order) VALUES (?1,?2,?3,?4,?5,?6)",
            params![reference.id,id,reference.kind,reference.target,reference.display_name,index as i64]).map_err(database_error)?;
    }
    Ok(())
}
pub(crate) fn derived(draft: &NoteDraft) -> (String, i64, i64) {
    let summary = if draft.body.is_empty() {
        draft
            .refs
            .first()
            .map(|r| r.display_name.chars().take(160).collect())
            .unwrap_or_default()
    } else {
        draft.body.chars().take(160).collect()
    };
    (
        summary,
        draft.body.chars().count() as i64,
        draft.body.len() as i64,
    )
}
fn existing_creation(
    conn: &Connection,
    id: &str,
    mutation_id: &str,
    request_hash: &str,
) -> Result<Option<MutationResult>> {
    let existing: Option<(String, String, String)> = conn.query_row(
        "SELECT id,creation_mutation_id,creation_hash FROM notes WHERE id=?1 OR creation_mutation_id=?2",
        params![id,mutation_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
    ).optional().map_err(database_error)?;
    match existing {
        Some((existing_id, creation, stored_hash))
            if existing_id == id && creation == mutation_id && stored_hash == request_hash =>
        {
            Ok(Some(MutationResult {
                note: read_note(conn, id)?,
                mutation_id: mutation_id.into(),
                applied: false,
            }))
        }
        Some(_) => Err(error("notes.mutationMismatch")),
        None => Ok(None),
    }
}
fn insert_note(
    conn: &mut Connection,
    id: &str,
    mutation_id: &str,
    draft: &NoteDraft,
    source: Option<NoteSource>,
    request_hash: &str,
) -> Result<MutationResult> {
    valid_id(id)?;
    valid_id(mutation_id)?;
    validate(draft)?;
    if let Some(result) = existing_creation(conn, id, mutation_id, request_hash)? {
        return Ok(result);
    }
    if draft.body.is_empty() && draft.refs.is_empty() {
        return Err(error("notes.emptyDraft"));
    }
    let (summary, chars, bytes) = derived(draft);
    let source = source
        .map(|s| serde_json::to_string(&s))
        .transpose()
        .map_err(|_| error("notes.invalidRequest"))?;
    let now = chrono::Utc::now().timestamp_millis();
    let tx = conn.transaction().map_err(database_error)?;
    tx.execute("INSERT INTO notes(id,title,body,summary,char_count,byte_count,created_at_ms,updated_at_ms,revision,
        source_json,creation_mutation_id,creation_hash,last_mutation_id,last_mutation_hash)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?7,1,?8,?9,?10,?9,?10)",
        params![id,draft.title,draft.body,summary,chars,bytes,now,source,mutation_id,request_hash]).map_err(database_error)?;
    write_refs(&tx, id, &draft.refs)?;
    let note = read_note(&tx, id)?;
    tx.commit().map_err(database_error)?;
    Ok(MutationResult {
        note,
        mutation_id: mutation_id.into(),
        applied: true,
    })
}
fn check_mutation(
    conn: &Connection,
    id: &str,
    revision: i64,
    mutation_id: &str,
    request_hash: &str,
) -> Result<Option<MutationResult>> {
    valid_id(id)?;
    valid_id(mutation_id)?;
    let (current, last_id, last_hash): (i64, String, String) = conn
        .query_row(
            "SELECT revision,last_mutation_id,last_mutation_hash FROM notes WHERE id=?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(database_error)?
        .ok_or_else(|| error("notes.notFound"))?;
    if last_id == mutation_id {
        if last_hash != request_hash {
            return Err(error("notes.mutationMismatch"));
        }
        return Ok(Some(MutationResult {
            note: read_note(conn, id)?,
            mutation_id: mutation_id.into(),
            applied: false,
        }));
    }
    if current != revision {
        return Err(NoteError {
            code: "notes.conflict",
            current_revision: Some(current),
        });
    }
    // Creation IDs remain immutable even after a subsequent save changes last_mutation_id.
    let creation_reused: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE creation_mutation_id=?1)",
            [mutation_id],
            |r| r.get(0),
        )
        .map_err(database_error)?;
    if creation_reused {
        return Err(error("notes.mutationMismatch"));
    }
    Ok(None)
}
fn update_note(
    conn: &mut Connection,
    id: &str,
    revision: i64,
    mutation_id: &str,
    draft: &NoteDraft,
) -> Result<MutationResult> {
    validate(draft)?;
    let request_hash = hash(&("save", id, revision, draft))?;
    let tx = conn.transaction().map_err(database_error)?;
    if let Some(result) = check_mutation(&tx, id, revision, mutation_id, &request_hash)? {
        return Ok(result);
    }
    let (summary, chars, bytes) = derived(draft);
    let changed = tx
        .execute(
            "UPDATE notes SET title=?1,body=?2,summary=?3,char_count=?4,byte_count=?5,
        updated_at_ms=?6,revision=revision+1,last_mutation_id=?7,last_mutation_hash=?8
        WHERE id=?9 AND revision=?10 AND deleted_at_ms IS NULL",
            params![
                draft.title,
                draft.body,
                summary,
                chars,
                bytes,
                chrono::Utc::now().timestamp_millis(),
                mutation_id,
                request_hash,
                id,
                revision
            ],
        )
        .map_err(database_error)?;
    if changed != 1 {
        return Err(error("notes.deleted"));
    }
    write_refs(&tx, id, &draft.refs)?;
    let note = read_note(&tx, id)?;
    tx.commit().map_err(database_error)?;
    Ok(MutationResult {
        note,
        mutation_id: mutation_id.into(),
        applied: true,
    })
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteAction {
    Archive,
    Unarchive,
    Delete,
    Restore,
}
fn change_state(
    conn: &mut Connection,
    id: &str,
    revision: i64,
    mutation_id: &str,
    action: NoteAction,
) -> Result<MutationResult> {
    let request_hash = hash(&("state", id, revision, action))?;
    let tx = conn.transaction().map_err(database_error)?;
    if let Some(result) = check_mutation(&tx, id, revision, mutation_id, &request_hash)? {
        return Ok(result);
    }
    let now = chrono::Utc::now().timestamp_millis();
    let (assignment, condition) = match action {
        NoteAction::Archive => ("archived_at_ms=?4", "deleted_at_ms IS NULL"),
        NoteAction::Unarchive => ("archived_at_ms=NULL", "deleted_at_ms IS NULL"),
        NoteAction::Delete => ("deleted_at_ms=?4", "deleted_at_ms IS NULL"),
        NoteAction::Restore => (
            "deleted_at_ms=NULL",
            "deleted_at_ms IS NOT NULL AND deleted_at_ms > ?4-604800000",
        ),
    };
    let sql = format!(
        "UPDATE notes SET {assignment},revision=revision+1,updated_at_ms=?4,
        last_mutation_id=?2,last_mutation_hash=?3 WHERE id=?1 AND revision=?5 AND {condition}"
    );
    if tx
        .execute(&sql, params![id, mutation_id, request_hash, now, revision])
        .map_err(database_error)?
        != 1
    {
        return Err(error("notes.invalidState"));
    }
    let note = read_note(&tx, id)?;
    tx.commit().map_err(database_error)?;
    Ok(MutationResult {
        note,
        mutation_id: mutation_id.into(),
        applied: true,
    })
}
fn capture(conn: &mut Connection, record_id: &str, mutation_id: &str) -> Result<MutationResult> {
    valid_id(record_id)?;
    valid_id(mutation_id)?;
    // The request identity is independent of a mutable/deleted clipboard record.
    let request_hash = hash(&("capture", record_id))?;
    if let Some(result) = existing_creation(conn, mutation_id, mutation_id, &request_hash)? {
        return Ok(result);
    }
    let (kind, content, source_app, user_key, labeled): (String, String, String, bool, bool) = conn
        .query_row(
            "SELECT type,content,COALESCE(source_app,''),COALESCE(user_api_key,0),
        EXISTS(SELECT 1 FROM api_key_labels WHERE record_id=?1) FROM clipboard_records WHERE id=?1",
            [record_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(database_error)?
        .ok_or_else(|| error("notes.sourceNotFound"))?;
    if user_key
        || labeled
        || crate::secrets::is_protected(&content)
        || (matches!(kind.as_str(), "text" | "link") && crate::db::is_api_key(&content))
    {
        return Err(error("notes.protectedSource"));
    }
    let mut draft = NoteDraft {
        title: String::new(),
        body: String::new(),
        refs: vec![],
    };
    match kind.as_str() {
        "text" => draft.body = content,
        "link" => {
            draft.refs.push(NoteRef {
                id: uuid::Uuid::new_v4().to_string(),
                kind: "url".into(),
                target: content.clone(),
                display_name: content.chars().take(512).collect(),
            });
            draft.body = content;
        }
        "file" | "explorer" if std::path::Path::new(&content).is_absolute() => {
            let display_name = std::path::Path::new(&content)
                .file_name()
                .map(|s| s.to_string_lossy().chars().take(512).collect())
                .unwrap_or_else(|| content.chars().take(512).collect());
            draft.refs.push(NoteRef {
                id: uuid::Uuid::new_v4().to_string(),
                kind: "file".into(),
                target: content,
                display_name,
            });
        }
        _ => return Err(error("notes.unsupportedSource")),
    }
    insert_note(
        conn,
        mutation_id,
        mutation_id,
        &draft,
        Some(NoteSource {
            kind,
            record_id: record_id.into(),
            source_app,
            captured_at_ms: chrono::Utc::now().timestamp_millis(),
        }),
        &request_hash,
    )
}

// Reject excess work before spawn_blocking. Writes have 32 accepted slots, reads 4.
// Queries yield while writes are queued; each query is bounded by request limits.
struct Scheduler {
    reads: Arc<Semaphore>,
    writes: Arc<Semaphore>,
    pending_writes: AtomicUsize,
}
fn scheduler() -> &'static Scheduler {
    static SCHEDULER: OnceLock<Scheduler> = OnceLock::new();
    SCHEDULER.get_or_init(|| Scheduler {
        reads: Arc::new(Semaphore::new(4)),
        writes: Arc::new(Semaphore::new(32)),
        pending_writes: AtomicUsize::new(0),
    })
}
pub(crate) async fn drain_accepted_writes() -> std::result::Result<(), String> {
    let permits = scheduler().writes.clone().acquire_many_owned(32).await.map_err(|_| "lifecycle.failed")?;
    drop(permits);
    Ok(())
}
fn prune_deleted(conn: &Connection, now: i64, limit: usize) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM notes WHERE id IN (SELECT id FROM notes WHERE deleted_at_ms IS NOT NULL AND deleted_at_ms<=?1 ORDER BY deleted_at_ms,id LIMIT ?2)",
        params![now.saturating_sub(TRASH_RETENTION_MS),limit.clamp(1,100) as i64])
}
pub(crate) fn writes_pending() -> bool {
    scheduler().pending_writes.load(Ordering::SeqCst) > 0
}
pub(crate) fn prune_expired(app: &AppHandle) -> std::result::Result<bool, ()> {
    if writes_pending() { return Ok(false); }
    let state = app.state::<DbState>();
    let waiting = Instant::now();
    let mut conn = match state.conn.try_lock() {
        Ok(conn) => conn,
        Err(std::sync::TryLockError::WouldBlock) => return Ok(false),
        Err(_) => return Err(()),
    };
    let lock_wait_us = waiting.elapsed().as_micros();
    if writes_pending() { return Ok(false); }
    let epoch = state.storage_epoch.load(Ordering::Relaxed);
    let executing = Instant::now();
    let (result, sql) = crate::db_metrics::measure(&mut conn, |conn|
        prune_deleted(conn, chrono::Utc::now().timestamp_millis(), 100));
    let held_us = executing.elapsed().as_micros();
    drop(conn);
    if let Some(metrics) = sql {
        log::debug!(target: "copy_creator::metrics", "cleanup operation=notes_ttl ok={} queued_us=0 lock_wait_us={lock_wait_us} held_us={held_us} sql_count={} sql_profile_ms={}", result.is_ok(), metrics.statements, metrics.elapsed_ms);
    }
    match result {
        Ok(removed) => {
            if removed > 0 { let _ = app.emit("notes-pruned", serde_json::json!({"storage_epoch":epoch,"removed":removed})); }
            Ok(removed < 100)
        }
        Err(_) => { log::warn!("expired note cleanup failed"); Err(()) }
    }
}

pub(crate) fn check_epoch(state: &DbState, expected_epoch: u64) -> Result<u64> {
    let epoch = state.storage_epoch.load(Ordering::Relaxed);
    if epoch != expected_epoch {
        return Err(error("notes.storageChanged"));
    }
    Ok(epoch)
}
struct PendingWrite(bool);
impl Drop for PendingWrite {
    fn drop(&mut self) {
        if self.0 {
            scheduler().pending_writes.fetch_sub(1, Ordering::SeqCst);
        }
    }
}
async fn run<T: Send + 'static>(
    app: AppHandle,
    expected_epoch: u64,
    write: bool,
    operation: &'static str,
    action: impl FnOnce(&mut Connection) -> Result<T> + Send + 'static,
) -> Result<StorageResult<T>> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let acceptance = lifecycle.try_producer().ok_or_else(|| error("notes.busy"))?;
    let scheduler = scheduler();
    if !write && scheduler.pending_writes.load(Ordering::SeqCst) > 0 {
        return Err(error("notes.busy"));
    }
    let permit = (if write {
        &scheduler.writes
    } else {
        &scheduler.reads
    })
    .clone()
    .try_acquire_owned()
    .map_err(|_| error("notes.busy"))?;
    if write {
        scheduler.pending_writes.fetch_add(1, Ordering::SeqCst);
    }
    let pending = PendingWrite(write);
    let accepted = Instant::now();
    drop(acceptance);
    drop(lifecycle);
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let _pending = pending;
        let queued_us = accepted.elapsed().as_micros();
        let state = app.state::<DbState>();
        let waiting = Instant::now();
        let mut conn = state.conn.lock().map_err(|_| error("notes.databaseFailed"))?;
        let lock_wait_us = waiting.elapsed().as_micros();
        let epoch = check_epoch(&state, expected_epoch)?;
        let executing = Instant::now();
        let (value, sql) = crate::db_metrics::measure(&mut conn, action);
        let held_us = executing.elapsed().as_micros();
        drop(conn);
        if let Some(metrics) = sql {
            log::debug!(target: "copy_creator::metrics", "notes operation={operation} write={write} ok={} queued_us={queued_us} lock_wait_us={lock_wait_us} held_us={held_us} sql_count={} sql_profile_ms={}", value.is_ok(), metrics.statements, metrics.elapsed_ms);
        } else {
            log::debug!(target: "copy_creator::metrics", "notes operation={operation} write={write} ok={} queued_us={queued_us} lock_wait_us={lock_wait_us} held_us={held_us} sql_count=unavailable sql_profile_ms=unavailable", value.is_ok());
        }
        value.map(|value| StorageResult { storage_epoch: epoch, value })
    }).await.map_err(|_| error("notes.workerFailed"))?
}
fn change_event(result: &StorageResult<MutationResult>, kind: &str) -> Option<serde_json::Value> {
    result.value.applied.then(|| serde_json::json!({
        "storage_epoch":result.storage_epoch,"id":result.value.note.summary.id,
        "revision":result.value.note.summary.revision,"mutation_id":result.value.mutation_id,"change_kind":kind,
    }))
}
fn notify(app: &AppHandle, result: &StorageResult<MutationResult>, kind: &str) {
    if let Some(payload) = change_event(result, kind) {
        let _ = app.emit("notes-changed", payload);
    }
}
#[tauri::command]
pub async fn list_notes(
    app: AppHandle,
    expected_storage_epoch: u64,
    filter: NoteFilter,
    search: String,
    cursor: Option<NoteCursor>,
    limit: Option<usize>,
) -> Result<StorageResult<NotePage>> {
    run(app, expected_storage_epoch, false, "list", move |conn| {
        read_page(conn, filter, &search, cursor, limit.unwrap_or(50))
    })
    .await
}
#[tauri::command]
pub async fn list_suiji(app: AppHandle, expected_storage_epoch: u64, filter: NoteFilter, search: String, cursor: Option<NoteCursor>, limit: Option<usize>, group_id: Option<String>, sort: Option<NoteSort>) -> Result<StorageResult<NotePage>> {
    run(app, expected_storage_epoch, false, "suiji_list", move |conn| read_sorted_page(conn, filter, &search, cursor, limit.unwrap_or(50), group_id, sort)).await
}
fn organize_conn(conn: &mut Connection, id: &str, expected_revision: i64, mutation_id: &str, group_id: Option<String>, starred: bool) -> Result<MutationResult> {
    valid_id(id)?; valid_id(mutation_id)?;
        let tx = conn.transaction().map_err(database_error)?;
        let note = read_note(&tx, &id)?;
        let hash = hash(&("organize", &id, expected_revision, &group_id, starred))?;
        let (last_id, last_hash): (String,String) = tx.query_row("SELECT last_mutation_id,last_mutation_hash FROM notes WHERE id=?1", [&id], |r| Ok((r.get(0)?,r.get(1)?))).map_err(database_error)?;
        if last_id == mutation_id {
            if last_hash != hash { return Err(error("notes.mutationMismatch")); }
            return Ok(MutationResult { note, mutation_id: mutation_id.into(), applied: false });
        }
        if note.summary.revision != expected_revision { return Err(NoteError {code:"notes.conflict",current_revision:Some(note.summary.revision)}); }
        if note.summary.deleted_at_ms.is_some() { return Err(error("notes.deleted")); }
        if let Some(group) = &group_id {
            let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM phrase_groups WHERE id=?1)",[group],|r|r.get(0)).map_err(database_error)?;
            if !exists { return Err(error("notes.groupMissing")); }
        }
        tx.execute("INSERT INTO note_organization(note_id,group_id,starred) VALUES(?1,?2,?3) ON CONFLICT(note_id) DO UPDATE SET group_id=excluded.group_id,starred=excluded.starred",params![id,group_id,starred]).map_err(database_error)?;
        tx.execute("UPDATE notes SET revision=revision+1,updated_at_ms=?2,last_mutation_id=?3,last_mutation_hash=?4 WHERE id=?1",params![id,chrono::Utc::now().timestamp_millis(),mutation_id,hash]).map_err(database_error)?;
        let note = read_note(&tx,&id)?; tx.commit().map_err(database_error)?;
        Ok(MutationResult {note,mutation_id: mutation_id.into(),applied:true})
}
#[tauri::command]
pub async fn organize_note(app: AppHandle, expected_storage_epoch: u64, id: String, expected_revision: i64, mutation_id: String, group_id: Option<String>, starred: bool) -> Result<StorageResult<MutationResult>> {
    let result = run(app.clone(), expected_storage_epoch, true, "organize", move |conn| {
        organize_conn(conn, &id, expected_revision, &mutation_id, group_id, starred)
    }).await?;
    notify(&app,&result,"organization"); Ok(result)
}
#[tauri::command]
pub async fn get_note(
    app: AppHandle,
    expected_storage_epoch: u64,
    id: String,
) -> Result<StorageResult<Note>> {
    valid_id(&id)?;
    run(app, expected_storage_epoch, false, "get", move |conn| {
        read_note(conn, &id)
    })
    .await
}
#[tauri::command]
pub async fn create_note(
    app: AppHandle,
    expected_storage_epoch: u64,
    id: String,
    mutation_id: String,
    draft: NoteDraft,
) -> Result<StorageResult<MutationResult>> {
    let result = run(app.clone(), expected_storage_epoch, true, "create", move |conn| {
        let request_hash = hash(&("create", &id, &draft))?;
        insert_note(conn, &id, &mutation_id, &draft, None, &request_hash)
    })
    .await?;
    notify(&app, &result, "create");
    Ok(result)
}
#[tauri::command]
pub async fn save_note(
    app: AppHandle,
    expected_storage_epoch: u64,
    id: String,
    expected_revision: i64,
    mutation_id: String,
    draft: NoteDraft,
) -> Result<StorageResult<MutationResult>> {
    let result = run(app.clone(), expected_storage_epoch, true, "save", move |conn| {
        update_note(conn, &id, expected_revision, &mutation_id, &draft)
    })
    .await?;
    notify(&app, &result, "save");
    Ok(result)
}
#[tauri::command]
pub async fn set_note_state(
    app: AppHandle,
    expected_storage_epoch: u64,
    id: String,
    expected_revision: i64,
    mutation_id: String,
    action: NoteAction,
) -> Result<StorageResult<MutationResult>> {
    let result = run(app.clone(), expected_storage_epoch, true, "state", move |conn| {
        change_state(conn, &id, expected_revision, &mutation_id, action)
    })
    .await?;
    notify(&app, &result, "state");
    Ok(result)
}
#[tauri::command]
pub async fn capture_clipboard_as_note(
    app: AppHandle,
    expected_storage_epoch: u64,
    record_id: String,
    mutation_id: String,
) -> Result<StorageResult<MutationResult>> {
    let result = run(app.clone(), expected_storage_epoch, true, "capture", move |conn| {
        capture(conn, &record_id, &mutation_id)
    })
    .await?;
    notify(&app, &result, "capture");
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::initialize_connection(&mut conn).unwrap();
        conn
    }
    fn draft(body: &str) -> NoteDraft {
        NoteDraft {
            title: String::new(),
            body: body.into(),
            refs: vec![],
        }
    }
    fn create(conn: &mut Connection, draft: &NoteDraft) -> MutationResult {
        let note_id = id();
        let mutation_id = id();
        insert_note(
            conn,
            &note_id,
            &mutation_id,
            draft,
            None,
            &hash(&("create", &note_id, draft)).unwrap(),
        )
        .unwrap()
    }
    fn url_ref() -> NoteRef {
        NoteRef {
            id: id(),
            kind: "url".into(),
            target: "https://example.com/a".into(),
            display_name: "Reference".into(),
        }
    }
    #[test]
    fn radial_suiji_queries_include_promoted_phrases_and_new_ungrouped_notes() {
        let mut conn = db();
        let group = id();
        let legacy = id();
        conn.execute("INSERT INTO phrase_groups VALUES(?1,'legacy',0,'now','now')", [&group]).unwrap();
        conn.execute("INSERT INTO phrases VALUES(?1,?2,'old','  original\r\n  ',0,'2026-01-01','2026-01-02')", params![legacy, group]).unwrap();
        crate::note_backup::promote_phrases(&conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM phrases", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(crate::suiji::groups(&conn).unwrap()[0].count, 1);
        let grouped = read_sorted_page(&conn, NoteFilter::Active, "", None, 50, Some(group), Some(NoteSort::Updated)).unwrap();
        assert_eq!(grouped.records.len(), 1);
        assert_eq!(read_note(&conn, &grouped.records[0].id).unwrap().body, "  original\r\n  ");
        let fresh = create(&mut conn, &draft("new full body")).note.summary.id;
        let ungrouped = read_sorted_page(&conn, NoteFilter::Ungrouped, "", None, 50, None, Some(NoteSort::Updated)).unwrap();
        assert_eq!(ungrouped.records.len(), 1);
        assert_eq!(ungrouped.records[0].id, fresh);
        assert_eq!(read_note(&conn, &fresh).unwrap().body, "new full body");
    }
    #[test]
    fn selected_sort_pages_all_scopes_without_skips_or_duplicates() {
        let mut conn = db();
        let group = id();
        conn.execute("INSERT INTO phrase_groups VALUES(?1,'sort group',0,'now','now')", [&group]).unwrap();
        let mut expected = Vec::new();
        for (created, updated) in [(300,100),(300,200),(200,300),(100,300),(100,100)] {
            let note_id = create(&mut conn, &draft("needle sort fixture")).note.summary.id;
            conn.execute("UPDATE notes SET created_at_ms=?1,updated_at_ms=?2 WHERE id=?3", params![created,updated,&note_id]).unwrap();
            conn.execute("INSERT INTO note_organization(note_id,group_id,starred) VALUES(?1,?2,1)", params![&note_id,&group]).unwrap();
            expected.push((created,updated,note_id));
        }
        for filter in [NoteFilter::Active,NoteFilter::Archived,NoteFilter::Trash,NoteFilter::Starred,NoteFilter::Ungrouped] {
            let archived = matches!(filter,NoteFilter::Archived).then_some(1_i64);
            let deleted = matches!(filter,NoteFilter::Trash).then_some(chrono::Utc::now().timestamp_millis());
            conn.execute("UPDATE notes SET archived_at_ms=?1,deleted_at_ms=?2",params![archived,deleted]).unwrap();
            let scope = if matches!(filter,NoteFilter::Ungrouped) { None } else { Some(group.clone()) };
            conn.execute("UPDATE note_organization SET group_id=?1",[&scope]).unwrap();
            for order in [NoteSort::Updated,NoteSort::Created] {
                let mut expected = expected.clone();
                expected.sort_by(|a,b| {
                    let at = |x: &(i64,i64,String)| if matches!(order,NoteSort::Created) { x.0 } else { x.1 };
                    at(b).cmp(&at(a)).then_with(|| b.2.cmp(&a.2))
                });
                let mut cursor = None;
                let mut found = Vec::new();
                loop {
                    let page = read_sorted_page(&conn,filter,"needle",cursor,2,scope.clone(),Some(order)).unwrap();
                    if let Some(next) = &page.next_cursor {
                        let last = page.records.last().unwrap();
                        assert_eq!(next.sort_at_ms,if matches!(order,NoteSort::Created) { last.created_at_ms } else { last.updated_at_ms });
                    }
                    found.extend(page.records.into_iter().map(|note| note.id));
                    if page.next_cursor.is_none() { break; }
                    cursor = page.next_cursor;
                }
                assert_eq!(found,expected.into_iter().map(|row| row.2).collect::<Vec<_>>());
                assert!(read_sorted_page(&conn,filter,"needle",None,2,Some(id()),Some(order)).unwrap().records.is_empty());
                assert!(read_sorted_page(&conn,filter,"absent",None,2,scope.clone(),Some(order)).unwrap().records.is_empty());
            }
        }
    }
    #[test]
    fn organization_is_idempotent_conflict_checked_and_scoped() {
        let mut conn = db(); let record = create(&mut conn, &draft("raw\r\n  body  ")).note;
        let group = id();
        conn.execute("INSERT INTO phrase_groups VALUES(?1,'group',0,'now','now')",[&group]).unwrap();
        let mutation = id(); let note_id = &record.summary.id;
        let result = organize_conn(&mut conn,note_id,1,&mutation,Some(group.clone()),true).unwrap();
        assert!(result.applied); assert_eq!(result.note.body,record.body); assert_eq!(result.note.summary.revision,2);
        assert_eq!(result.note.summary.group_id,Some(group.clone())); assert!(result.note.summary.starred);
        assert!(!organize_conn(&mut conn,note_id,1,&mutation,Some(group.clone()),true).unwrap().applied);
        assert_eq!(organize_conn(&mut conn,note_id,1,&mutation,None,true).unwrap_err().code,"notes.mutationMismatch");
        assert_eq!(organize_conn(&mut conn,note_id,1,&id(),None,false).unwrap_err().code,"notes.conflict");
        assert_eq!(organize_conn(&mut conn,note_id,2,&id(),Some(id()),false).unwrap_err().code,"notes.groupMissing");
        assert_eq!(read_scoped_page(&conn,NoteFilter::Starred,"",None,50,Some(group)).unwrap().records.len(),1);
        assert!(read_scoped_page(&conn,NoteFilter::Ungrouped,"",None,50,None).unwrap().records.is_empty());
        organize_conn(&mut conn,note_id,2,&id(),None,false).unwrap();
        assert_eq!(read_scoped_page(&conn,NoteFilter::Ungrouped,"",None,50,None).unwrap().records.len(),1);
    }
    #[test]
    fn expiry_cleanup_is_bounded_and_cascades_refs_without_touching_live_notes() {
        let mut conn=db();
        let mut input=draft("keep"); input.refs.push(url_ref());
        let active=create(&mut conn,&input).note.summary.id;
        for index in 0..105 {
            let mut input=draft("expired"); input.refs.push(url_ref());
            let expired=create(&mut conn,&input).note.summary.id;
            conn.execute("UPDATE notes SET deleted_at_ms=?1 WHERE id=?2",params![index,&expired]).unwrap();
        }
        assert_eq!(prune_deleted(&conn,TRASH_RETENTION_MS+200,1000).unwrap(),100);
        assert_eq!(conn.query_row("SELECT count(*) FROM notes",[],|r|r.get::<_,i64>(0)).unwrap(),6);
        assert_eq!(conn.query_row("SELECT count(*) FROM note_refs",[],|r|r.get::<_,i64>(0)).unwrap(),6);
        assert_eq!(read_note(&conn,&active).unwrap().body,"keep");
        assert_eq!(prune_deleted(&conn,TRASH_RETENTION_MS+200,100).unwrap(),5);
    }
    fn clipboard(conn: &Connection, kind: &str, body: &str, manual_key: bool) -> String {
        let record_id = id();
        conn.execute("INSERT INTO clipboard_records(id,type,content,source_app,created_at,user_api_key) VALUES (?1,?2,?3,'Fixture','2026-10-07',?4)",
            params![record_id,kind,body,manual_key]).unwrap();
        record_id
    }
    #[test]
    fn unicode_limits_are_bytes_for_body_and_characters_for_title_without_trimming() {
        let mut conn = db();
        let mut input = draft("  中文\n\n ");
        input.title = "题".repeat(128);
        let result = create(&mut conn, &input);
        assert_eq!(result.note.body, input.body);
        assert_eq!(result.note.summary.byte_count, input.body.len() as i64);
        assert_eq!(
            result.note.summary.char_count,
            input.body.chars().count() as i64
        );
        input.title.push('题');
        assert_eq!(validate(&input).unwrap_err().code, "notes.titleTooLong");
        input = draft(&"中".repeat(MAX_BODY_BYTES / 3 + 1));
        assert_eq!(validate(&input).unwrap_err().code, "notes.bodyTooLarge");
        assert!(validate(&draft(&"x".repeat(MAX_BODY_BYTES))).is_ok());
        let empty = draft("");
        let note_id = id();
        assert_eq!(
            insert_note(&mut conn, &note_id, &id(), &empty, None, "unused")
                .unwrap_err()
                .code,
            "notes.emptyDraft"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    #[test]
    fn creation_retry_is_immutable_and_does_not_overwrite_a_later_save() {
        let mut conn = db();
        let input = draft("original");
        let note_id = id();
        let mutation = id();
        let digest = hash(&("create", &note_id, &input)).unwrap();
        let first = insert_note(&mut conn, &note_id, &mutation, &input, None, &digest).unwrap();
        let saved = update_note(
            &mut conn,
            &note_id,
            first.note.summary.revision,
            &id(),
            &draft("later"),
        )
        .unwrap();
        let retry = insert_note(&mut conn, &note_id, &mutation, &input, None, &digest).unwrap();
        assert!(!retry.applied);
        assert_eq!(retry.note.body, "later");
        assert_eq!(retry.note.summary.revision, saved.note.summary.revision);
        assert_eq!(
            insert_note(
                &mut conn,
                &note_id,
                &mutation,
                &draft("changed"),
                None,
                "different"
            )
            .unwrap_err()
            .code,
            "notes.mutationMismatch"
        );
        assert_eq!(
            insert_note(&mut conn, &id(), &mutation, &input, None, &digest)
                .unwrap_err()
                .code,
            "notes.mutationMismatch"
        );
    }
    #[test]
    fn revision_conflicts_and_lost_response_retries_preserve_the_latest_body() {
        let mut conn = db();
        let first = create(&mut conn, &draft("one"));
        let note_id = first.note.summary.id;
        let mutation = id();
        let input = draft("two");
        let saved = update_note(&mut conn, &note_id, 1, &mutation, &input).unwrap();
        assert_eq!(saved.note.summary.revision, 2);
        let retry = update_note(&mut conn, &note_id, 1, &mutation, &input).unwrap();
        assert!(!retry.applied);
        assert_eq!(retry.note.summary.revision, 2);
        assert_eq!(
            update_note(&mut conn, &note_id, 1, &mutation, &draft("different"))
                .unwrap_err()
                .code,
            "notes.mutationMismatch"
        );
        let conflict = update_note(&mut conn, &note_id, 1, &id(), &draft("late")).unwrap_err();
        assert_eq!(conflict.code, "notes.conflict");
        assert_eq!(conflict.current_revision, Some(2));
        assert_eq!(read_note(&conn, &note_id).unwrap().body, "two");
    }
    #[test]
    fn sqlite_full_preserves_committed_note_and_allows_exact_request_retry() {
        let mut conn = db();
        let mut original = draft("acknowledged raw\r\n  unchanged  ");
        original.refs.push(url_ref());
        let first = create(&mut conn, &original);
        let note_id = first.note.summary.id;
        conn.execute_batch("CREATE TABLE qa_full_probe(value BLOB)").unwrap();
        let pages: i64 = conn.pragma_query_value(None, "page_count", |row| row.get(0)).unwrap();
        conn.pragma_update(None, "max_page_count", pages).unwrap();
        // Exercise SQLite's real FULL result without filling the host disk.
        let probe = conn.execute("INSERT INTO qa_full_probe VALUES(zeroblob(4194304))", []).unwrap_err();
        assert!(matches!(probe, rusqlite::Error::SqliteFailure(ref e, _) if e.code == rusqlite::ErrorCode::DiskFull));
        let mutation = id();
        let changed = draft(&"x".repeat(MAX_BODY_BYTES));
        assert_eq!(update_note(&mut conn, &note_id, 1, &mutation, &changed).unwrap_err().code, "notes.databaseFailed");
        let unchanged = read_note(&conn, &note_id).unwrap();
        assert_eq!(unchanged.body, original.body);
        assert_eq!(unchanged.refs, original.refs);
        assert_eq!(unchanged.summary.revision, 1);
        conn.pragma_update(None, "max_page_count", 1_000_000).unwrap();
        let saved = update_note(&mut conn, &note_id, 1, &mutation, &changed).unwrap();
        assert!(saved.applied);
        assert_eq!(saved.note.body, changed.body);
        assert_eq!(saved.note.summary.revision, 2);
        assert!(!update_note(&mut conn, &note_id, 1, &mutation, &changed).unwrap().applied);
        assert_eq!(conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0)).unwrap(), "ok");
        assert!(!conn.prepare("PRAGMA foreign_key_check").unwrap().exists([]).unwrap());
    }
    #[test]
    fn sqlite_readonly_keeps_revision_and_refs_until_writes_are_restored() {
        let mut conn = db();
        let mut original = draft("acknowledged before readonly");
        original.refs.push(url_ref());
        let first = create(&mut conn, &original);
        let note_id = first.note.summary.id;
        let mutation = id();
        let changed = draft("retry after write access returns");
        conn.pragma_update(None, "query_only", true).unwrap();
        assert_eq!(update_note(&mut conn, &note_id, 1, &mutation, &changed).unwrap_err().code, "notes.databaseFailed");
        let unchanged = read_note(&conn, &note_id).unwrap();
        assert_eq!(unchanged.body, original.body);
        assert_eq!(unchanged.refs, original.refs);
        assert_eq!(unchanged.summary.revision, 1);
        conn.pragma_update(None, "query_only", false).unwrap();
        assert!(update_note(&mut conn, &note_id, 1, &mutation, &changed).unwrap().applied);
    }
    #[test]
    fn reference_failure_rolls_back_body_revision_and_existing_refs() {
        let mut conn = db();
        let reference = url_ref();
        let mut input = draft("first");
        input.refs.push(reference.clone());
        create(&mut conn, &input);
        input.refs[0].id = id();
        input.body = "second".into();
        let second = create(&mut conn, &input);
        let note_id = second.note.summary.id;
        let mut changed = draft("must roll back");
        changed.refs.push(reference);
        assert_eq!(
            update_note(&mut conn, &note_id, 1, &id(), &changed)
                .unwrap_err()
                .code,
            "notes.databaseFailed"
        );
        let unchanged = read_note(&conn, &note_id).unwrap();
        assert_eq!(unchanged.body, "second");
        assert_eq!(unchanged.summary.revision, 1);
        assert_eq!(unchanged.refs, input.refs);
        let duplicate_create = id();
        assert!(insert_note(&mut conn, &duplicate_create, &id(), &changed, None, "new").is_err());
        assert_eq!(
            read_note(&conn, &duplicate_create).unwrap_err().code,
            "notes.notFound"
        );
    }
    #[test]
    fn deleting_blocks_late_saves_and_restore_obeys_retention() {
        let mut conn = db();
        let note_id = create(&mut conn, &draft("keep")).note.summary.id;
        change_state(&mut conn, &note_id, 1, &id(), NoteAction::Archive).unwrap();
        assert!(read_page(&conn, NoteFilter::Active, "", None, 50)
            .unwrap()
            .records
            .is_empty());
        assert_eq!(
            read_page(&conn, NoteFilter::Archived, "", None, 50)
                .unwrap()
                .records
                .len(),
            1
        );
        let deletion = id();
        change_state(&mut conn, &note_id, 2, &deletion, NoteAction::Delete).unwrap();
        assert!(
            !change_state(&mut conn, &note_id, 2, &deletion, NoteAction::Delete)
                .unwrap()
                .applied
        );
        assert_eq!(
            update_note(&mut conn, &note_id, 2, &id(), &draft("stale"))
                .unwrap_err()
                .code,
            "notes.conflict"
        );
        assert_eq!(
            update_note(&mut conn, &note_id, 3, &id(), &draft("new"))
                .unwrap_err()
                .code,
            "notes.deleted"
        );
        let restored = change_state(&mut conn, &note_id, 3, &id(), NoteAction::Restore).unwrap();
        assert!(restored.note.summary.archived_at_ms.is_some());
        assert_eq!(restored.note.body, "keep");
        change_state(&mut conn, &note_id, 4, &id(), NoteAction::Delete).unwrap();
        conn.execute(
            "UPDATE notes SET deleted_at_ms=?1 WHERE id=?2",
            params![
                chrono::Utc::now().timestamp_millis() - TRASH_RETENTION_MS - 1,
                note_id
            ],
        )
        .unwrap();
        assert!(read_page(&conn, NoteFilter::Trash, "", None, 50)
            .unwrap()
            .records
            .is_empty());
        assert_eq!(
            change_state(&mut conn, &note_id, 5, &id(), NoteAction::Restore)
                .unwrap_err()
                .code,
            "notes.invalidState"
        );
    }
    #[test]
    fn cursor_pagination_handles_equal_timestamps_without_duplicates_or_bodies() {
        let mut conn = db();
        let mut expected = vec![];
        for index in 0..7 {
            expected.push(
                create(&mut conn, &draft(&format!("body-{index}")))
                    .note
                    .summary
                    .id,
            );
        }
        conn.execute("UPDATE notes SET updated_at_ms=42", [])
            .unwrap();
        expected.sort();
        expected.reverse();
        let mut ids = vec![];
        let mut cursor = None;
        loop {
            let page = read_page(&conn, NoteFilter::Active, "", cursor, 3).unwrap();
            let json = serde_json::to_value(&page).unwrap();
            assert!(json["records"][0].get("body").is_none());
            ids.extend(page.records.into_iter().map(|r| r.id));
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(ids, expected);
        let plan:String=conn.query_row("EXPLAIN QUERY PLAN SELECT id FROM notes WHERE deleted_at_ms IS NULL AND archived_at_ms IS NULL ORDER BY updated_at_ms DESC,id DESC LIMIT 50",[],|r|r.get(3)).unwrap();
        assert!(plan.contains("idx_notes_active"), "{plan}");
    }
    #[test]
    fn search_treats_wildcards_quotes_and_short_chinese_as_literal_text() {
        let mut conn = db();
        create(&mut conn, &draft("100% _ \\ ' 中"));
        create(&mut conn, &draft("ordinary"));
        for term in ["%", "_", "\\", "'", "中"] {
            let page = read_page(&conn, NoteFilter::Active, term, None, 50).unwrap();
            assert_eq!(page.records.len(), 1, "{term}");
        }
        assert!(
            read_page(&conn, NoteFilter::Active, "%' OR 1=1 --", None, 50)
                .unwrap()
                .records
                .is_empty()
        );
    }
    #[test]
    fn capture_reads_full_snapshot_and_retries_after_the_original_is_deleted() {
        let mut conn = db();
        let full = "中".repeat(2500);
        let record_id = clipboard(&conn, "text", &full, false);
        let mutation = id();
        let first = capture(&mut conn, &record_id, &mutation).unwrap();
        assert_eq!(first.note.body, full);
        assert_eq!(first.note.summary.summary.chars().count(), 160);
        assert_eq!(first.note.source.as_ref().unwrap().source_app, "Fixture");
        conn.execute("DELETE FROM clipboard_records WHERE id=?1", [&record_id])
            .unwrap();
        assert!(!capture(&mut conn, &record_id, &mutation).unwrap().applied);
        assert_eq!(read_note(&conn, &mutation).unwrap().body, full);
        assert_eq!(
            capture(&mut conn, &id(), &mutation).unwrap_err().code,
            "notes.mutationMismatch"
        );
    }
    #[test]
    fn capture_never_reveals_keys_or_saves_image_paths_as_text() {
        let mut conn = db();
        for (kind, content, manual, expected) in [
            ("text", "dpapi:v1:fixture", false, "notes.protectedSource"),
            (
                "text",
                "sk-fixture-01234567890123456789",
                false,
                "notes.protectedSource",
            ),
            (
                "text",
                "manual sensitive value",
                true,
                "notes.protectedSource",
            ),
            (
                "image",
                "images/picture.png",
                false,
                "notes.unsupportedSource",
            ),
            (
                "explorer",
                "relative\\path",
                false,
                "notes.unsupportedSource",
            ),
        ] {
            let record = clipboard(&conn, kind, content, manual);
            assert_eq!(
                capture(&mut conn, &record, &id()).unwrap_err().code,
                expected
            );
        }
        let labeled = clipboard(&conn, "text", "labeled sensitive value", false);
        conn.execute("INSERT INTO api_key_labels(record_id,key_preview,service,created_at,updated_at) VALUES (?1,'preview','service','now','now')",[&labeled]).unwrap();
        assert_eq!(
            capture(&mut conn, &labeled, &id()).unwrap_err().code,
            "notes.protectedSource"
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn file_capture_keeps_a_structured_path_and_deleting_never_touches_the_file() {
        let mut conn = db();
        let path = std::env::temp_dir().join(format!("notes-reference-{}.txt", id()));
        std::fs::write(&path, b"external fixture").unwrap();
        let record = clipboard(&conn, "file", &path.to_string_lossy(), false);
        let result = capture(&mut conn, &record, &id()).unwrap();
        assert!(result.note.body.is_empty());
        assert_eq!(result.note.refs[0].target, path.to_string_lossy());
        change_state(
            &mut conn,
            &result.note.summary.id,
            1,
            &id(),
            NoteAction::Delete,
        )
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"external fixture");
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn stale_storage_identity_is_rejected_after_connection_swap() {
        let state = DbState {
            conn: std::sync::Mutex::new(db()),
            storage_epoch: std::sync::atomic::AtomicU64::new(1),
            asset_reclaim_cursor: std::sync::Mutex::new(None),
        };
        let mut connection = state.conn.lock().unwrap();
        assert_eq!(check_epoch(&state, 1).unwrap(), 1);
        *connection = db();
        state.storage_epoch.fetch_add(1, Ordering::Relaxed);
        assert_eq!(
            check_epoch(&state, 1).unwrap_err().code,
            "notes.storageChanged"
        );
        assert_eq!(check_epoch(&state, 2).unwrap(), 2);
    }

    #[test]
    fn change_notifications_contain_identity_and_revision_without_body_or_refs() {
        let mut conn = db();
        let result = StorageResult {
            storage_epoch: 7,
            value: create(&mut conn, &draft("private fixture")),
        };
        let event = change_event(&result, "create").unwrap();
        assert_eq!(event["storage_epoch"], 7);
        assert_eq!(event["revision"], 1);
        assert_eq!(event["id"], result.value.note.summary.id);
        assert_eq!(event["mutation_id"], result.value.mutation_id);
        assert!(!event.to_string().contains("private fixture"));
        assert!(event.get("body").is_none());
        assert!(event.get("refs").is_none());
        let replay = StorageResult {
            storage_epoch: 7,
            value: MutationResult {
                applied: false,
                ..result.value
            },
        };
        assert!(change_event(&replay, "create").is_none());
    }

    #[test]
    fn reference_validation_bounds_count_and_rejects_duplicate_or_unsafe_targets() {
        let mut input = draft("");
        input.refs = (0..20).map(|_| url_ref()).collect();
        assert!(validate(&input).is_ok());
        input.refs.push(url_ref());
        assert_eq!(validate(&input).unwrap_err().code, "notes.tooManyRefs");
        input.refs = vec![url_ref()];
        input.refs.push(input.refs[0].clone());
        assert_eq!(validate(&input).unwrap_err().code, "notes.duplicateRef");
        input.refs = vec![url_ref()];
        input.refs[0].target = "javascript:alert(1)".into();
        assert_eq!(validate(&input).unwrap_err().code, "notes.invalidRef");
        input.refs[0].kind = "file".into();
        input.refs[0].target = "relative.txt".into();
        assert_eq!(validate(&input).unwrap_err().code, "notes.invalidRef");
    }

    #[test]
    fn link_capture_retains_body_and_url_ref_and_each_new_action_can_create_another_note() {
        let mut conn = db();
        let record = clipboard(&conn, "link", "https://example.com/a?q=中文", false);
        let first = capture(&mut conn, &record, &id()).unwrap();
        assert_eq!(first.note.body, "https://example.com/a?q=中文");
        assert_eq!(first.note.refs[0].kind, "url");
        assert_eq!(first.note.refs[0].target, first.note.body);
        let second = capture(&mut conn, &record, &id()).unwrap();
        assert_ne!(first.note.summary.id, second.note.summary.id);
    }
}
