//! Synthetic regressions for schema upgrades and derived search consistency.
use crate::{db, note_backup, note_search, notes::NoteRef, storage};
use rusqlite::Connection;

fn connection() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    db::initialize_connection(&mut conn).unwrap();
    conn
}
fn note() -> note_backup::BackupNote {
    note_backup::BackupNote { group_id: None, starred: false,
        id: uuid::Uuid::new_v4().to_string(),
        title: "migration fixture".into(),
        body: "独立中文正文 rare-migration-token".into(),
        refs: vec![NoteRef {
            id: uuid::Uuid::new_v4().to_string(),
            kind: "url".into(),
            target: "https://example.com/only-reference-token".into(),
            display_name: "文件引用".into(),
        }],
        source: None,
        created_at_ms: 1,
        updated_at_ms: 2,
        archived_at_ms: None,
    }
}
fn schema_four(conn: &Connection) {
    conn.execute_batch(
        "DROP TRIGGER notes_search_insert; DROP TRIGGER notes_search_update;
        DROP TRIGGER notes_search_delete; DROP TRIGGER note_refs_search_insert;
        DROP TRIGGER note_refs_search_update; DROP TRIGGER note_refs_search_delete;
        DROP TABLE notes_search; DROP TABLE note_refs_search;
        DROP TABLE notes_search_ids; DROP TABLE note_refs_search_ids;
        PRAGMA user_version=4;",
    )
    .unwrap();
}
fn candidates(conn: &Connection, term: &str) -> Vec<i64> {
    note_search::candidates(conn, term).unwrap().unwrap()
}

#[test]
fn upgrade_backfills_existing_bodies_refs_and_survives_reopen_vacuum() {
    let root =
        std::env::temp_dir().join(format!("copy-creator-qa-search-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("data.db");
    let mut conn = Connection::open(&path).unwrap();
    db::initialize_connection(&mut conn).unwrap();
    let original = note();
    note_backup::apply(&conn, &[original.clone()]).unwrap();
    schema_four(&conn);
    drop(conn);
    let mut conn = Connection::open(&path).unwrap();
    db::initialize_connection(&mut conn).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        6
    );
    assert_eq!(candidates(&conn, "rare-migration-token").len(), 1);
    assert_eq!(candidates(&conn, "only-reference-token").len(), 1);
    conn.execute("UPDATE notes SET rowid=42", []).unwrap();
    assert_eq!(candidates(&conn, "rare-migration-token"), vec![42]);
    conn.execute_batch("VACUUM").unwrap();
    assert_eq!(candidates(&conn, "rare-migration-token").len(), 1);
    db::initialize_connection(&mut conn).unwrap();
    assert_eq!(
        conn.query_row("SELECT count(*) FROM notes_search_ids", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(conn);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_upgrade_rolls_back_version_and_partial_indexes_then_retries() {
    let mut conn = connection();
    let original = note();
    note_backup::apply(&conn, &[original.clone()]).unwrap();
    schema_four(&conn);
    conn.execute_batch("CREATE TABLE note_refs_search(blocker TEXT)")
        .unwrap();
    assert!(db::initialize_connection(&mut conn).is_err());
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        4
    );
    assert_eq!(conn.query_row("SELECT count(*) FROM sqlite_master WHERE name IN ('notes_search','notes_search_ids','note_refs_search_ids')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(
        conn.query_row("SELECT body FROM notes", [], |r| r.get::<_, String>(0))
            .unwrap(),
        original.body
    );
    conn.execute_batch("DROP TABLE note_refs_search").unwrap();
    db::initialize_connection(&mut conn).unwrap();
    assert_eq!(candidates(&conn, "rare-migration-token").len(), 1);
}

#[test]
fn restore_and_relocation_update_indexes_atomically_including_failure() {
    let mut source = connection();
    let original = note();
    {
        let tx = source.transaction().unwrap();
        note_backup::apply(&tx, &[original.clone()]).unwrap();
        assert_eq!(candidates(&tx, "rare-migration-token").len(), 1);
        // Dropping the joint transaction must also roll back the derived index.
    }
    assert!(candidates(&source, "rare-migration-token").is_empty());
    note_backup::apply(&source, &[original.clone()]).unwrap();
    assert_eq!(note_backup::apply(&source, &[original]).unwrap().skipped, 1);
    let mut destination = connection();
    destination.execute_batch("CREATE TRIGGER qa_ref_failure BEFORE INSERT ON note_refs BEGIN SELECT RAISE(ABORT,'synthetic'); END").unwrap();
    assert!(
        storage::prepare_target(&source, &mut destination, "source", "destination", 10).is_err()
    );
    assert!(candidates(&destination, "rare-migration-token").is_empty());
    destination
        .execute_batch("DROP TRIGGER qa_ref_failure")
        .unwrap();
    storage::prepare_target(&source, &mut destination, "source", "destination", 10).unwrap();
    assert_eq!(candidates(&destination, "rare-migration-token").len(), 1);
    assert_eq!(candidates(&destination, "only-reference-token").len(), 1);
    assert!(candidates(&source, "rare-migration-token").len() == 1);
    assert_eq!(
        destination
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
}
