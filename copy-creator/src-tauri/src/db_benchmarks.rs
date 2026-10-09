//! Explicit, synthetic disk benchmarks; never part of the normal test run.
use rusqlite::{params, Connection};
use std::time::Instant;

fn distribution(mut values: Vec<f64>) -> serde_json::Value {
    values.sort_by(f64::total_cmp);
    let percentile = |p: f64| values[((values.len() as f64 * p).ceil() as usize).saturating_sub(1)];
    serde_json::json!({"samples":values.len(),"p50_ms":percentile(0.5),"p95_ms":percentile(0.95),"max_ms":values.last()})
}

#[test]
#[ignore = "explicit Release disk durability/write-cost comparison"]
fn disk_durability_release_benchmark() {
    assert!(!cfg!(debug_assertions), "Run with --release");
    let root = std::env::temp_dir().join(format!("copy-creator-durability-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let mut results = Vec::new();
    // Alternate settings/order across two passes to expose order sensitivity.
    for (pass, levels) in [["NORMAL", "FULL"], ["FULL", "NORMAL"]].iter().enumerate() {
        for level in levels {
            for accounting in [false, true] {
                let file = root.join(format!("{pass}-{level}-{accounting}.db"));
                let mut conn = Connection::open(&file).unwrap();
                crate::db::initialize_connection(&mut conn).unwrap();
                conn.execute_batch(&format!("PRAGMA synchronous={level}")).unwrap();
                if !accounting {
                    conn.execute_batch("DROP TRIGGER clipboard_usage_insert; DROP TRIGGER clipboard_usage_delete; DROP TRIGGER clipboard_usage_update; DROP TRIGGER clipboard_asset_accounting;").unwrap();
                }
                let small = "中A".repeat(1024); // exactly 4 KiB UTF-8
                let large = "中A".repeat(65536); // exactly 256 KiB UTF-8
                conn.execute("INSERT INTO notes(id,title,body,summary,char_count,byte_count,created_at_ms,updated_at_ms,revision,creation_mutation_id,creation_hash,last_mutation_id,last_mutation_hash) VALUES('fixture','fixture',?1,'fixture',2048,4096,1,1,1,'create','hash','create','hash')",[&small]).unwrap();
                conn.execute("INSERT INTO phrase_groups VALUES('fixture','fixture',0,'now','now')",[]).unwrap();
                let mut operations = Vec::new();
                for operation in ["clipboard_4k", "note_4k", "note_256k", "settings", "phrase_4k", "translation_4k", "vault_ciphertext_4k"] {
                    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
                    let mut durations = Vec::new();
                    for iteration in 0..110 {
                        let id = format!("{operation}-{iteration}");
                        let start = Instant::now();
                        let tx = conn.transaction().unwrap();
                        match operation {
                            "clipboard_4k" => {
                                tx.execute("INSERT INTO clipboard_records(id,type,content,created_at) VALUES(?1,'text',?2,?1)",params![id,small]).unwrap();
                                if accounting { std::hint::black_box(crate::clipboard_usage::get(&tx).unwrap()); }
                            }
                            "note_4k" | "note_256k" => {
                                let body = if operation == "note_4k" { &small } else { &large };
                                tx.execute("UPDATE notes SET body=?1,byte_count=?2,char_count=?3,updated_at_ms=?4,revision=revision+1,last_mutation_id=?5 WHERE id='fixture'",params![body,body.len(),body.chars().count(),iteration,id]).unwrap();
                                std::hint::black_box(tx.query_row("SELECT body FROM notes WHERE id='fixture'",[],|r|r.get::<_,String>(0)).unwrap());
                            }
                            "settings" => { tx.execute("UPDATE settings SET value=?1 WHERE key='theme'",[id]).unwrap(); }
                            "phrase_4k" => { tx.execute("INSERT INTO phrases VALUES(?1,'fixture','fixture',?2,0,'now','now')",params![id,small]).unwrap(); }
                            "translation_4k" => { tx.execute("INSERT INTO translation_history VALUES(?1,?2,?2,'auto','en','fixture','now')",params![id,small]).unwrap(); }
                            "vault_ciphertext_4k" => { tx.execute("INSERT INTO vault_entries(id,encrypted_data,created_at,updated_at) VALUES(?1,?2,'now','now')",params![id,small]).unwrap(); }
                            _ => unreachable!(),
                        }
                        tx.commit().unwrap();
                        let ms = start.elapsed().as_secs_f64() * 1000.;
                        if iteration >= 10 { durations.push(ms); }
                    }
                    operations.push(serde_json::json!({"operation":operation,"latency":distribution(durations)}));
                }
                assert_eq!(conn.query_row("SELECT revision FROM notes WHERE id='fixture'",[],|r|r.get::<_,i64>(0)).unwrap(),221);
                if accounting { assert_eq!(crate::clipboard_usage::get(&conn).unwrap().records,110); }
                conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
                drop(conn);
                let reopened = Connection::open(&file).unwrap();
                assert_eq!(reopened.query_row("PRAGMA integrity_check",[],|r|r.get::<_,String>(0)).unwrap(),"ok");
                assert_eq!(reopened.query_row("SELECT count(*) FROM translation_history",[],|r|r.get::<_,i64>(0)).unwrap(),110);
                drop(reopened);
                std::fs::remove_file(file).unwrap();
                results.push(serde_json::json!({"pass":pass,"synchronous":level,"accounting_triggers":accounting,"operations":operations}));
            }
        }
    }
    // SQLite may retain empty WAL/SHM sidecars. Only remove files in this exact
    // newly-created fixture directory, never a user-supplied path.
    for entry in std::fs::read_dir(&root).unwrap() { std::fs::remove_file(entry.unwrap().path()).unwrap(); }
    std::fs::remove_dir(root).unwrap();
    println!("BENCHMARK_JSON {}",serde_json::json!({"kind":"disk-durability-write-cost","profile":"release","sqlite":"bundled","fixture":{"small_bytes":4096,"large_bytes":262144,"warmup":10,"samples":100},"results":results,"scope":"synthetic local disk WAL transaction/query/commit cost; same schema/indexes with only accounting triggers toggled; excludes hashing, IPC, encryption and frontend; clean reopen is not a power-loss simulation"}));
}
