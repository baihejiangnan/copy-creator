use crate::notes::{self, NoteDraft, NoteRef, NoteSource};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub(crate) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS note_import_origins (
        source_id TEXT NOT NULL, content_hash TEXT NOT NULL,
        restored_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        PRIMARY KEY(source_id,content_hash));
        CREATE INDEX IF NOT EXISTS idx_note_import_restored ON note_import_origins(restored_note_id);")
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BackupNote {
    pub id: String,
    pub title: String,
    pub body: String,
    pub refs: Vec<NoteRef>,
    pub source: Option<NoteSource>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub archived_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if="Option::is_none")]
    pub group_id: Option<String>,
    #[serde(default, skip_serializing_if="std::ops::Not::not")]
    pub starred: bool,
}
impl BackupNote {
    fn draft(&self) -> NoteDraft {
        NoteDraft {
            title: self.title.clone(),
            body: self.body.clone(),
            refs: self.refs.clone(),
        }
    }
    fn semantic_hash(&self) -> Result<String, String> {
        let refs: Vec<_> = self
            .refs
            .iter()
            .map(|r| (&r.kind, &r.target, &r.display_name))
            .collect();
        // Default organization preserves hashes from previously imported v3 files.
        let base = notes::hash(&(
            &self.title,
            &self.body,
            refs,
            &self.source,
            self.archived_at_ms.is_some(),
        ))
        .map_err(|e| e.code.to_string())?;
        if self.group_id.is_none() && !self.starred { Ok(base) }
        else { notes::hash(&(base,&self.group_id,self.starred)).map_err(|e|e.code.into()) }
    }
}
impl From<notes::Note> for BackupNote {
    fn from(note: notes::Note) -> Self {
        Self {
            id: note.summary.id,
            title: note.summary.title,
            body: note.body,
            refs: note.refs,
            source: note.source,
            created_at_ms: note.summary.created_at_ms,
            updated_at_ms: note.summary.updated_at_ms,
            archived_at_ms: note.summary.archived_at_ms,
            group_id: note.summary.group_id, starred: note.summary.starred,
        }
    }
}
pub(crate) fn validate(records: &[BackupNote]) -> Result<(), String> {
    if records.len() > 100_000 {
        return Err("backup.invalidFile".into());
    }
    let mut ids = std::collections::HashSet::new();
    let mut refs = std::collections::HashSet::new();
    for note in records {
        if uuid::Uuid::parse_str(&note.id).is_err()
            || !ids.insert(&note.id)
            || note.created_at_ms < 0
            || note.updated_at_ms < 0
            || note.archived_at_ms.is_some_and(|at| at < 0)
        {
            return Err("backup.invalidFile".into());
        }
        if note.group_id.as_ref().is_some_and(|id|uuid::Uuid::parse_str(id).is_err()) { return Err("backup.invalidFile".into()); }
        // Historical phrases had no content length limit. Preserve their complete
        // bytes; new edits continue to obey the standard record limits.
        if !note.source.as_ref().is_some_and(|s|s.kind=="phrase") {
            notes::validate(&note.draft()).map_err(|_| "backup.invalidFile")?;
        } else if !note.refs.is_empty() { return Err("backup.invalidFile".into()); }
        if note.refs.iter().any(|r| !refs.insert(&r.id)) {
            return Err("backup.invalidFile".into());
        }
        if let Some(source) = &note.source {
            if !matches!(source.kind.as_str(), "text" | "link" | "file" | "explorer" | "phrase")
                || source.record_id.len() > 128
                || source.source_app.len() > 4096
                || source.captured_at_ms < 0
            {
                return Err("backup.invalidFile".into());
            }
        }
    }
    Ok(())
}
pub(crate) fn snapshot(
    conn: &Connection,
    budget: &mut crate::backup_limits::Budget,
) -> Result<Vec<BackupNote>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM notes WHERE deleted_at_ms IS NULL ORDER BY id")
        .map_err(|_| "backup.databaseFailed")?;
    let mut rows = stmt.query([]).map_err(|_| "backup.databaseFailed")?;
    let mut records = Vec::new();
    while let Some(row) = rows.next().map_err(|_| "backup.databaseFailed")? {
        let id: String = row.get(0).map_err(|_| "backup.databaseFailed")?;
        let record: BackupNote = notes::read_note(conn, &id)
            .map_err(|_| "backup.databaseFailed")?
            .into();
        budget.include(&record)?;
        records.push(record);
    }
    validate(&records)?;
    Ok(records)
}
#[derive(Default, Debug, PartialEq)]
pub(crate) struct ImportCounts {
    pub imported: usize,
    pub conflicts: usize,
    pub skipped: usize,
}
enum Decision {
    Skip(String),
    Restore(String),
    Copy,
}
fn decision(conn: &Connection, note: &BackupNote, hash: &str) -> Result<Decision, String> {
    let restored: Option<String> = conn.query_row("SELECT restored_note_id FROM note_import_origins WHERE source_id=?1 AND content_hash=?2", params![note.id,hash], |r| r.get(0)).optional().map_err(|_| "backup.databaseFailed")?;
    if let Some(id) = restored {
        return Ok(Decision::Skip(id));
    }
    let exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE id=?1)",
            [&note.id],
            |r| r.get(0),
        )
        .map_err(|_| "backup.databaseFailed")?;
    if !exists {
        return Ok(Decision::Restore(note.id.clone()));
    }
    let local = notes::read_note(conn, &note.id).map_err(|_| "backup.databaseFailed")?;
    if local.summary.deleted_at_ms.is_none() && BackupNote::from(local).semantic_hash()? == hash {
        Ok(Decision::Skip(note.id.clone()))
    } else {
        Ok(Decision::Copy)
    }
}
pub(crate) fn preview(conn: &Connection, records: &[BackupNote]) -> Result<ImportCounts, String> {
    let mut counts = ImportCounts::default();
    for note in records {
        match decision(conn, note, &note.semantic_hash()?)? {
            Decision::Skip(_) => counts.skipped += 1,
            Decision::Restore(_) => counts.imported += 1,
            Decision::Copy => {
                counts.imported += 1;
                counts.conflicts += 1;
            }
        }
    }
    Ok(counts)
}
/// Called inside the existing all-object import transaction. Every imported
/// note gets local protocol identities; source/hash is an independent dedup key.
pub(crate) fn apply(conn: &Connection, records: &[BackupNote]) -> Result<ImportCounts, String> {
    validate(records)?;
    let mut counts = ImportCounts::default();
    for note in records {
        let hash = note.semantic_hash()?;
        let choice = decision(conn, note, &hash)?;
        let id = match choice {
            Decision::Skip(id) => {
                counts.skipped += 1;
                id
            }
            Decision::Restore(id) => {
                restore(conn, note, &id)?;
                counts.imported += 1;
                id
            }
            Decision::Copy => {
                let id = uuid::Uuid::new_v4().to_string();
                restore(conn, note, &id)?;
                counts.imported += 1;
                counts.conflicts += 1;
                id
            }
        };
        conn.execute("INSERT INTO note_import_origins VALUES(?1,?2,?3) ON CONFLICT(source_id,content_hash) DO NOTHING",params![note.id,hash,id]).map_err(|_| "backup.databaseFailed")?;
    }
    Ok(counts)
}
fn restore(conn: &Connection, note: &BackupNote, id: &str) -> Result<(), String> {
    let mut draft = note.draft();
    for reference in &mut draft.refs {
        reference.id = uuid::Uuid::new_v4().to_string();
    }
    let mutation = uuid::Uuid::new_v4().to_string();
    let request_hash = notes::hash(&("create", id, &draft)).map_err(|e| e.code)?;
    let (summary, chars, bytes) = notes::derived(&draft);
    let source = note
        .source
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| "backup.invalidFile")?;
    conn.execute("INSERT INTO notes(id,title,body,summary,char_count,byte_count,created_at_ms,updated_at_ms,revision,archived_at_ms,deleted_at_ms,source_json,creation_mutation_id,creation_hash,last_mutation_id,last_mutation_hash)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,1,?9,NULL,?10,?11,?12,?11,?12)",params![id,draft.title,draft.body,summary,chars,bytes,note.created_at_ms,note.updated_at_ms,note.archived_at_ms,source,mutation,request_hash]).map_err(|_| "backup.databaseFailed")?;
    notes::write_refs(conn, id, &draft.refs).map_err(|_| "backup.databaseFailed".to_string())?;
    conn.execute("INSERT INTO note_organization(note_id,group_id,starred) VALUES(?1,?2,?3)",params![id,note.group_id,note.starred]).map_err(|_|"backup.databaseFailed")?;
    Ok(())
}

pub(crate) fn promote_phrases(conn: &Connection) -> Result<(),String> {
    loop {
        let rows: Vec<BackupNote> = conn.prepare("SELECT id,title,content,group_id,COALESCE(CAST(strftime('%s',created_at) AS INTEGER)*1000,0),COALESCE(CAST(strftime('%s',updated_at) AS INTEGER)*1000,0) FROM phrases ORDER BY id LIMIT 100").map_err(|_|"notes.databaseFailed")?
            .query_map([],|r| {let id:String=r.get(0)?; Ok(BackupNote {id:id.clone(),title:r.get(1)?,body:r.get(2)?,refs:vec![],source:Some(NoteSource{kind:"phrase".into(),record_id:id,source_app:String::new(),captured_at_ms:r.get(4)?}),created_at_ms:r.get(4)?,updated_at_ms:r.get(5)?,archived_at_ms:None,group_id:Some(r.get(3)?),starred:false})}).map_err(|_|"notes.databaseFailed")?.collect::<rusqlite::Result<_>>().map_err(|_|"notes.databaseFailed")?;
        if rows.is_empty() {return Ok(());}
        apply(conn,&rows)?;
        for row in rows {conn.execute("DELETE FROM phrases WHERE id=?1",[row.id]).map_err(|_|"notes.databaseFailed")?;}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn connection() -> Connection {
        let mut c = Connection::open_in_memory().unwrap();
        crate::db::initialize_connection(&mut c).unwrap();
        c
    }
    fn fixture() -> BackupNote {
        BackupNote {
            id: uuid::Uuid::new_v4().to_string(),
            title: "original".into(),
            body: "完整正文".into(),
            refs: vec![NoteRef {
                id: uuid::Uuid::new_v4().to_string(),
                kind: "url".into(),
                target: "https://example.com/".into(),
                display_name: "link".into(),
            }],
            source: None,
            created_at_ms: 1,
            updated_at_ms: 2,
            archived_at_ms: Some(3),
            group_id: None, starred: false,
        }
    }
    #[test]
    fn legacy_promotion_preserves_whitespace_long_bodies_groups_and_collisions() {
        let mut c=connection(); let original=fixture(); let group=uuid::Uuid::new_v4().to_string();
        {let tx=c.transaction().unwrap();apply(&tx,&[original.clone()]).unwrap();tx.commit().unwrap();}
        c.execute("INSERT INTO phrase_groups VALUES(?1,'legacy',0,'now','now')",[&group]).unwrap();
        let body=format!("  raw\r\n{}  ","字".repeat(90_000));
        c.execute("INSERT INTO phrases VALUES(?1,?2,'old',?3,0,'2026-01-01','2026-01-02')",params![original.id,group,body]).unwrap();
        {let tx=c.transaction().unwrap();promote_phrases(&tx).unwrap();tx.commit().unwrap();}
        assert_eq!(notes::read_note(&c,&original.id).unwrap().body,original.body);
        let migrated: String=c.query_row("SELECT n.id FROM notes n JOIN note_organization o ON o.note_id=n.id WHERE o.group_id=?1",[&group],|r|r.get(0)).unwrap();
        assert_ne!(migrated,original.id); assert_eq!(notes::read_note(&c,&migrated).unwrap().body,body);
        promote_phrases(&c).unwrap();
        assert_eq!(c.query_row("SELECT COUNT(*) FROM phrases",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(c.query_row("SELECT COUNT(*) FROM notes",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    }
    #[test]
    fn restore_remaps_refs_and_protocol_then_repeated_import_keeps_local_edits() {
        let mut c = connection();
        let note = fixture();
        {
            let tx = c.transaction().unwrap();
            assert_eq!(apply(&tx, &[note.clone()]).unwrap().imported, 1);
            tx.commit().unwrap();
        }
        let restored = notes::read_note(&c, &note.id).unwrap();
        assert_eq!(restored.summary.revision, 1);
        assert_ne!(restored.refs[0].id, note.refs[0].id);
        assert_eq!(restored.body, note.body);
        c.execute(
            "UPDATE notes SET body='local edit',revision=2 WHERE id=?1",
            [&note.id],
        )
        .unwrap();
        assert_eq!(preview(&c, &[note.clone()]).unwrap().skipped, 1);
        let tx = c.transaction().unwrap();
        assert_eq!(apply(&tx, &[note]).unwrap().skipped, 1);
        tx.commit().unwrap();
        assert_eq!(
            notes::read_note(&c, &restored.summary.id).unwrap().body,
            "local edit"
        );
    }
    #[test]
    fn conflict_copy_keeps_local_record_and_repeated_restore_does_not_make_more_copies() {
        let mut c = connection();
        let note = fixture();
        let mut local = note.clone();
        local.body = "local".into();
        restore(&c, &local, &note.id).unwrap();
        let old_creation: String = c
            .query_row(
                "SELECT creation_mutation_id FROM notes WHERE id=?1",
                [&note.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(preview(&c, &[note.clone()]).unwrap().conflicts, 1);
        {
            let tx = c.transaction().unwrap();
            assert_eq!(apply(&tx, &[note.clone()]).unwrap().conflicts, 1);
            tx.commit().unwrap();
        }
        let copy: String = c
            .query_row("SELECT id FROM notes WHERE id<>?1", [&note.id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(notes::read_note(&c, &note.id).unwrap().body, "local");
        assert_eq!(notes::read_note(&c, &copy).unwrap().body, note.body);
        let copy_creation: String = c
            .query_row(
                "SELECT creation_mutation_id FROM notes WHERE id=?1",
                [&copy],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(copy_creation, old_creation);
        let tx = c.transaction().unwrap();
        assert_eq!(apply(&tx, &[note]).unwrap().skipped, 1);
        tx.commit().unwrap();
        assert_eq!(
            c.query_row("SELECT count(*) FROM notes", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn import_failure_rolls_back_notes_refs_and_origin_together() {
        let mut c = connection();
        let a = fixture();
        let b = fixture();
        c.execute_batch("CREATE TRIGGER refuse_second BEFORE INSERT ON notes WHEN (SELECT count(*) FROM notes)>0 BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        {
            let tx = c.transaction().unwrap();
            assert!(apply(&tx, &[a, b]).is_err());
        }
        for table in ["notes", "note_refs", "note_import_origins"] {
            assert_eq!(
                c.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }
    #[test]
    fn semantic_identity_ignores_cache_times_and_ref_ids_but_retains_content_source_and_archive() {
        let a = fixture();
        let mut b = a.clone();
        b.id = uuid::Uuid::new_v4().to_string();
        b.refs[0].id = uuid::Uuid::new_v4().to_string();
        b.updated_at_ms = 9;
        assert_eq!(a.semantic_hash().unwrap(), b.semantic_hash().unwrap());
        b.archived_at_ms = None;
        assert_ne!(a.semantic_hash().unwrap(), b.semantic_hash().unwrap());
    }
}
