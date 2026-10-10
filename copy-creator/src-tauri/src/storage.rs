//! Recoverable settings/vault/records/groups relocation. Clipboard history and
//! app-owned image assets retain the existing storage-change scope.
use rusqlite::{
    params, params_from_iter,
    types::{Value, ValueRef},
    Connection, OptionalExtension, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const RECEIPT_KEY: &str = "internal_storage_migration_receipt_v1";
const MAX_RECEIPT_BYTES: usize = 1024 * 1024;
const RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const NOTE_COLUMNS: &str = "id,title,body,summary,char_count,byte_count,created_at_ms,updated_at_ms,revision,archived_at_ms,deleted_at_ms,source_json,creation_mutation_id,creation_hash,last_mutation_id,last_mutation_hash";
const REF_COLUMNS: &str = "id,note_id,kind,target,display_name,sort_order";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u8,
    source: String,
    destination: String,
    digest: String,
    original_settings: Vec<(String, String)>,
}
fn db_error(_: rusqlite::Error) -> String {
    "notes.storageMigrationFailed".into()
}
fn settings(conn: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT key,value FROM settings WHERE key<>?1 ORDER BY key")
        .map_err(db_error)?;
    let result = stmt
        .query_map([RECEIPT_KEY], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error);
    result
}
fn digest(conn: &Connection) -> Result<String, String> {
    let mut hash = Sha256::new();
    let queries = [
        format!("SELECT key,value FROM settings WHERE key<>'{RECEIPT_KEY}' ORDER BY key"),
        format!("SELECT {NOTE_COLUMNS} FROM notes ORDER BY id"),
        format!("SELECT {REF_COLUMNS} FROM note_refs ORDER BY id"),
        "SELECT id,version,salt,verifier FROM vault_config ORDER BY id".into(),
        "SELECT id,encrypted_data,created_at,updated_at FROM vault_entries ORDER BY id".into(),
        "SELECT source_id,content_hash,restored_note_id FROM note_import_origins ORDER BY source_id,content_hash".into(),
        "SELECT note_id,group_id,starred FROM note_organization ORDER BY note_id".into(),
        "SELECT id,name,sort_order,created_at,updated_at FROM phrase_groups ORDER BY id".into(),
        "SELECT id,color FROM note_group_colors ORDER BY id".into(),
    ];
    for query in queries {
        hash.update((query.len() as u64).to_le_bytes());
        hash.update(query.as_bytes());
        let mut stmt = conn.prepare(&query).map_err(db_error)?;
        let columns = stmt.column_count();
        let mut rows = stmt.query([]).map_err(db_error)?;
        while let Some(row) = rows.next().map_err(db_error)? {
            hash.update(b"row");
            for index in 0..columns {
                match row.get_ref(index).map_err(db_error)? {
                    ValueRef::Null => hash.update([0]),
                    ValueRef::Integer(value) => {
                        hash.update([1]);
                        hash.update(value.to_le_bytes());
                    }
                    ValueRef::Real(value) => {
                        hash.update([2]);
                        hash.update(value.to_le_bytes());
                    }
                    ValueRef::Text(value) | ValueRef::Blob(value) => {
                        hash.update([3]);
                        hash.update((value.len() as u64).to_le_bytes());
                        hash.update(value);
                    }
                }
            }
        }
        hash.update(b"end");
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn copy_rows(
    source: &Connection,
    destination: &Connection,
    table: &str,
    columns: &str,
    query: &str,
    cutoff: i64,
) -> Result<(), String> {
    let mut stmt = source.prepare(query).map_err(db_error)?;
    let count = stmt.column_count();
    let placeholders = vec!["?"; count].join(",");
    let mut insert = destination
        .prepare(&format!(
            "INSERT INTO {table} ({columns}) VALUES ({placeholders})"
        ))
        .map_err(db_error)?;
    let mut rows = stmt.query([cutoff]).map_err(db_error)?;
    while let Some(row) = rows.next().map_err(db_error)? {
        // A single bounded note/ref row at a time; never load all bodies.
        let fields = (0..count)
            .map(|index| row.get::<_, Value>(index))
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_error)?;
        insert.execute(params_from_iter(fields)).map_err(db_error)?;
    }
    Ok(())
}

/// Prepare the target atomically. Keep a receipt until the source routing write
/// succeeds. A retry may replace only this migration's unchanged staged data;
/// edited target data always fails closed. Original target settings are retained.
pub(crate) fn prepare_target(
    source: &Connection,
    destination: &mut Connection,
    source_path: &str,
    destination_path: &str,
    now: i64,
) -> Result<(), String> {
    let source_snapshot = source.unchecked_transaction().map_err(db_error)?;
    let source = &source_snapshot;
    // Validate the receipt under the same target write reservation used to
    // refresh it; an external connection cannot edit between check and delete.
    let tx = destination
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT value FROM settings WHERE key=?1",
            [RECEIPT_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let previous = existing
        .map(|json| {
            if json.len() > MAX_RECEIPT_BYTES {
                return Err("notes.storageConflict".to_string());
            }
            serde_json::from_str::<Receipt>(&json).map_err(|_| "notes.storageConflict".to_string())
        })
        .transpose()?;
    let original_settings = if let Some(receipt) = &previous {
        if receipt.version != 2
            || receipt.source != source_path
            || receipt.destination != destination_path
            || digest(&tx)? != receipt.digest
        {
            return Err("notes.storageConflict".into());
        }
        receipt.original_settings.clone()
    } else {
        let has_notes: bool = tx
            .query_row("SELECT EXISTS(SELECT 1 FROM notes)", [], |r| r.get(0))
            .map_err(db_error)?;
        let has_groups: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM phrase_groups)", [], |r|r.get(0)).map_err(db_error)?;
        if has_notes || has_groups {
            return Err("notes.storageConflict".into());
        }
        crate::vault::ensure_empty_storage(&tx)?;
        settings(&tx)?
    };
    if previous.is_some() {
        tx.execute_batch("DELETE FROM note_organization; DELETE FROM note_refs; DELETE FROM notes; DELETE FROM note_group_colors; DELETE FROM phrase_groups; DELETE FROM vault_entries; DELETE FROM vault_config; DELETE FROM settings;").map_err(db_error)?;
        for (key, value) in &original_settings {
            tx.execute(
                "INSERT INTO settings(key,value) VALUES(?1,?2)",
                params![key, value],
            )
            .map_err(db_error)?;
        }
    }
    for (key, value) in settings(source)? {
        tx.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key,value]).map_err(db_error)?;
    }
    tx.execute("INSERT INTO settings(key,value) VALUES('storage_path',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [destination_path]).map_err(db_error)?;
    crate::vault::copy_encrypted_into(source, &tx)?;
    let cutoff = now.saturating_sub(RETENTION_MS);
    copy_rows(source, &tx, "notes", NOTE_COLUMNS, &format!("SELECT {NOTE_COLUMNS} FROM notes WHERE deleted_at_ms IS NULL OR deleted_at_ms>=?1 ORDER BY id"), cutoff)?;
    copy_rows(source, &tx, "note_refs", REF_COLUMNS, &format!("SELECT {REF_COLUMNS} FROM note_refs WHERE note_id IN (SELECT id FROM notes WHERE deleted_at_ms IS NULL OR deleted_at_ms>=?1) ORDER BY note_id,sort_order,id"), cutoff)?;
    copy_rows(source, &tx, "phrase_groups", "id,name,sort_order,created_at,updated_at", "SELECT id,name,sort_order,created_at,updated_at FROM phrase_groups WHERE ?1 IS NOT NULL ORDER BY id", cutoff)?;
    copy_rows(source, &tx, "note_group_colors", "id,color", "SELECT id,color FROM note_group_colors WHERE ?1 IS NOT NULL ORDER BY id", cutoff)?;
    copy_rows(source, &tx, "note_organization", "note_id,group_id,starred", "SELECT note_id,group_id,starred FROM note_organization WHERE note_id IN(SELECT id FROM notes WHERE deleted_at_ms IS NULL OR deleted_at_ms>=?1) ORDER BY note_id", cutoff)?;
    copy_rows(source, &tx, "note_import_origins", "source_id,content_hash,restored_note_id",
        "SELECT source_id,content_hash,restored_note_id FROM note_import_origins WHERE restored_note_id IN (SELECT id FROM notes WHERE deleted_at_ms IS NULL OR deleted_at_ms>=?1) ORDER BY source_id,content_hash",cutoff)?;
    let receipt = Receipt {
        version: 2,
        source: source_path.into(),
        destination: destination_path.into(),
        digest: digest(&tx)?,
        original_settings,
    };
    let json = serde_json::to_string(&receipt).map_err(|_| "notes.storageMigrationFailed")?;
    if json.len() > MAX_RECEIPT_BYTES {
        return Err("notes.storageMigrationFailed".into());
    }
    tx.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![RECEIPT_KEY,json]).map_err(db_error)?;
    tx.commit().map_err(db_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn connection() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::initialize_connection(&mut conn).unwrap();
        conn
    }
    fn note(conn: &Connection, id: &str, archived: Option<i64>, deleted: Option<i64>) {
        conn.execute("INSERT INTO notes VALUES(?1,'title','完整正文','完整正文',4,12,1,2,3,?2,?3,NULL,?1,'create-hash',?1,'save-hash')", params![id,archived,deleted]).unwrap();
        conn.execute(
            "INSERT INTO note_refs VALUES(?1,?1,'file','C:\\external\\keep.txt','keep',0)",
            [id],
        )
        .unwrap();
    }
    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }
    #[test]
    fn relocation_preserves_live_archive_recent_trash_refs_and_protocol_identity() {
        let source = connection();
        let mut target = connection();
        let now = RETENTION_MS * 2;
        note(&source, "active", None, None);
        source.execute_batch("INSERT INTO phrase_groups VALUES('group','keep',4,'now','now');INSERT INTO note_group_colors VALUES('group','#aabbcc');INSERT INTO note_organization VALUES('active','group',1);").unwrap();
        note(&source, "archive", Some(2), None);
        note(&source, "trash", None, Some(now - 1));
        note(&source, "expired", None, Some(1));
        source
            .execute(
                "UPDATE settings SET value='Ctrl+Alt+K' WHERE key='shortcut_key'",
                [],
            )
            .unwrap();
        prepare_target(&source, &mut target, "source", "target", now).unwrap();
        assert_eq!(count(&target, "notes"), 3);
        assert_eq!(count(&target,"phrase_groups"),1);
        assert_eq!(target.query_row("SELECT group_id,starred FROM note_organization WHERE note_id='active'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?))).unwrap(),("group".into(),1));
        assert_eq!(target.query_row("SELECT color FROM note_group_colors WHERE id='group'",[],|r|r.get::<_,String>(0)).unwrap(),"#aabbcc");
        assert_eq!(count(&target, "note_refs"), 3);
        assert_eq!(count(&source, "notes"), 4);
        let tuple: (i64, String, String) = target
            .query_row(
                "SELECT revision,creation_hash,last_mutation_hash FROM notes WHERE id='active'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(tuple, (3, "create-hash".into(), "save-hash".into()));
        assert_eq!(
            target
                .query_row(
                    "SELECT value FROM settings WHERE key='shortcut_key'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "Ctrl+Alt+K"
        );
    }
    #[test]
    fn target_failure_rolls_back_notes_vault_and_settings_together() {
        let source = connection();
        let mut target = connection();
        note(&source, "one", None, None);
        source
            .execute("INSERT INTO vault_config VALUES(1,1,'salt','verifier')", [])
            .unwrap();
        source
            .execute(
                "INSERT INTO vault_entries VALUES('entry','ciphertext','created','updated')",
                [],
            )
            .unwrap();
        target.execute_batch("CREATE TRIGGER refuse_refs BEFORE INSERT ON note_refs BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        let before = digest(&target).unwrap();
        assert!(prepare_target(&source, &mut target, "source", "target", RETENTION_MS).is_err());
        assert_eq!(digest(&target).unwrap(), before);
        assert_eq!(count(&target, "vault_config"), 0);
        assert!(target
            .query_row(
                "SELECT value FROM settings WHERE key=?1",
                [RECEIPT_KEY],
                |r| r.get::<_, String>(0)
            )
            .optional()
            .unwrap()
            .is_none());
    }
    #[test]
    fn existing_target_data_is_never_overwritten() {
        let source = connection();
        let mut target = connection();
        note(&source, "source", None, None);
        note(&target, "local", None, None);
        let before = digest(&target).unwrap();
        assert_eq!(
            prepare_target(&source, &mut target, "source", "target", RETENTION_MS).unwrap_err(),
            "notes.storageConflict"
        );
        assert_eq!(digest(&target).unwrap(), before);
    }
    #[test]
    fn failed_source_routing_can_retry_even_after_source_edits_without_losing_original_target_settings(
    ) {
        let source = connection();
        let mut target = connection();
        note(&source, "one", None, None);
        target
            .execute(
                "INSERT INTO settings VALUES('target_custom','preserved')",
                [],
            )
            .unwrap();
        source.execute_batch("CREATE TRIGGER refuse_route BEFORE INSERT ON settings WHEN NEW.key='storage_path' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        prepare_target(&source, &mut target, "source", "target", RETENTION_MS).unwrap();
        assert!(source
            .execute("INSERT INTO settings VALUES('storage_path','target')", [])
            .is_err());
        source
            .execute(
                "UPDATE notes SET body='later',revision=4 WHERE id='one'",
                [],
            )
            .unwrap();
        prepare_target(&source, &mut target, "source", "target", RETENTION_MS + 1).unwrap();
        assert_eq!(count(&target, "notes"), 1);
        assert_eq!(
            target
                .query_row("SELECT body FROM notes WHERE id='one'", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "later"
        );
        assert_eq!(
            target
                .query_row(
                    "SELECT value FROM settings WHERE key='target_custom'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "preserved"
        );
    }
    #[test]
    fn changed_target_or_other_source_cannot_claim_a_completed_staging_receipt() {
        for change in [false, true] {
            let source = connection();
            let mut target = connection();
            note(&source, "one", None, None);
            prepare_target(&source, &mut target, "source", "target", RETENTION_MS).unwrap();
            if change {
                target
                    .execute("UPDATE note_refs SET display_name='user edit'", [])
                    .unwrap();
            }
            let before = digest(&target).unwrap();
            assert_eq!(
                prepare_target(
                    &source,
                    &mut target,
                    if change { "source" } else { "other" },
                    "target",
                    RETENTION_MS
                )
                .unwrap_err(),
                "notes.storageConflict"
            );
            assert_eq!(digest(&target).unwrap(), before);
        }
    }
}
