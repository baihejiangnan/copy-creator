//! Bounded substring candidates for ordinary notes and references. The caller
//! retains the exact literal LIKE predicate; protected records are not indexed.
use rusqlite::{params, Connection};
use std::collections::BTreeSet;

const MAX_CANDIDATES: usize = 1000;

pub(crate) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE notes_search_ids(search_id INTEGER PRIMARY KEY AUTOINCREMENT,note_id TEXT NOT NULL UNIQUE REFERENCES notes(id) ON DELETE CASCADE);
        CREATE TABLE note_refs_search_ids(search_id INTEGER PRIMARY KEY AUTOINCREMENT,ref_id TEXT NOT NULL UNIQUE REFERENCES note_refs(id) ON DELETE CASCADE);
        CREATE VIRTUAL TABLE notes_search USING fts5(title,body,content='',contentless_delete=1,detail=none,tokenize='trigram');
        CREATE VIRTUAL TABLE note_refs_search USING fts5(display_name,target,content='',contentless_delete=1,detail=none,tokenize='trigram');
        INSERT INTO notes_search_ids(note_id) SELECT id FROM notes;
        INSERT INTO note_refs_search_ids(ref_id) SELECT id FROM note_refs;
        INSERT INTO notes_search(rowid,title,body) SELECT m.search_id,n.title,n.body FROM notes n JOIN notes_search_ids m ON m.note_id=n.id;
        INSERT INTO note_refs_search(rowid,display_name,target) SELECT m.search_id,r.display_name,r.target FROM note_refs r JOIN note_refs_search_ids m ON m.ref_id=r.id;
        CREATE TRIGGER notes_search_insert AFTER INSERT ON notes BEGIN
          INSERT INTO notes_search_ids(note_id) VALUES(NEW.id);
          INSERT INTO notes_search(rowid,title,body) SELECT search_id,NEW.title,NEW.body FROM notes_search_ids WHERE note_id=NEW.id; END;
        CREATE TRIGGER notes_search_delete AFTER DELETE ON notes_search_ids BEGIN
          DELETE FROM notes_search WHERE rowid=OLD.search_id; END;
        CREATE TRIGGER notes_search_update AFTER UPDATE OF title,body ON notes BEGIN
          INSERT OR REPLACE INTO notes_search(rowid,title,body) SELECT search_id,NEW.title,NEW.body FROM notes_search_ids WHERE note_id=NEW.id; END;
        CREATE TRIGGER note_refs_search_insert AFTER INSERT ON note_refs BEGIN
          INSERT INTO note_refs_search_ids(ref_id) VALUES(NEW.id);
          INSERT INTO note_refs_search(rowid,display_name,target) SELECT search_id,NEW.display_name,NEW.target FROM note_refs_search_ids WHERE ref_id=NEW.id; END;
        CREATE TRIGGER note_refs_search_delete AFTER DELETE ON note_refs_search_ids BEGIN
          DELETE FROM note_refs_search WHERE rowid=OLD.search_id; END;
        CREATE TRIGGER note_refs_search_update AFTER UPDATE OF display_name,target ON note_refs BEGIN
          INSERT OR REPLACE INTO note_refs_search(rowid,display_name,target) SELECT search_id,NEW.display_name,NEW.target FROM note_refs_search_ids WHERE ref_id=NEW.id; END;")
}

fn query(search: &str) -> Option<String> {
    // LIKE stops at NUL; a trigram query over the suffix would change semantics.
    if search.contains('\0') {
        return None;
    }
    let chars: Vec<_> = search.chars().collect();
    if chars.len() < 3 {
        return None;
    }
    let count = (chars.len() - 2).min(16);
    let mut terms = BTreeSet::new();
    for index in 0..count {
        let start = if count == 1 {
            0
        } else {
            index * (chars.len() - 3) / (count - 1)
        };
        let term: String = chars[start..start + 3].iter().collect();
        terms.insert(format!("\"{}\"", term.replace('"', "\"\"")));
    }
    Some(terms.into_iter().collect::<Vec<_>>().join(" AND "))
}

/// A superset of exact literal matches. Caller still applies the original LIKE
/// predicate and state/cursor filters. Common terms fall back before building
/// a huge rowid set or sorting every matching note.
pub(crate) fn candidates(conn: &Connection, search: &str) -> rusqlite::Result<Option<Vec<i64>>> {
    let Some(query) = query(search) else {
        return Ok(None);
    };
    let mut result = BTreeSet::new();
    {
        let mut stmt = conn.prepare("SELECT n.rowid FROM notes_search f JOIN notes_search_ids m ON m.search_id=f.rowid JOIN notes n ON n.id=m.note_id WHERE notes_search MATCH ?1 LIMIT ?2")?;
        for value in stmt.query_map(params![query, (MAX_CANDIDATES + 1) as i64], |row| {
            row.get::<_, i64>(0)
        })? {
            result.insert(value?);
        }
    }
    if result.len() > MAX_CANDIDATES {
        return Ok(None);
    }
    let mut stmt = conn.prepare("SELECT DISTINCT n.rowid FROM note_refs_search f
        JOIN note_refs_search_ids m ON m.search_id=f.rowid JOIN note_refs r ON r.id=m.ref_id JOIN notes n ON n.id=r.note_id
        WHERE note_refs_search MATCH ?1 LIMIT ?2")?;
    for value in stmt.query_map(params![query, (MAX_CANDIDATES + 1) as i64], |row| {
        row.get::<_, i64>(0)
    })? {
        result.insert(value?);
        if result.len() > MAX_CANDIDATES {
            return Ok(None);
        }
    }
    Ok(Some(result.into_iter().collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE notes(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL);
            CREATE TABLE note_refs(id TEXT PRIMARY KEY,note_id TEXT REFERENCES notes(id) ON DELETE CASCADE,display_name TEXT,target TEXT);").unwrap();
        conn
    }
    fn literal(search: &str) -> String {
        format!(
            "%{}%",
            search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        )
    }
    #[test]
    fn trigram_candidates_preserve_literal_unicode_quotes_controls_and_short_queries() {
        let conn = db();
        let bodies = [
            "中文𠮷😀 中英文搜索",
            "100% _ \\ ' \" OR AND * abcDEF",
            "ßẞİıKéÉ English",
            "before\0after",
            "a\nb\rc\td  中  文",
            "普通正文",
        ];
        for (index, body) in bodies.iter().enumerate() {
            conn.execute(
                "INSERT INTO notes VALUES(?1,'',?2)",
                params![index.to_string(), body],
            )
            .unwrap();
        }
        conn.execute("INSERT INTO note_refs VALUES('ref','5','文件引用 中文','https://example.com/only-reference')",[]).unwrap();
        init_schema(&conn).unwrap();
        let mut searches = vec![
            "%_".to_string(),
            "%' OR 1=1 --".to_string(),
            "only-reference".to_string(),
            "文件引用".to_string(),
            "abcdeF".to_string(),
            "éÉ English".to_string(),
            "before\0other".to_string(),
        ];
        for body in bodies {
            let chars: Vec<_> = body.chars().collect();
            for start in 0..chars.len() {
                for size in 1..=8 {
                    if start + size <= chars.len() {
                        searches.push(chars[start..start + size].iter().collect());
                    }
                }
            }
        }
        for search in searches {
            let mut stmt=conn.prepare("SELECT n.rowid FROM notes n WHERE title LIKE ?1 ESCAPE '\\' OR body LIKE ?1 ESCAPE '\\' OR EXISTS(SELECT 1 FROM note_refs r WHERE r.note_id=n.id AND (r.display_name LIKE ?1 ESCAPE '\\' OR r.target LIKE ?1 ESCAPE '\\'))").unwrap();
            let exact: Vec<i64> = stmt
                .query_map([literal(&search)], |row| row.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            if let Some(candidates) = candidates(&conn, &search).unwrap() {
                assert!(
                    exact.iter().all(|id| candidates.contains(id)),
                    "Missing literal match for {search:?}: {exact:?} versus {candidates:?}"
                );
            }
        }
        assert_eq!(
            conn.query_row("SELECT title FROM notes_search LIMIT 1", [], |row| row
                .get::<_, Option<
                String,
            >>(
                0
            ))
            .unwrap(),
            None,
            "Index must not duplicate full content"
        );
    }
    #[test]
    fn indexes_follow_updates_reference_moves_deletion_and_rollback() {
        let mut conn = db();
        init_schema(&conn).unwrap();
        conn.execute("INSERT INTO notes VALUES('one','','old-body');", [])
            .unwrap();
        conn.execute("INSERT INTO notes VALUES('two','','second');", [])
            .unwrap();
        conn.execute(
            "INSERT INTO note_refs VALUES('ref','one','old-reference','old-target')",
            [],
        )
        .unwrap();
        assert_eq!(candidates(&conn, "old-reference").unwrap(), Some(vec![1]));
        conn.execute("UPDATE notes SET body='new-body' WHERE id='one'", [])
            .unwrap();
        assert_eq!(candidates(&conn, "old-body").unwrap(), Some(vec![]));
        assert_eq!(candidates(&conn, "new-body").unwrap(), Some(vec![1]));
        conn.execute("UPDATE note_refs SET note_id='two',display_name='new-reference',target='new-target' WHERE id='ref'",[]).unwrap();
        assert_eq!(candidates(&conn, "old-reference").unwrap(), Some(vec![]));
        assert_eq!(candidates(&conn, "new-reference").unwrap(), Some(vec![2]));
        {
            let tx = conn.transaction().unwrap();
            tx.execute(
                "UPDATE notes SET body='rolled-back-token' WHERE id='one'",
                [],
            )
            .unwrap();
        }
        assert_eq!(
            candidates(&conn, "rolled-back-token").unwrap(),
            Some(vec![])
        );
        assert_eq!(candidates(&conn, "new-body").unwrap(), Some(vec![1]));
        conn.execute("DELETE FROM notes WHERE id='two'", [])
            .unwrap();
        assert_eq!(candidates(&conn, "new-reference").unwrap(), Some(vec![]));
        conn.execute("UPDATE notes SET rowid=42 WHERE id='one'", [])
            .unwrap();
        assert_eq!(candidates(&conn, "new-body").unwrap(), Some(vec![42]));
        conn.execute_batch("VACUUM;").unwrap();
        let actual: i64 = conn
            .query_row("SELECT rowid FROM notes WHERE id='one'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            candidates(&conn, "new-body").unwrap(),
            Some(vec![actual]),
            "Search identities must survive VACUUM"
        );
        conn.execute("DELETE FROM notes WHERE id='one'", [])
            .unwrap();
        assert_eq!(candidates(&conn, "new-body").unwrap(), Some(vec![]));
    }
    #[test]
    fn common_candidates_and_failed_migration_remain_bounded() {
        let mut conn = db();
        init_schema(&conn).unwrap();
        {
            let tx = conn.transaction().unwrap();
            for index in 0..1001 {
                tx.execute(
                    "INSERT INTO notes VALUES(?1,'common-token','')",
                    [index.to_string()],
                )
                .unwrap();
            }
            tx.commit().unwrap();
        }
        assert_eq!(candidates(&conn, "common-token").unwrap(), None);
        assert_eq!(candidates(&conn, "absent-token").unwrap(), Some(vec![]));
        let mut broken = db();
        broken
            .execute_batch(
                "DROP TABLE note_refs; CREATE TABLE note_refs(id TEXT); PRAGMA user_version=4",
            )
            .unwrap();
        {
            let tx = broken.transaction().unwrap();
            assert!(init_schema(&tx).is_err());
        }
        assert_eq!(
            broken
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name='notes_search'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        assert_eq!(
            broken
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
    }
    fn stats(mut samples: Vec<f64>) -> serde_json::Value {
        samples.sort_by(f64::total_cmp);
        serde_json::json!({"samples":samples.len(),"p50_ms":samples[49],"p95_ms":samples[94],"p99_ms":samples[98],"max_ms":samples[99]})
    }
    #[test]
    #[ignore = "explicit Release candidate-index cost experiment"]
    fn candidate_index_release_experiment() {
        assert!(!cfg!(debug_assertions), "Use --release");
        let root =
            std::env::temp_dir().join(format!("copy-creator-search-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let database = root.join("data.db");
        let mut conn = Connection::open(&database).unwrap();
        crate::db::initialize_connection(&mut conn).unwrap();
        // This explicit cost comparison starts without the derived index even
        // after runtime schema 5 adoption. Only this disposable fixture is reset.
        conn.execute_batch(
            "DROP TRIGGER notes_search_insert; DROP TRIGGER notes_search_update;
            DROP TRIGGER notes_search_delete; DROP TRIGGER note_refs_search_insert;
            DROP TRIGGER note_refs_search_update; DROP TRIGGER note_refs_search_delete;
            DROP TABLE notes_search; DROP TABLE note_refs_search;
            DROP TABLE notes_search_ids; DROP TABLE note_refs_search_ids;
            PRAGMA user_version=4;",
        )
        .unwrap();
        let body = "中文 Mixed ABC 0123456789 https://example.com/\n".repeat(80);
        {
            let tx = conn.transaction().unwrap();
            for index in 0..50000 {
                let id = format!("fixture-{index}");
                tx.execute("INSERT INTO notes(id,title,body,summary,char_count,byte_count,created_at_ms,updated_at_ms,revision,creation_mutation_id,creation_hash,last_mutation_id,last_mutation_hash) VALUES(?1,'fixture-title',?2,'summary',?3,?4,1,1,1,?1,'hash',?1,'hash')",params![id,body,body.chars().count() as i64,body.len() as i64]).unwrap();
            }
            tx.commit().unwrap();
        }
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
        let before_bytes = std::fs::metadata(&database).unwrap().len();
        let mut report = serde_json::json!({"notes":50000,"bodyBytes":body.len(),"rawBytes":50000*body.len(),"scope":"Disk Release SQLite index cost comparison; native IPC measured separately"});
        let mut variants = Vec::new();
        for indexed in [false, true] {
            let start = Instant::now();
            if indexed {
                let tx = conn.transaction().unwrap();
                init_schema(&tx).unwrap();
                tx.commit().unwrap();
            }
            let migration_ms = start.elapsed().as_secs_f64() * 1000.;
            let mut operations = Vec::new();
            for operation in ["absent", "common", "save4k", "save256k"] {
                let mut samples = Vec::new();
                for iteration in 0..110 {
                    let start = Instant::now();
                    if operation == "absent" || operation == "common" {
                        let term = if operation == "absent" {
                            "not-found-scale-token"
                        } else {
                            "fixture-title"
                        };
                        let selected = if indexed {
                            candidates(&conn, term).unwrap()
                        } else {
                            None
                        };
                        if !matches!(&selected,Some(ids) if ids.is_empty()) {
                            let mut stmt=conn.prepare("SELECT id FROM notes WHERE title LIKE ?1 ESCAPE '\\' OR body LIKE ?1 ESCAPE '\\' LIMIT 51").unwrap();
                            let values: Vec<String> = stmt
                                .query_map([literal(term)], |r| r.get(0))
                                .unwrap()
                                .collect::<rusqlite::Result<_>>()
                                .unwrap();
                            assert_eq!(values.len(), if operation == "absent" { 0 } else { 51 });
                        }
                    } else {
                        let value = if operation == "save4k" {
                            body.clone()
                        } else {
                            "中A".repeat(65500)
                        } + &iteration.to_string();
                        conn.execute("UPDATE notes SET body=?1 WHERE id='fixture-0'", [value])
                            .unwrap();
                    }
                    if iteration >= 10 {
                        samples.push(start.elapsed().as_secs_f64() * 1000.);
                    }
                }
                operations
                    .push(serde_json::json!({"operation":operation,"latency":stats(samples)}));
            }
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                .unwrap();
            variants.push(serde_json::json!({"indexed":indexed,"migration_ms":migration_ms,"databaseBytes":std::fs::metadata(&database).unwrap().len(),"operations":operations}));
        }
        report["beforeDatabaseBytes"] = before_bytes.into();
        report["variants"] = variants.into();
        assert_eq!(
            conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        println!(
            "SEARCH_INDEX_EXPERIMENT {}",
            serde_json::to_string(&report).unwrap()
        );
        drop(conn);
        std::fs::remove_file(database).unwrap();
        std::fs::remove_dir(root).unwrap();
    }
}
