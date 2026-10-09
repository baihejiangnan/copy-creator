//! Transactional clipboard accounting. Triggers cover capture, edits, imports
//! and cleanup, so callers cannot accidentally omit a counter update.
use rusqlite::{params, Connection};

pub(crate) struct Usage {
    pub records: u64,
    pub favorites: u64,
    pub bytes: u64,
}

pub(crate) fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE clipboard_usage (
          id INTEGER PRIMARY KEY CHECK(id=1), record_count INTEGER NOT NULL,
          favorite_count INTEGER NOT NULL, content_bytes INTEGER NOT NULL,
          image_bytes INTEGER NOT NULL
        );
        CREATE TABLE clipboard_assets (
          path TEXT PRIMARY KEY, ref_count INTEGER NOT NULL CHECK(ref_count>=0),
          byte_size INTEGER NOT NULL CHECK(byte_size>=0)
        );
        INSERT INTO clipboard_usage SELECT 1,COUNT(*),COALESCE(SUM(is_favorite<>0),0),
          COALESCE(SUM(CASE WHEN type<>'image' THEN length(CAST(content AS BLOB)) ELSE 0 END),0),0 FROM clipboard_records;
        INSERT INTO clipboard_assets SELECT content,COUNT(*),0 FROM clipboard_records WHERE type='image' GROUP BY content;
        CREATE TRIGGER clipboard_asset_accounting AFTER UPDATE OF ref_count,byte_size ON clipboard_assets BEGIN
          UPDATE clipboard_usage SET image_bytes=image_bytes
            +CASE WHEN NEW.ref_count>0 THEN NEW.byte_size ELSE 0 END
            -CASE WHEN OLD.ref_count>0 THEN OLD.byte_size ELSE 0 END WHERE id=1;
        END;
        CREATE TRIGGER clipboard_usage_insert AFTER INSERT ON clipboard_records BEGIN
          UPDATE clipboard_usage SET record_count=record_count+1,favorite_count=favorite_count+(NEW.is_favorite<>0),
            content_bytes=content_bytes+CASE WHEN NEW.type<>'image' THEN length(CAST(NEW.content AS BLOB)) ELSE 0 END WHERE id=1;
          INSERT INTO clipboard_assets(path,ref_count,byte_size) SELECT NEW.content,0,0 WHERE NEW.type='image' ON CONFLICT(path) DO NOTHING;
          UPDATE clipboard_assets SET ref_count=ref_count+1 WHERE path=NEW.content AND NEW.type='image';
        END;
        CREATE TRIGGER clipboard_usage_delete AFTER DELETE ON clipboard_records BEGIN
          UPDATE clipboard_usage SET record_count=record_count-1,favorite_count=favorite_count-(OLD.is_favorite<>0),
            content_bytes=content_bytes-CASE WHEN OLD.type<>'image' THEN length(CAST(OLD.content AS BLOB)) ELSE 0 END WHERE id=1;
          UPDATE clipboard_assets SET ref_count=ref_count-1 WHERE path=OLD.content AND OLD.type='image';
        END;
        CREATE TRIGGER clipboard_usage_update AFTER UPDATE OF type,content,is_favorite ON clipboard_records BEGIN
          UPDATE clipboard_usage SET favorite_count=favorite_count+(NEW.is_favorite<>0)-(OLD.is_favorite<>0),
            content_bytes=content_bytes+CASE WHEN NEW.type<>'image' THEN length(CAST(NEW.content AS BLOB)) ELSE 0 END
              -CASE WHEN OLD.type<>'image' THEN length(CAST(OLD.content AS BLOB)) ELSE 0 END WHERE id=1;
          UPDATE clipboard_assets SET ref_count=ref_count-1 WHERE path=OLD.content AND OLD.type='image' AND (NEW.type<>'image' OR OLD.content<>NEW.content);
          INSERT INTO clipboard_assets(path,ref_count,byte_size) SELECT NEW.content,0,0 WHERE NEW.type='image' AND (OLD.type<>'image' OR OLD.content<>NEW.content) ON CONFLICT(path) DO NOTHING;
          UPDATE clipboard_assets SET ref_count=ref_count+1 WHERE path=NEW.content AND NEW.type='image' AND (OLD.type<>'image' OR OLD.content<>NEW.content);
        END;
        CREATE INDEX idx_clipboard_cursor ON clipboard_records(created_at DESC,id DESC);
        CREATE INDEX idx_clipboard_type_cursor ON clipboard_records(type,created_at DESC,id DESC);
        CREATE INDEX idx_clipboard_favorite_cursor ON clipboard_records(is_favorite,created_at DESC,id DESC);
        CREATE INDEX idx_clipboard_image_asset ON clipboard_records(content) WHERE type='image';
        CREATE INDEX idx_clipboard_asset_reclaim ON clipboard_assets(ref_count,path);",
    )?;
    // Existing assets are measured once during schema migration, without loading
    // image bodies. In-memory test databases have no on-disk asset directory.
    if let Some(base) = conn.path().and_then(|path| std::path::Path::new(path).parent()) {
        let mut statement = conn.prepare("SELECT path FROM clipboard_assets")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        for path in rows {
            let path = path?;
            set_asset_size(conn, &path, crate::db::stored_image_size(base, &path))?;
        }
    }
    Ok(())
}

pub(crate) fn set_asset_size(conn: &Connection, path: &str, bytes: u64) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO clipboard_assets(path,ref_count,byte_size) VALUES(?1,0,?2) ON CONFLICT(path) DO UPDATE SET byte_size=excluded.byte_size", params![path, bytes.min(i64::MAX as u64) as i64])?;
    Ok(())
}

pub(crate) fn get(conn: &Connection) -> rusqlite::Result<Usage> {
    conn.query_row("SELECT record_count,favorite_count,content_bytes+image_bytes+record_count*256 FROM clipboard_usage WHERE id=1", [], |row| {
        Ok(Usage { records: row.get(0)?, favorites: row.get(1)?, bytes: row.get(2)? })
    })
}

// Rotate bounded retries so permanently locked/invalid early paths cannot
// starve later reclaimable assets. Both ranges use the (ref_count,path) index.
pub(crate) fn reclaim_candidates(conn: &Connection, after: Option<&str>) -> rusqlite::Result<Vec<String>> {
    let mut result: Vec<String>;
    if let Some(after) = after {
        let mut statement = conn.prepare("SELECT path FROM clipboard_assets WHERE ref_count=0 AND path>?1 ORDER BY path LIMIT 100")?;
        result = statement.query_map([after], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
        if result.len() < 100 {
            let mut statement = conn.prepare("SELECT path FROM clipboard_assets WHERE ref_count=0 AND path<=?1 ORDER BY path LIMIT ?2")?;
            result.extend(statement.query_map(params![after, 100 - result.len()], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
        }
    } else {
        let mut statement = conn.prepare("SELECT path FROM clipboard_assets WHERE ref_count=0 ORDER BY path LIMIT 100")?;
        result = statement.query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
    }
    Ok(result)
}

// Only a bounded page of IDs/image paths is materialized. Counters are read
// after each deletion so a shared asset is charged until its last reference.
pub(crate) fn cleanup_batch(conn: &mut Connection, max_items: u64, max_bytes: u64) -> rusqlite::Result<Vec<(String, Option<String>)>> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let candidates = {
        let mut statement = tx.prepare("SELECT id,CASE WHEN type='image' THEN content END FROM clipboard_records
            WHERE is_favorite=0 AND user_api_key=0 AND content NOT LIKE 'dpapi:v1:%'
            AND NOT EXISTS(SELECT 1 FROM api_key_labels l WHERE l.record_id=clipboard_records.id)
            ORDER BY created_at ASC,id ASC LIMIT 100")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_,String>(0)?,row.get::<_,Option<String>>(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut deleted = Vec::new();
    for (id, image) in candidates {
        let usage = get(&tx)?;
        if usage.records <= max_items && usage.bytes <= max_bytes { break; }
        tx.execute("DELETE FROM clipboard_records WHERE id=?1", [&id])?;
        deleted.push((id, image));
    }
    tx.commit()?;
    Ok(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE clipboard_records(id TEXT PRIMARY KEY,type TEXT NOT NULL,content TEXT NOT NULL,is_favorite INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT 'now');").unwrap();
        init_schema(&conn).unwrap(); conn
    }
    #[test]
    fn utf8_edits_favorites_and_transaction_rollback_keep_exact_counters() {
        let mut conn=db();
        conn.execute("INSERT INTO clipboard_records(id,type,content) VALUES('a','text','中文')",[]).unwrap();
        assert_eq!(get(&conn).unwrap().bytes,262);
        conn.execute("UPDATE clipboard_records SET content='hello',is_favorite=1 WHERE id='a'",[]).unwrap();
        let before=get(&conn).unwrap(); assert_eq!(before.bytes,261);assert_eq!(before.favorites,1);
        {let tx=conn.transaction().unwrap();tx.execute("DELETE FROM clipboard_records",[]).unwrap();assert_eq!(get(&tx).unwrap().records,0);}
        assert_eq!(get(&conn).unwrap().bytes,before.bytes);
        conn.execute("DELETE FROM clipboard_records",[]).unwrap();assert_eq!(get(&conn).unwrap().bytes,0);
    }
    #[test]
    fn shared_images_are_counted_once_and_resizing_or_converting_updates_usage() {
        let conn=db(); set_asset_size(&conn,"images/a.png",1000).unwrap();
        assert_eq!(get(&conn).unwrap().bytes,0);
        conn.execute_batch("INSERT INTO clipboard_records(id,type,content) VALUES('a','image','images/a.png'),('b','image','images/a.png');").unwrap();
        assert_eq!(get(&conn).unwrap().bytes,1512);
        set_asset_size(&conn,"images/a.png",1500).unwrap();assert_eq!(get(&conn).unwrap().bytes,2012);
        conn.execute("UPDATE clipboard_records SET type='text',content='中' WHERE id='a'",[]).unwrap();assert_eq!(get(&conn).unwrap().bytes,2015);
        conn.execute("DELETE FROM clipboard_records WHERE id='b'",[]).unwrap();assert_eq!(get(&conn).unwrap().bytes,259);
        assert_eq!(conn.query_row("SELECT ref_count FROM clipboard_assets WHERE path='images/a.png'",[],|row|row.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn changing_an_image_path_preserves_other_references_and_known_asset_sizes() {
        let conn=db();set_asset_size(&conn,"a",100).unwrap();set_asset_size(&conn,"b",200).unwrap();
        conn.execute_batch("INSERT INTO clipboard_records(id,type,content) VALUES('a','image','a'),('b','image','a');UPDATE clipboard_records SET content='b' WHERE id='a';").unwrap();
        assert_eq!(get(&conn).unwrap().bytes,812);
        conn.execute("DELETE FROM clipboard_records WHERE id='b'",[]).unwrap();assert_eq!(get(&conn).unwrap().bytes,456);
    }

    fn cleanup_db() -> Connection {
        let conn=db();
        conn.execute_batch("ALTER TABLE clipboard_records ADD COLUMN user_api_key INTEGER NOT NULL DEFAULT 0; CREATE TABLE api_key_labels(record_id TEXT PRIMARY KEY);").unwrap();
        conn
    }
    #[test]
    fn cleanup_is_bounded_exact_and_preserves_every_protection_kind() {
        let mut conn=cleanup_db();
        conn.execute_batch("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<205)
            INSERT INTO clipboard_records(id,type,content) SELECT printf('%03d',x),'text','body' FROM n;
            INSERT INTO clipboard_records(id,type,content,is_favorite,user_api_key) VALUES
            ('favorite','text','body',1,0),('manual','text','body',0,1),('dpapi','text','dpapi:v1:fixture',0,0),('label','text','body',0,0);
            INSERT INTO api_key_labels VALUES('label');").unwrap();
        assert_eq!(cleanup_batch(&mut conn,0,0).unwrap().len(),100);
        assert_eq!(cleanup_batch(&mut conn,0,0).unwrap().len(),100);
        assert_eq!(cleanup_batch(&mut conn,5,u64::MAX).unwrap().len(),4);
        assert_eq!(get(&conn).unwrap().records,5);
        assert_eq!(cleanup_batch(&mut conn,0,0).unwrap().len(),1);
        assert!(cleanup_batch(&mut conn,0,0).unwrap().is_empty());
        assert_eq!(get(&conn).unwrap().records,4);
    }
    #[test]
    fn cleanup_observes_last_image_reference_and_rolls_back_failed_batches() {
        let mut conn=cleanup_db(); set_asset_size(&conn,"images/shared.png",1000).unwrap();
        conn.execute_batch("INSERT INTO clipboard_records(id,type,content) VALUES('a','image','images/shared.png'),('b','image','images/shared.png'),('c','text','keep');").unwrap();
        assert_eq!(cleanup_batch(&mut conn,u64::MAX,300).unwrap().len(),2);
        assert_eq!(get(&conn).unwrap().bytes,260);
        conn.execute_batch("INSERT INTO clipboard_records(id,type,content) VALUES('d','text','body'); CREATE TRIGGER refuse_d BEFORE DELETE ON clipboard_records WHEN OLD.id='d' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(cleanup_batch(&mut conn,0,0).is_err());
        assert_eq!(get(&conn).unwrap().records,2);
        assert_eq!(get(&conn).unwrap().bytes,520);
    }
}
