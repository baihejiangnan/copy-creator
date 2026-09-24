use base64::Engine;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use chrono::TimeZone;

// === API Key Detection ===

pub fn is_api_key(content: &str) -> bool {
    let content = content.trim();
    if content.len() < 20 || content.len() > 200 {
        return false;
    }
    if content.contains('\n') || content.contains(' ') {
        return false;
    }
    let patterns = ["sk-", "AIza", "glpat-", "ghp_", "xai-"];
    patterns.iter().any(|p| content.starts_with(p))
}

pub fn guess_service(content: &str) -> Option<&'static str> {
    if content.starts_with("AIza") {
        return Some("Gemini");
    }
    if content.starts_with("glpat-") {
        return Some("GitLab");
    }
    if content.starts_with("ghp_") {
        return Some("GitHub");
    }
    if content.starts_with("xai-") {
        return Some("Grok");
    }
    None
}

pub fn make_key_preview(content: &str) -> String {
    let c = content.trim();
    if c.len() >= 12 {
        format!("{}...{}", &c[..8], &c[c.len() - 4..])
    } else {
        c.to_string()
    }
}

fn category_sql(category: &Option<String>) -> (String, String) {
    match category.as_deref() {
        Some("text") => ("WHERE type = 'text'".to_string(), "AND type = 'text'".to_string()),
        Some("image") => ("WHERE type = 'image'".to_string(), "AND type = 'image'".to_string()),
        Some("link") => ("WHERE type = 'link'".to_string(), "AND type = 'link'".to_string()),
        Some("explorer") => (
            "WHERE type = 'explorer'".to_string(),
            "AND type = 'explorer'".to_string(),
        ),
        Some("file") => ("WHERE type = 'file'".to_string(), "AND type = 'file'".to_string()),
        Some("favorite") => (
            "WHERE is_favorite = 1".to_string(),
            "AND is_favorite = 1".to_string(),
        ),
        Some("apikey") => (
            "WHERE (user_api_key = 1 OR (type IN ('text', 'link') AND (content LIKE 'dpapi:v1:%' OR content LIKE 'sk-%' OR content LIKE 'AIza%' OR content LIKE 'glpat-%' OR content LIKE 'ghp_%' OR content LIKE 'xai-%')))".to_string(),
            "AND (user_api_key = 1 OR (type IN ('text', 'link') AND (content LIKE 'sk-%' OR content LIKE 'AIza%' OR content LIKE 'glpat-%' OR content LIKE 'ghp_%' OR content LIKE 'xai-%')))".to_string(),
        ),
        _ => ("".to_string(), "".to_string()),
    }
}

pub fn is_toast_shown_internal(app: &AppHandle, key_preview: &str) -> bool {
    let state = app.state::<DbState>();
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(_) => return false,
    };
    conn.query_row(
        "SELECT 1 FROM toast_shown WHERE key_preview = ?1",
        params![key_preview],
        |_| Ok(true),
    )
    .unwrap_or(false)
}

pub fn mark_toast_shown_internal(app: &AppHandle, key_preview: &str) {
    let state = app.state::<DbState>();
    let conn = match state.conn.lock() {
        Ok(c) => c,
        Err(_) => return,
    };
    conn.execute(
        "INSERT OR IGNORE INTO toast_shown (key_preview) VALUES (?1)",
        params![key_preview],
    )
    .ok();
}

pub struct DbState {
    pub conn: Mutex<Connection>,
}

fn migrate_secrets(conn: &mut Connection) -> Result<(), String> {
    let settings: Vec<(String, String)> = {
        let mut stmt = conn.prepare("SELECT key, value FROM settings WHERE key IN ('ai_api_key', 'google_api_key', 'baidu_secret') AND value <> ''").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
        rows
    };
    let clipboard: Vec<(String, String, bool)> = {
        let mut stmt = conn.prepare("SELECT id, content, user_api_key FROM clipboard_records WHERE type IN ('text', 'link')").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?;
        rows
    };
    let mut updates = Vec::new();
    for (key, value) in settings {
        if !crate::secrets::is_protected(&value) {
            updates.push((true, key, crate::secrets::protect(&value)?));
        }
    }
    for (id, value, user_key) in clipboard {
        if !crate::secrets::is_protected(&value) && (user_key || is_api_key(&value)) {
            updates.push((false, id, crate::secrets::protect(&value)?));
        }
    }
    if updates.is_empty() { return Ok(()); }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for (setting, key, value) in updates {
        let sql = if setting { "UPDATE settings SET value = ?2 WHERE key = ?1" } else { "UPDATE clipboard_records SET content = ?2 WHERE id = ?1" };
        tx.execute(sql, params![key, value]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;").map_err(|e| e.to_string())?;
    Ok(())
}

const CLIPBOARD_CONTENT_PREVIEW_CHARS: usize = 600;
const FAVORITE_NOTE_MAX_CHARS: usize = 200;

fn make_content_preview(content: &str) -> (String, i64, bool) {
    let total_chars = content.chars().count();
    if total_chars <= CLIPBOARD_CONTENT_PREVIEW_CHARS {
        return (content.to_string(), total_chars as i64, false);
    }

    (
        content
            .chars()
            .take(CLIPBOARD_CONTENT_PREVIEW_CHARS)
            .collect::<String>(),
        total_chars as i64,
        true,
    )
}

fn clipboard_record_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value> {
    let id = row.get::<_, String>(0)?;
    let rec_type = row.get::<_, String>(1)?;
    let content = row.get::<_, String>(2)?;
    let source_app = row.get::<_, String>(3)?;
    let created_at = row.get::<_, String>(4)?;
    let user_api_key = row.get::<_, i64>(5)?;
    let is_favorite = row.get::<_, i64>(6)?;
    let favorite_note = row.get::<_, String>(7)?;
    let is_key = (rec_type == "text" || rec_type == "link")
        && (user_api_key != 0 || crate::secrets::is_protected(&content) || is_api_key(&content));
    let key_value = if is_key { crate::secrets::reveal(&content).unwrap_or_default() } else { String::new() };
    let (list_content, content_length, content_truncated) = if is_key {
        (make_key_preview(&key_value), 0, false)
    } else if rec_type == "text" {
        make_content_preview(&content)
    } else {
        (content, 0, false)
    };
    let content_length = if content_length == 0 {
        list_content.chars().count() as i64
    } else {
        content_length
    };

    Ok(serde_json::json!({
        "id": id,
        "type": rec_type,
        "content": list_content,
        "content_length": content_length,
        "content_truncated": content_truncated,
        "source_app": source_app,
        "created_at": created_at,
        "user_api_key": user_api_key,
        "is_api_key": is_key,
        "key_preview": if is_key { make_key_preview(&key_value) } else { String::new() },
        "guessed_service": if is_key { guess_service(&key_value) } else { None },
        "is_favorite": is_favorite != 0,
        "favorite_note": favorite_note,
    }))
}

fn db_path(app: &AppHandle) -> PathBuf {
    let default_dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");
    let default_db = default_dir.join("data.db");
    std::fs::create_dir_all(&default_dir).ok();

    if !default_db.exists() {
        return default_db;
    }

    let mut current = default_db;
    let mut visited: HashSet<PathBuf> = HashSet::new();

    loop {
        let conn = match Connection::open(&current) {
            Ok(c) => c,
            Err(_) => break,
        };

        let path: String = match conn.query_row(
            "SELECT value FROM settings WHERE key = 'storage_path'",
            [],
            |row| row.get::<_, String>(0),
        ) {
            Ok(p) if !p.is_empty() => p,
            _ => break,
        };

        let custom_dir = PathBuf::from(&path);
        let custom_db = custom_dir.join("data.db");

        if custom_db == current || !visited.insert(custom_db.clone()) {
            break;
        }

        if !custom_db.exists() {
            break;
        }

        current = custom_db;
    }

    current
}

pub fn get_storage_dir(app: &AppHandle) -> PathBuf {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().unwrap();
    if let Ok(path) = conn.query_row(
        "SELECT value FROM settings WHERE key = 'storage_path'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        if !path.is_empty() {
            let custom_dir = PathBuf::from(&path);
            if custom_dir.exists() || std::fs::create_dir_all(&custom_dir).is_ok() {
                return custom_dir;
            }
        }
    }
    drop(conn);
    app.path()
        .app_data_dir()
        .expect("failed to get app data dir")
}

const DEFAULT_MAX_HISTORY_ITEMS: u64 = 2_000;
const DEFAULT_MAX_STORAGE_MB: u64 = 500;
const RECORD_OVERHEAD_BYTES: u64 = 256;

fn setting_u64(conn: &Connection, key: &str, default: u64) -> u64 {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|value| value.parse::<u64>().ok())
    .filter(|value| *value > 0)
    .unwrap_or(default)
}

fn storage_content_path(base_dir: &Path, content: &str) -> Option<PathBuf> {
    let relative = Path::new(content);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return None;
    }
    Some(base_dir.join(relative))
}

fn remove_stored_image(base_dir: &Path, content: &str) {
    let Some(file_path) = storage_content_path(base_dir, content) else {
        return;
    };
    let _ = std::fs::remove_file(&file_path);
    if let Some(filename) = file_path.file_name() {
        let thumb_path = file_path
            .parent()
            .unwrap_or(base_dir)
            .join("thumbs")
            .join(filename);
        let _ = std::fs::remove_file(thumb_path);
    }
}

fn stored_image_size(base_dir: &Path, content: &str) -> u64 {
    let Some(file_path) = storage_content_path(base_dir, content) else {
        return 0;
    };
    let mut size = std::fs::metadata(&file_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    if let Some(filename) = file_path.file_name() {
        let thumb_path = file_path
            .parent()
            .unwrap_or(base_dir)
            .join("thumbs")
            .join(filename);
        size = size.saturating_add(
            std::fs::metadata(thumb_path)
                .map(|metadata| metadata.len())
                .unwrap_or(0),
        );
    }
    size
}

#[derive(Clone)]
struct UsageRecord {
    id: String,
    record_type: String,
    content: String,
    is_favorite: bool,
}

fn load_usage_records(conn: &Connection) -> Result<Vec<UsageRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, type, content, is_favorite FROM clipboard_records ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(UsageRecord {
                id: row.get(0)?,
                record_type: row.get(1)?,
                content: row.get(2)?,
                is_favorite: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn usage_bytes(
    records: &[UsageRecord],
    base_dir: &Path,
) -> (u64, HashMap<String, u64>, HashMap<String, u64>) {
    let mut total = records.len() as u64 * RECORD_OVERHEAD_BYTES;
    let mut image_refs: HashMap<String, u64> = HashMap::new();
    let mut image_sizes: HashMap<String, u64> = HashMap::new();

    for record in records {
        if record.record_type == "image" {
            *image_refs.entry(record.content.clone()).or_default() += 1;
            image_sizes
                .entry(record.content.clone())
                .or_insert_with(|| stored_image_size(base_dir, &record.content));
        } else {
            total = total.saturating_add(record.content.len() as u64);
        }
    }

    total = total.saturating_add(image_sizes.values().sum::<u64>());
    (total, image_refs, image_sizes)
}

pub fn enforce_clipboard_limits(app: &AppHandle) -> Result<usize, String> {
    let base_dir = get_storage_dir(app);
    let (deleted_ids, orphaned_images) = {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        let max_items = setting_u64(&conn, "max_history_items", DEFAULT_MAX_HISTORY_ITEMS);
        let max_bytes = setting_u64(&conn, "max_storage_mb", DEFAULT_MAX_STORAGE_MB)
            .saturating_mul(1024 * 1024);
        let records = load_usage_records(&conn)?;
        let mut count = records.len() as u64;
        let (mut bytes, mut image_refs, image_sizes) = usage_bytes(&records, &base_dir);
        let mut deleted_ids = Vec::new();
        let mut orphaned_images = Vec::new();

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for record in records.iter().filter(|record| !record.is_favorite) {
            if count <= max_items && bytes <= max_bytes {
                break;
            }

            tx.execute(
                "DELETE FROM api_key_labels WHERE record_id = ?1",
                params![record.id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM clipboard_records WHERE id = ?1",
                params![record.id],
            )
            .map_err(|e| e.to_string())?;

            count = count.saturating_sub(1);
            bytes = bytes.saturating_sub(RECORD_OVERHEAD_BYTES);
            if record.record_type == "image" {
                if let Some(ref_count) = image_refs.get_mut(&record.content) {
                    *ref_count = ref_count.saturating_sub(1);
                    if *ref_count == 0 {
                        bytes = bytes
                            .saturating_sub(image_sizes.get(&record.content).copied().unwrap_or(0));
                        orphaned_images.push(record.content.clone());
                    }
                }
            } else {
                bytes = bytes.saturating_sub(record.content.len() as u64);
            }
            deleted_ids.push(record.id.clone());
        }
        tx.commit().map_err(|e| e.to_string())?;
        (deleted_ids, orphaned_images)
    };

    for content in orphaned_images {
        remove_stored_image(&base_dir, &content);
    }
    for id in &deleted_ids {
        let _ = app.emit("clipboard-deleted", id);
    }

    Ok(deleted_ids.len())
}

#[tauri::command]
pub fn get_clipboard_storage_stats(app: AppHandle) -> Result<serde_json::Value, String> {
    let base_dir = get_storage_dir(&app);
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let records = load_usage_records(&conn)?;
    let (bytes, _, _) = usage_bytes(&records, &base_dir);
    let favorite_count = records.iter().filter(|record| record.is_favorite).count();
    let max_items = setting_u64(&conn, "max_history_items", DEFAULT_MAX_HISTORY_ITEMS);
    let max_storage_mb = setting_u64(&conn, "max_storage_mb", DEFAULT_MAX_STORAGE_MB);

    Ok(serde_json::json!({
        "record_count": records.len(),
        "favorite_count": favorite_count,
        "usage_bytes": bytes,
        "max_history_items": max_items,
        "max_storage_bytes": max_storage_mb.saturating_mul(1024 * 1024),
        "over_limit": records.len() as u64 > max_items
            || bytes > max_storage_mb.saturating_mul(1024 * 1024),
    }))
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in rows {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn migrate_clipboard_record_schema(conn: &Connection) -> rusqlite::Result<()> {
    if !table_has_column(conn, "clipboard_records", "user_api_key")? {
        conn.execute(
            "ALTER TABLE clipboard_records ADD COLUMN user_api_key INTEGER DEFAULT 0",
            [],
        )?;
    }
    if !table_has_column(conn, "clipboard_records", "is_favorite")? {
        conn.execute(
            "ALTER TABLE clipboard_records ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !table_has_column(conn, "clipboard_records", "favorite_note")? {
        conn.execute(
            "ALTER TABLE clipboard_records ADD COLUMN favorite_note TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_clipboard_favorite_created_at ON clipboard_records(is_favorite, created_at)",
        [],
    )?;
    let migrated = migrate_explorer_addresses(conn)?;
    if migrated > 0 {
        log::info!("reclassified {migrated} clipboard records as Explorer addresses");
    }
    Ok(())
}

fn migrate_explorer_addresses(conn: &Connection) -> rusqlite::Result<usize> {
    let candidates = {
        let mut stmt =
            conn.prepare("SELECT id, content FROM clipboard_records WHERE type = 'text'")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };

    let mut update =
        conn.prepare("UPDATE clipboard_records SET type = 'explorer' WHERE id = ?1")?;
    let mut migrated = 0;
    for (id, content) in candidates {
        if crate::clipboard::is_explorer_address(&content) {
            migrated += update.execute(params![id])?;
        }
    }
    Ok(migrated)
}

pub fn init_db(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = db_path(app);
    let mut conn = Connection::open(&path)?;

    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-8000;",
    )?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS clipboard_records (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL,
            content TEXT NOT NULL,
            source_app TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            user_api_key INTEGER DEFAULT 0,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            favorite_note TEXT NOT NULL DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_clipboard_created_at
            ON clipboard_records(created_at);

        CREATE TABLE IF NOT EXISTS phrase_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS phrases (
            id TEXT PRIMARY KEY,
            group_id TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (group_id) REFERENCES phrase_groups(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS translation_history (
            id TEXT PRIMARY KEY,
            source_text TEXT NOT NULL,
            target_text TEXT NOT NULL,
            source_lang TEXT DEFAULT 'auto',
            target_lang TEXT NOT NULL,
            engine TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_translation_created_at
            ON translation_history(created_at);

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        INSERT OR IGNORE INTO settings (key, value) VALUES ('clipboard_retention', '1month');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('dedupe_window_seconds', '900');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('default_translate_engine', 'google');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'light');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('language', 'zh-CN');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('google_api_key', '');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('translate_proxy', '');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('radial_menu_enabled', '1');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('autostart', '0');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('shortcut_key', '');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('max_history_items', '2000');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('max_storage_mb', '500');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('image_max_dimension', '4096');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('image_compression_quality', '90');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('large_image_handling', 'compress');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('clipboard_notifications', '0');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('clipboard_unread_count', '0');

        UPDATE settings SET value = 'google' WHERE key = 'default_translate_engine' AND value = 'builtin';

        CREATE TABLE IF NOT EXISTS api_key_labels (
            record_id   TEXT PRIMARY KEY,
            key_preview TEXT NOT NULL,
            service     TEXT NOT NULL,
            api_base    TEXT DEFAULT '',
            note        TEXT DEFAULT '',
            is_expired  INTEGER DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS api_services (
            name TEXT PRIMARY KEY,
            api_base TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS toast_shown (
            key_preview TEXT PRIMARY KEY
        );
        ",
    )?;

    // Migrate api_key_labels from old schema (no record_id PK) to new schema
    {
        let has_record_id_pk: bool = conn
            .prepare("PRAGMA table_info(api_key_labels)")
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
                })?;
                let mut found = false;
                for row in rows.flatten() {
                    if row.0 == "record_id" && row.1 != 0 {
                        found = true;
                    }
                }
                Ok(found)
            })
            .unwrap_or(true);
        if !has_record_id_pk {
            conn.execute("DROP TABLE IF EXISTS api_key_labels", [])
                .map_err(|e| e.to_string())?;
            conn.execute(
                "CREATE TABLE api_key_labels (
                    record_id   TEXT PRIMARY KEY,
                    key_preview TEXT NOT NULL,
                    service     TEXT NOT NULL,
                    api_base    TEXT DEFAULT '',
                    note        TEXT DEFAULT '',
                    is_expired  INTEGER DEFAULT 0,
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL
                )",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // Runtime migrations for existing databases
    migrate_clipboard_record_schema(&conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO api_services (name, api_base) SELECT service, api_base FROM api_key_labels WHERE service <> '' ORDER BY updated_at DESC",
        [],
    )?;
    migrate_secrets(&mut conn)?;

    app.manage(DbState {
        conn: Mutex::new(conn),
    });

    Ok(())
}

fn collect_unreferenced_image_contents(
    state: &DbState,
    image_contents: &[String],
) -> Result<Vec<String>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(image_contents
        .iter()
        .filter(|content| {
            !conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM clipboard_records WHERE content = ?1",
                    params![content],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap_or(false)
        })
        .cloned()
        .collect())
}

pub fn prune_old_records(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let days;
    let image_contents: Vec<String>;
    let deleted_ids: Vec<String>;

    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;

        let retention: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'clipboard_retention'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "1month".to_string());

        days = match retention.as_str() {
            "1week" => 7,
            "3months" => 90,
            _ => 30,
        };

        // Collect records before deletion for UI and image-file cleanup.
        {
            let mut stmt = conn.prepare(
                "SELECT id, type, content FROM clipboard_records WHERE is_favorite = 0 AND datetime(created_at) < datetime('now', ?1)",
            )?;
            let rows = stmt.query_map(params![format!("-{} days", days)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            let records: Vec<(String, String, String)> = rows.filter_map(Result::ok).collect();
            deleted_ids = records.iter().map(|record| record.0.clone()).collect();
            image_contents = records
                .into_iter()
                .filter_map(|(_, record_type, content)| (record_type == "image").then_some(content))
                .collect();
        }

        conn.execute(
            "DELETE FROM api_key_labels WHERE record_id IN (
                SELECT id FROM clipboard_records WHERE is_favorite = 0 AND datetime(created_at) < datetime('now', ?1)
            )",
            params![format!("-{} days", days)],
        )?;
        conn.execute(
            "DELETE FROM clipboard_records WHERE is_favorite = 0 AND datetime(created_at) < datetime('now', ?1)",
            params![format!("-{} days", days)],
        )?;
    }

    // Clean up image files and thumbnails only if no remaining records reference them.
    // Content-hash filenames mean multiple records can share the same file on disk.
    let base_dir = get_storage_dir(app);
    let state = app.state::<DbState>();
    let unreferenced_images = collect_unreferenced_image_contents(&state, &image_contents)?;
    for content in unreferenced_images {
        let file_path = base_dir.join(&content);
        let _ = std::fs::remove_file(&file_path);
        if let Some(filename) = file_path.file_name() {
            let thumb_path = file_path
                .parent()
                .unwrap_or(&base_dir)
                .join("thumbs")
                .join(filename);
            let _ = std::fs::remove_file(&thumb_path);
        }
    }

    // Clean up temp paste image files older than retention period
    let paste_dir = std::env::temp_dir().join("copy_creator_paste");
    if let Ok(entries) = std::fs::read_dir(&paste_dir) {
        let cutoff =
            std::time::SystemTime::now() - std::time::Duration::from_secs(days as u64 * 86400);
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() && meta.modified().is_ok_and(|t| t < cutoff) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    for id in deleted_ids {
        let _ = app.emit("clipboard-deleted", id);
    }
    // Tray refresh reads settings, so no database guard may be alive here.
    crate::tray::refresh_tray_menu(app).ok();

    Ok(())
}

// ---- Tauri Commands ----

#[tauri::command]
pub fn get_clipboard_records(
    app: AppHandle,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    category: Option<String>,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(200);
    let off = offset.unwrap_or(0);

    let cat_filter = category_sql(&category);

    let mut records: Vec<serde_json::Value> = Vec::new();

    if let Some(q) = search {
        let escaped = q
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let sql = format!(
            "SELECT id, type, content, source_app, created_at, user_api_key, is_favorite, favorite_note FROM clipboard_records
             WHERE (content LIKE '%' || ?1 || '%' ESCAPE '\\' OR favorite_note LIKE '%' || ?1 || '%' ESCAPE '\\') {} ORDER BY created_at DESC LIMIT ?2 OFFSET ?3",
            cat_filter.1
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![escaped, lim, off], clipboard_record_json)
            .map_err(|e| e.to_string())?;
        for row in rows {
            records.push(row.map_err(|e| e.to_string())?);
        }
    } else {
        let sql = format!(
            "SELECT id, type, content, source_app, created_at, user_api_key, is_favorite, favorite_note FROM clipboard_records
             {} ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
            cat_filter.0
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![lim, off], clipboard_record_json)
            .map_err(|e| e.to_string())?;
        for row in rows {
            records.push(row.map_err(|e| e.to_string())?);
        }
    }

    // Build label map for API key enrichment
    let mut label_map: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT record_id, service, api_base, note, is_expired FROM api_key_labels")
    {
        if let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        }) {
            for row in rows.flatten() {
                let (record_id, service, api_base, note, is_expired) = row;
                label_map.insert(
                    record_id,
                    serde_json::json!({
                        "service": service,
                        "api_base": api_base,
                        "note": note,
                        "is_expired": is_expired != 0,
                    }),
                );
            }
        }
    }

    let records = records
        .into_iter()
        .map(|rec| {
            let rec_type = rec["type"].as_str().unwrap_or("").to_string();
            let user_key = rec["user_api_key"].as_i64().unwrap_or(0) != 0;
            let (is_key, key_preview_val, guess_val, label_val) =
                if (rec_type == "text" || rec_type == "link") && rec["is_api_key"].as_bool().unwrap_or(false)
                {
                    let kp = rec["key_preview"].clone();
                    let g = rec["guessed_service"].clone();
                    let rid = rec["id"].as_str().unwrap_or("");
                    let lbl = label_map
                        .get(rid)
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    (true, kp, g, lbl)
                } else {
                    (
                        false,
                        serde_json::Value::String(String::new()),
                        serde_json::Value::Null,
                        serde_json::Value::Null,
                    )
                };
            let mut obj = rec;
            if let serde_json::Value::Object(ref mut map) = obj {
                map.insert("is_api_key".to_string(), serde_json::Value::Bool(is_key));
                map.insert(
                    "user_api_key".to_string(),
                    serde_json::Value::Bool(user_key),
                );
                map.insert("key_preview".to_string(), key_preview_val);
                map.insert("guessed_service".to_string(), guess_val);
                map.insert("label".to_string(), label_val);
            }
            obj
        })
        .collect();

    Ok(records)
}

#[tauri::command]
pub fn get_clipboard_record_content(app: AppHandle, id: String) -> Result<String, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let content: String = conn.query_row(
        "SELECT content FROM clipboard_records WHERE id = ?1",
        params![id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|e| e.to_string())?;
    crate::secrets::reveal(&content)
}

#[derive(Clone)]
pub struct ClipboardActionRecord {
    pub id: String,
    pub record_type: String,
    pub content: String,
    pub created_at: String,
    pub user_api_key: bool,
    pub is_favorite: bool,
}

pub fn get_clipboard_action_record(
    app: &AppHandle,
    id: &str,
) -> Result<ClipboardActionRecord, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut record = conn.query_row(
        "SELECT id, type, content, created_at, user_api_key, is_favorite FROM clipboard_records WHERE id = ?1",
        params![id],
        |row| {
            Ok(ClipboardActionRecord {
                id: row.get(0)?,
                record_type: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get(3)?,
                user_api_key: row.get::<_, i64>(4)? != 0,
                is_favorite: row.get::<_, i64>(5)? != 0,
            })
        },
    )
    .map_err(|e| e.to_string())?;
    record.content = crate::secrets::reveal(&record.content)?;
    Ok(record)
}

pub fn get_recent_clipboard_records(
    app: &AppHandle,
    limit: u32,
) -> Result<Vec<ClipboardActionRecord>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, type, content, created_at, user_api_key, is_favorite FROM clipboard_records ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(ClipboardActionRecord {
                id: row.get(0)?,
                record_type: row.get(1)?,
                content: row.get(2)?,
                created_at: row.get(3)?,
                user_api_key: row.get::<_, i64>(4)? != 0,
                is_favorite: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut records = rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for record in &mut records {
        record.content = crate::secrets::reveal(&record.content)?;
    }
    Ok(records)
}

#[tauri::command]
pub fn toggle_clipboard_favorite(app: AppHandle, id: String) -> Result<bool, String> {
    let is_favorite = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let current = conn
            .query_row(
                "SELECT is_favorite FROM clipboard_records WHERE id = ?1",
                params![&id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?;
        let next = current == 0;
        conn.execute(
            "UPDATE clipboard_records SET is_favorite = ?1 WHERE id = ?2",
            params![next as i64, &id],
        )
        .map_err(|e| e.to_string())?;
        next
    };

    let _ = app.emit(
        "clipboard-favorite-changed",
        serde_json::json!({ "id": id, "is_favorite": is_favorite }),
    );
    crate::tray::schedule_tray_refresh(&app);
    Ok(is_favorite)
}

fn normalize_favorite_note(note: &str) -> Result<String, String> {
    let note = note.trim();
    if note.chars().count() > FAVORITE_NOTE_MAX_CHARS {
        return Err(format!(
            "favorite note cannot exceed {FAVORITE_NOTE_MAX_CHARS} characters"
        ));
    }
    Ok(note.to_string())
}

#[tauri::command]
pub fn set_clipboard_favorite_note(
    app: AppHandle,
    id: String,
    note: String,
) -> Result<String, String> {
    let favorite_note = normalize_favorite_note(&note)?;
    let updated = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE clipboard_records SET favorite_note = ?1 WHERE id = ?2 AND is_favorite = 1",
            params![&favorite_note, &id],
        )
        .map_err(|e| e.to_string())?
    };
    if updated == 0 {
        return Err("favorite clipboard record not found".to_string());
    }

    let _ = app.emit(
        "clipboard-favorite-note-changed",
        serde_json::json!({ "id": id, "favorite_note": favorite_note }),
    );
    Ok(favorite_note)
}

pub fn get_unread_count_sync(app: &AppHandle) -> i64 {
    get_setting_sync(app, "clipboard_unread_count")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
        .max(0)
}

pub fn increment_unread_if_hidden(app: &AppHandle) -> i64 {
    // Respect clipboard_notifications setting — don't show unread badge when notifications are off
    if get_setting_sync(app, "clipboard_notifications").as_deref() != Some("1") {
        return get_unread_count_sync(app);
    }
    let is_being_viewed = app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    });
    if is_being_viewed {
        return get_unread_count_sync(app);
    }

    let count = {
        let state = app.state::<DbState>();
        let conn = match state.conn.lock() {
            Ok(conn) => conn,
            Err(_) => return 0,
        };
        let current = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'clipboard_unread_count'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(0);
        let next = current.saturating_add(1);
        let _ = conn.execute(
            "INSERT INTO settings (key, value) VALUES ('clipboard_unread_count', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
            params![next.to_string()],
        );
        next
    };
    let _ = app.emit("clipboard-unread-changed", count);
    count
}

#[tauri::command]
pub fn get_clipboard_unread_count(app: AppHandle) -> i64 {
    if get_setting_sync(&app, "clipboard_notifications").as_deref() != Some("1") {
        return 0;
    }
    get_unread_count_sync(&app)
}

#[tauri::command(async)]
pub fn mark_clipboard_read(app: AppHandle) -> Result<(), String> {
    let changed = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE settings SET value = '0' WHERE key = 'clipboard_unread_count' AND value <> '0'",
            [],
        )
        .map_err(|e| e.to_string())?
    };
    if changed == 0 {
        return Ok(());
    }
    let _ = app.emit("clipboard-unread-changed", 0);
    crate::tray::schedule_tray_refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_clipboard_record(app: AppHandle, id: String) -> Result<(), String> {
    let image_content: Option<String> = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;

        let record: Option<(String, String)> = conn
            .query_row(
                "SELECT type, content FROM clipboard_records WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .ok();

        conn.execute(
            "DELETE FROM api_key_labels WHERE record_id = ?1",
            params![&id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM clipboard_records WHERE id = ?1", params![&id])
            .map_err(|e| e.to_string())?;

        let _ = app.emit("clipboard-deleted", &id);

        match record {
            Some((t, c)) if t == "image" => {
                let still_referenced = conn
                    .query_row(
                        "SELECT COUNT(*) > 0 FROM clipboard_records WHERE content = ?1",
                        params![&c],
                        |row| row.get::<_, bool>(0),
                    )
                    .unwrap_or(false);
                (!still_referenced).then_some(c)
            }
            _ => None,
        }
    };

    if let Some(content) = image_content {
        remove_stored_image(&get_storage_dir(&app), &content);
    }

    crate::tray::schedule_tray_refresh(&app);

    Ok(())
}

#[tauri::command]
pub fn get_phrase_groups(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, sort_order, created_at, updated_at FROM phrase_groups ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "sort_order": row.get::<_, i32>(2)?,
                "created_at": row.get::<_, String>(3)?,
                "updated_at": row.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut groups = Vec::new();
    for row in rows {
        groups.push(row.map_err(|e| e.to_string())?);
    }
    Ok(groups)
}

#[tauri::command]
pub fn create_phrase_group(app: AppHandle, name: String) -> Result<serde_json::Value, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO phrase_groups (id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, 0, ?3, ?4)",
        params![id, name, &now, &now],
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("phrase-groups-changed", ());
    Ok(serde_json::json!({
        "id": id,
        "name": name,
        "sort_order": 0,
        "created_at": now,
        "updated_at": now,
    }))
}

#[tauri::command]
pub fn update_phrase_group(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE phrase_groups SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, &now, id],
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("phrase-groups-changed", ());
    Ok(())
}

#[tauri::command]
pub fn delete_phrase_group(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM phrases WHERE group_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM phrase_groups WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    let _ = app.emit("phrase-groups-changed", ());
    Ok(())
}

#[tauri::command]
pub fn get_phrases(app: AppHandle, group_id: String) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, group_id, title, content, sort_order, created_at, updated_at FROM phrases WHERE group_id = ?1 ORDER BY sort_order")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![group_id], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "group_id": row.get::<_, String>(1)?,
                "title": row.get::<_, String>(2)?,
                "content": row.get::<_, String>(3)?,
                "sort_order": row.get::<_, i32>(4)?,
                "created_at": row.get::<_, String>(5)?,
                "updated_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut phrases = Vec::new();
    for row in rows {
        phrases.push(row.map_err(|e| e.to_string())?);
    }
    Ok(phrases)
}

#[tauri::command]
pub fn create_phrase(
    app: AppHandle,
    group_id: String,
    title: String,
    content: String,
) -> Result<serde_json::Value, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO phrases (id, group_id, title, content, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)",
        params![id, group_id, title, content, &now, &now],
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "id": id,
        "group_id": group_id,
        "title": title,
        "content": content,
        "sort_order": 0,
        "created_at": now,
        "updated_at": now,
    }))
}

#[tauri::command]
pub fn update_phrase(
    app: AppHandle,
    id: String,
    title: String,
    content: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE phrases SET title = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
        params![title, content, &now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn delete_phrase(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM phrases WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_translation_history(
    app: AppHandle,
    limit: Option<u32>,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let l = limit.unwrap_or(100);
    let mut stmt = conn
        .prepare(
            "SELECT id, source_text, target_text, source_lang, target_lang, engine, created_at
             FROM translation_history ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![l], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "source_text": row.get::<_, String>(1)?,
                "target_text": row.get::<_, String>(2)?,
                "source_lang": row.get::<_, String>(3)?,
                "target_lang": row.get::<_, String>(4)?,
                "engine": row.get::<_, String>(5)?,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut history = Vec::new();
    for row in rows {
        history.push(row.map_err(|e| e.to_string())?);
    }
    Ok(history)
}

#[tauri::command]
pub fn clear_translation_history(app: AppHandle) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM translation_history", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_setting(app: AppHandle, key: String) -> Result<String, String> {
    if crate::secrets::is_setting_secret(&key) {
        return Err("secret settings cannot be read by the webview".to_string());
    }
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .unwrap_or_default())
}

pub fn get_setting_sync(app: &AppHandle, key: &str) -> Option<String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().ok()?;
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .ok()
}

#[tauri::command]
pub fn get_all_settings(
    app: AppHandle,
) -> Result<std::collections::HashMap<String, String>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        if crate::secrets::is_setting_secret(&k) {
            map.insert(format!("{k}_configured"), (!v.is_empty()).to_string());
        } else {
            map.insert(k, v);
        }
    }
    Ok(map)
}

const EXPORT_SETTING_KEYS: &[&str] = &[
    "clipboard_retention",
    "dedupe_window_seconds",
    "default_translate_engine",
    "theme",
    "language",
    "radial_menu_enabled",
    "shortcut_key",
    "ai_api_url",
    "ai_model",
    "translate_proxy",
    "max_history_items",
    "max_storage_mb",
    "image_max_dimension",
    "image_compression_quality",
    "large_image_handling",
    "clipboard_notifications",
];

#[derive(Serialize, Deserialize)]
struct ClipboardExportBundle {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    exported_at: String,
    settings: HashMap<String, String>,
    #[serde(default)]
    favorites: Vec<FavoriteExportRecord>,
}

#[derive(Serialize, Deserialize)]
struct FavoriteExportRecord {
    id: String,
    #[serde(rename = "type")]
    record_type: String,
    content: String,
    #[serde(default)]
    source_app: String,
    created_at: String,
    #[serde(default)]
    user_api_key: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    favorite_note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image_base64: Option<String>,
}

async fn select_export_path(app: &AppHandle) -> Result<PathBuf, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_file_name("copy-creator-backup.json")
        .save_file(move |path| {
            let _ = tx.send(path.map(|value| value.to_string()));
        });
    let selected =
        tokio::task::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(120)))
            .await
            .map_err(|e| format!("task error: {e}"))?
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "cancelled".to_string())?;
    Ok(PathBuf::from(selected))
}

async fn select_import_path(app: &AppHandle) -> Result<PathBuf, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_file(move |path| {
        let _ = tx.send(path.map(|value| value.to_string()));
    });
    let selected =
        tokio::task::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(120)))
            .await
            .map_err(|e| format!("task error: {e}"))?
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "cancelled".to_string())?;
    Ok(PathBuf::from(selected))
}

#[tauri::command]
pub async fn export_user_data(app: AppHandle) -> Result<serde_json::Value, String> {
    let base_dir = get_storage_dir(&app);
    let (settings, mut favorites) = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;

        let mut settings = HashMap::new();
        for key in EXPORT_SETTING_KEYS {
            if let Ok(value) = conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            ) {
                settings.insert((*key).to_string(), value);
            }
        }

        let mut stmt = conn
            .prepare(
                "SELECT id, type, content, source_app, created_at, user_api_key, favorite_note FROM clipboard_records WHERE is_favorite = 1 ORDER BY created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(FavoriteExportRecord {
                    id: row.get(0)?,
                    record_type: row.get(1)?,
                    content: row.get(2)?,
                    source_app: row.get(3)?,
                    created_at: row.get(4)?,
                    user_api_key: row.get::<_, i64>(5)? != 0,
                    favorite_note: row.get(6)?,
                    image_base64: None,
                })
            })
            .map_err(|e| e.to_string())?;
        let favorites: Vec<FavoriteExportRecord> = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let favorites: Vec<FavoriteExportRecord> = favorites.into_iter().filter(|record| {
            !record.user_api_key
                && !crate::secrets::is_protected(&record.content)
                && !is_api_key(&record.content)
        }).collect();
        (settings, favorites)
    };

    for favorite in favorites
        .iter_mut()
        .filter(|record| record.record_type == "image")
    {
        let image_path = storage_content_path(&base_dir, &favorite.content)
            .ok_or_else(|| format!("invalid favorite image path: {}", favorite.content))?;
        let bytes = std::fs::read(&image_path)
            .map_err(|e| format!("read favorite image {}: {e}", image_path.display()))?;
        favorite.image_base64 = Some(base64::engine::general_purpose::STANDARD.encode(bytes));
    }

    let bundle = ClipboardExportBundle {
        version: 1,
        exported_at: chrono::Utc::now().to_rfc3339(),
        settings,
        favorites,
    };
    let json = serde_json::to_vec_pretty(&bundle).map_err(|e| e.to_string())?;
    let path = select_export_path(&app).await?;
    std::fs::write(&path, json).map_err(|e| format!("write export: {e}"))?;

    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "settings_count": bundle.settings.len(),
        "favorites_count": bundle.favorites.len(),
    }))
}

fn validate_import_setting(key: &str, value: &str) -> Option<String> {
    if !EXPORT_SETTING_KEYS.contains(&key) || value.len() > 4_096 {
        return None;
    }

    let valid = match key {
        "clipboard_retention" => matches!(value, "1week" | "1month" | "3months"),
        "dedupe_window_seconds" => matches!(value, "1" | "5" | "30" | "60" | "300" | "900" | "1800"),
        "default_translate_engine" => matches!(value, "google" | "ai"),
        "theme" => matches!(value, "light" | "dark"),
        "language" => matches!(value, "zh-CN" | "en"),
        "radial_menu_enabled" | "clipboard_notifications" => matches!(value, "0" | "1"),
        "large_image_handling" => matches!(value, "compress" | "keep" | "skip"),
        "max_history_items" => value
            .parse::<u64>()
            .is_ok_and(|number| (100..=100_000).contains(&number)),
        "max_storage_mb" => value
            .parse::<u64>()
            .is_ok_and(|number| (50..=100_000).contains(&number)),
        "image_max_dimension" => value
            .parse::<u32>()
            .is_ok_and(|number| (512..=16_384).contains(&number)),
        "image_compression_quality" => value
            .parse::<u8>()
            .is_ok_and(|number| (40..=100).contains(&number)),
        _ => true,
    };
    valid.then(|| value.to_string())
}

#[tauri::command]
pub async fn import_user_data(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = select_import_path(&app).await?;
    let metadata = std::fs::metadata(&path).map_err(|e| format!("read import metadata: {e}"))?;
    if metadata.len() > 100 * 1024 * 1024 {
        return Err("import file is larger than 100 MB".to_string());
    }
    let json = std::fs::read(&path).map_err(|e| format!("read import: {e}"))?;
    let bundle: ClipboardExportBundle =
        serde_json::from_slice(&json).map_err(|e| format!("invalid backup: {e}"))?;
    if bundle.version != 1 && bundle.version != 0 {
        return Err(format!("unsupported backup version: {}", bundle.version));
    }

    let settings: HashMap<String, String> = bundle
        .settings
        .iter()
        .filter_map(|(key, value)| {
            validate_import_setting(key, value).map(|value| (key.clone(), value))
        })
        .collect();
    let existing_ids: HashSet<String> = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id FROM clipboard_records")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(Result::ok).collect()
    };

    let base_dir = get_storage_dir(&app);
    let images_dir = base_dir.join("images");
    std::fs::create_dir_all(&images_dir).map_err(|e| format!("create images folder: {e}"))?;
    let mut staged_files = Vec::new();
    let mut prepared = Vec::new();
    let mut seen_ids = HashSet::new();

    for mut favorite in bundle.favorites {
        if !seen_ids.insert(favorite.id.clone()) {
            continue;
        }
        if favorite.id.len() > 128
            || !matches!(
                favorite.record_type.as_str(),
                "text" | "image" | "link" | "explorer" | "file"
            )
            || favorite.content.len() > 10 * 1024 * 1024
            || favorite.favorite_note.chars().count() > FAVORITE_NOTE_MAX_CHARS
        {
            for staged in &staged_files {
                let _ = std::fs::remove_file(staged);
            }
            return Err("backup contains an invalid favorite record".to_string());
        }
        favorite.favorite_note = favorite.favorite_note.trim().to_string();
        if (favorite.record_type == "text" || favorite.record_type == "link")
            && (favorite.user_api_key || is_api_key(&favorite.content))
        {
            favorite.content = crate::secrets::protect(&favorite.content)?;
        }

        if favorite.record_type == "image" && !existing_ids.contains(&favorite.id) {
            let image_result = (|| -> Result<(PathBuf, String), String> {
                let encoded = favorite
                    .image_base64
                    .as_deref()
                    .ok_or_else(|| "favorite image data is missing".to_string())?;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|e| format!("invalid favorite image: {e}"))?;
                if bytes.len() > 50 * 1024 * 1024 || image::load_from_memory(&bytes).is_err() {
                    return Err("backup contains an unsupported favorite image".to_string());
                }
                let extension = match image::guess_format(&bytes).ok() {
                    Some(image::ImageFormat::Jpeg) => "jpg",
                    Some(image::ImageFormat::WebP) => "webp",
                    _ => "png",
                };
                let filename = format!("import-{}.{}", uuid::Uuid::new_v4(), extension);
                let image_path = images_dir.join(&filename);
                std::fs::write(&image_path, &bytes)
                    .map_err(|e| format!("write imported favorite image: {e}"))?;
                Ok((image_path, filename))
            })();
            let (image_path, filename) = match image_result {
                Ok(result) => result,
                Err(error) => {
                    for staged in &staged_files {
                        let _ = std::fs::remove_file(staged);
                    }
                    return Err(error);
                }
            };
            staged_files.push(image_path);
            favorite.content = format!("images/{filename}");
        }
        prepared.push(favorite);
    }

    let import_result = (|| -> Result<(), String> {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (key, value) in &settings {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        }
        for favorite in &prepared {
            tx.execute(
                "INSERT INTO clipboard_records (id, type, content, source_app, created_at, user_api_key, is_favorite, favorite_note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7) ON CONFLICT(id) DO UPDATE SET is_favorite = 1, favorite_note = excluded.favorite_note",
                params![
                    &favorite.id,
                    &favorite.record_type,
                    &favorite.content,
                    &favorite.source_app,
                    &favorite.created_at,
                    favorite.user_api_key as i64,
                    &favorite.favorite_note,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    })();

    if let Err(error) = import_result {
        for staged in &staged_files {
            let _ = std::fs::remove_file(staged);
        }
        return Err(error);
    }

    if let Err(error) = enforce_clipboard_limits(&app) {
        log::warn!("clipboard limit enforcement after import failed: {error}");
    }
    let _ = app.emit("clipboard-refresh", ());
    crate::tray::schedule_tray_refresh(&app);
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "settings_count": settings.len(),
        "favorites_count": prepared.len(),
    }))
}

#[tauri::command(async)]
pub fn get_image_base64(
    app: AppHandle,
    path: String,
    max_size: u32,
) -> Result<String, String> {
    let mut base_dir = get_storage_dir(&app);
    base_dir.push(&path);

    let bytes = std::fs::read(&base_dir).map_err(|e| format!("read image file: {}", e))?;
    let image = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {e}"))?;
    let max_size = max_size.clamp(320, 4096);
    let image = if image.width().max(image.height()) > max_size {
        image.resize(max_size, max_size, image::imageops::FilterType::Triangle)
    } else {
        image
    };
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("encode image preview: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png.into_inner()))
}

#[tauri::command(async)]
pub fn get_image_thumbnail(app: AppHandle, path: String, max_size: u32) -> Result<String, String> {
    let base_dir = get_storage_dir(&app);
    let image_path = base_dir.join(&path);

    // Try pre-generated thumbnail first (saved during clipboard capture)
    let thumb_dir = image_path.parent().unwrap_or(&base_dir).join("thumbs");
    let filename = image_path.file_name().ok_or("invalid path")?;
    let thumb_path = thumb_dir.join(filename);

    let existing_thumb = if thumb_path.exists() {
        std::fs::read(&thumb_path).ok().filter(|bytes| {
            image::load_from_memory(bytes)
                .map(|thumb| thumb.width().max(thumb.height()) >= max_size)
                .unwrap_or(false)
        })
    } else {
        None
    };

    let thumb_bytes = if let Some(bytes) = existing_thumb {
        bytes
    } else {
        // Fallback: generate thumbnail from full image
        let bytes = std::fs::read(&image_path).map_err(|e| format!("read image file: {}", e))?;
        let img = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {}", e))?;
        let (w, h) = (img.width(), img.height());
        let scale = if w > max_size || h > max_size {
            max_size as f32 / w.max(h) as f32
        } else {
            1.0
        };
        let thumb = if scale < 1.0 {
            let new_w = (w as f32 * scale) as u32;
            let new_h = (h as f32 * scale) as u32;
            img.resize(new_w, new_h, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        let mut buf = std::io::Cursor::new(Vec::new());
        thumb
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("encode thumbnail: {}", e))?;
        let data = buf.into_inner();
        // Save for future use
        std::fs::create_dir_all(&thumb_dir).ok();
        let _ = std::fs::write(&thumb_path, &data);
        data
    };

    Ok(base64::engine::general_purpose::STANDARD.encode(&thumb_bytes))
}

#[tauri::command]
pub fn set_setting(app: AppHandle, key: String, value: String) -> Result<(), String> {
    if key == "storage_path" {
        return migrate_storage(&app, &value);
    }

    if EXPORT_SETTING_KEYS.contains(&key.as_str())
        && validate_import_setting(&key, &value).is_none()
    {
        return Err(format!("invalid value for setting: {key}"));
    }

    let value = if crate::secrets::is_setting_secret(&key) && !value.is_empty() {
        crate::secrets::protect(&value)?
    } else { value };

    {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![&key, &value],
        )
        .map_err(|e| e.to_string())?;
    }
    if matches!(key.as_str(), "max_history_items" | "max_storage_mb") {
        enforce_clipboard_limits(&app)?;
        crate::tray::schedule_tray_refresh(&app);
    }
    Ok(())
}

#[tauri::command]
pub fn set_settings_batch(
    app: AppHandle,
    settings: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    if let Some(storage_path) = settings.get("storage_path") {
        migrate_storage(&app, storage_path)?;
    }

    for (key, value) in settings
        .iter()
        .filter(|(key, _)| key.as_str() != "storage_path")
    {
        if EXPORT_SETTING_KEYS.contains(&key.as_str())
            && validate_import_setting(key, value).is_none()
        {
            return Err(format!("invalid value for setting: {key}"));
        }
    }

    let settings: std::collections::HashMap<String, String> = settings.into_iter()
        .map(|(key, value)| {
            if crate::secrets::is_setting_secret(&key) && !value.is_empty() {
                crate::secrets::protect(&value).map(|protected| (key, protected))
            } else { Ok((key, value)) }
        })
        .collect::<Result<_, _>>()?;

    {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (key, value) in settings
            .iter()
            .filter(|(key, _)| key.as_str() != "storage_path")
        {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    if settings.contains_key("max_history_items") || settings.contains_key("max_storage_mb") {
        enforce_clipboard_limits(&app)?;
        crate::tray::schedule_tray_refresh(&app);
    }
    Ok(())
}

fn migrate_storage(app: &AppHandle, new_path: &str) -> Result<(), String> {
    let custom_dir = PathBuf::from(new_path);
    std::fs::create_dir_all(&custom_dir).map_err(|e| format!("create dir: {}", e))?;
    let custom_db = custom_dir.join("data.db");

    // Collect all settings from current DB
    let settings: Vec<(String, String)> = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // Create new DB with schema and settings at target location
    let new_conn = Connection::open(&custom_db).map_err(|e| format!("open new db: {}", e))?;

    new_conn
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS clipboard_records (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                source_app TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                user_api_key INTEGER DEFAULT 0,
                is_favorite INTEGER NOT NULL DEFAULT 0,
                favorite_note TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_clipboard_created_at ON clipboard_records(created_at);
            CREATE TABLE IF NOT EXISTS phrase_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS phrases (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                sort_order INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (group_id) REFERENCES phrase_groups(id) ON DELETE CASCADE
            );
            CREATE TABLE IF NOT EXISTS translation_history (
                id TEXT PRIMARY KEY,
                source_text TEXT NOT NULL,
                target_text TEXT NOT NULL,
                source_lang TEXT DEFAULT 'auto',
                target_lang TEXT NOT NULL,
                engine TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_translation_created_at ON translation_history(created_at);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            DROP TABLE IF EXISTS api_key_labels;
            CREATE TABLE IF NOT EXISTS api_key_labels (
                record_id   TEXT PRIMARY KEY,
                key_preview TEXT NOT NULL,
                service     TEXT NOT NULL,
                api_base    TEXT DEFAULT '',
                note        TEXT DEFAULT '',
                is_expired  INTEGER DEFAULT 0,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS api_services (
                name TEXT PRIMARY KEY,
                api_base TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS toast_shown (
                key_preview TEXT PRIMARY KEY
            );
            ",
        )
        .map_err(|e| format!("create schema: {}", e))?;

    // Copy settings to new DB
    {
        let mut stmt = new_conn
            .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for (k, v) in &settings {
            if k != "storage_path" && k != "shortcut_key" {
                stmt.execute(params![k, v]).map_err(|e| e.to_string())?;
            }
        }
        stmt.execute(params!["storage_path", new_path])
            .map_err(|e| e.to_string())?;
        stmt.execute(params!["shortcut_key", ""])
            .map_err(|e| e.to_string())?;
    }

    // Update old DB's storage_path (for chain-following on restart) and switch connection
    {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('storage_path', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1",
            params![new_path],
        )
        .map_err(|e| e.to_string())?;
        *conn = new_conn;
    }

    log::info!("Storage migrated to: {}", new_path);
    Ok(())
}

#[tauri::command]
pub fn get_storage_path(app: AppHandle) -> Result<String, String> {
    Ok(get_storage_dir(&app).to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn ensure_thumbnail(app: AppHandle, path: String) -> Result<String, String> {
    let mut base = get_storage_dir(&app);
    base.push(&path);

    if !base.exists() {
        return Err("image file not found".to_string());
    }

    let filename = base
        .file_name()
        .ok_or("invalid path")?
        .to_string_lossy()
        .to_string();
    let mut thumb_dir = base.parent().ok_or("invalid path")?.to_path_buf();
    thumb_dir.push("thumbs");
    std::fs::create_dir_all(&thumb_dir).ok();
    let thumb_path = thumb_dir.join(&filename);

    if thumb_path.exists() {
        return Ok(thumb_path.to_string_lossy().to_string());
    }

    let bytes = std::fs::read(&base).map_err(|e| format!("read image: {}", e))?;
    let img = image::load_from_memory(&bytes).map_err(|e| format!("decode image: {}", e))?;

    let (w, h) = (img.width(), img.height());
    let max_thumb: u32 = 200;
    let scale = if w > max_thumb || h > max_thumb {
        max_thumb as f32 / w.max(h) as f32
    } else {
        1.0
    };

    let thumb = if scale < 1.0 {
        img.resize(
            (w as f32 * scale) as u32,
            (h as f32 * scale) as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };

    let mut buf = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("encode thumbnail: {}", e))?;

    std::fs::write(&thumb_path, buf.into_inner()).map_err(|e| format!("write thumbnail: {}", e))?;

    Ok(thumb_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn select_storage_folder(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let result =
        tokio::task::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(60)))
            .await
            .map_err(|e| format!("task error: {}", e))?;

    match result {
        Ok(Some(path)) => Ok(path.to_string()),
        Ok(None) => Err("cancelled".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err("timeout".to_string()),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err("cancelled".to_string()),
    }
}

// === API Key Label Commands ===

#[tauri::command]
pub fn check_api_key(content: String) -> serde_json::Value {
    let is_key = is_api_key(&content);
    let preview = if is_key {
        make_key_preview(&content)
    } else {
        String::new()
    };
    let guess = if is_key {
        guess_service(&content).map(|s| s.to_string())
    } else {
        None
    };
    serde_json::json!({ "is_key": is_key, "preview": preview, "guess": guess })
}

#[tauri::command]
pub fn save_api_key_label(
    app: AppHandle,
    record_id: String,
    key_preview: String,
    service: String,
    api_base: String,
    note: String,
) -> Result<(), String> {
    let service = service.trim().to_string();
    let api_base = api_base.trim().to_string();
    let note = note.trim().to_string();
    if service.is_empty() || service.chars().count() > 80 || note.chars().count() > 100 {
        return Err("invalid API key label".to_string());
    }
    if !api_base.is_empty() {
        let url = reqwest::Url::parse(&api_base).map_err(|_| "invalid Base URL")?;
        if !matches!(url.scheme(), "http" | "https") || url.host().is_none() || api_base.len() > 2048 {
            return Err("invalid Base URL".to_string());
        }
    }
    let state = app.state::<DbState>();
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO api_key_labels (record_id, key_preview, service, api_base, note, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(record_id) DO UPDATE SET service=?3, api_base=?4, note=?5, updated_at=?7",
        params![record_id, key_preview, service, api_base, note, &now, &now],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO api_services (name, api_base) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET api_base = excluded.api_base",
        params![service, api_base],
    ).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Clone)]
struct CleanupRecord {
    id: String,
    record_type: String,
    content: String,
    is_favorite: bool,
    has_label: bool,
    created_at: String,
}

fn cleanup_cutoff(period: &str) -> Result<chrono::DateTime<chrono::Utc>, String> {
    let today = chrono::Local::now().date_naive();
    let date = match period {
        "today" => Some(today),
        "3days" => today.checked_sub_days(chrono::Days::new(3)),
        "7days" => today.checked_sub_days(chrono::Days::new(7)),
        "1month" => today.checked_sub_months(chrono::Months::new(1)),
        "2months" => today.checked_sub_months(chrono::Months::new(2)),
        _ => return Err("invalid cleanup period".to_string()),
    };
    let date = date.ok_or_else(|| "invalid cleanup date".to_string())?;
    let midnight = date.and_hms_opt(0, 0, 0).ok_or_else(|| "invalid cleanup time".to_string())?;
    chrono::Local
        .from_local_datetime(&midnight)
        .earliest()
        .map(|time| time.with_timezone(&chrono::Utc))
        .ok_or_else(|| "invalid local cleanup time".to_string())
}

fn cleanup_candidates(conn: &Connection, mode: &str, period: Option<&str>) -> Result<Vec<CleanupRecord>, String> {
    let cutoff = if mode == "older_than" {
        Some(cleanup_cutoff(period.ok_or_else(|| "missing cleanup period".to_string())?)?)
    } else if mode == "dedupe" {
        None
    } else {
        return Err("invalid cleanup mode".to_string());
    };
    let mut stmt = conn.prepare(
        "SELECT r.id, r.type, r.content, r.is_favorite, EXISTS(SELECT 1 FROM api_key_labels l WHERE l.record_id = r.id), r.created_at FROM clipboard_records r ORDER BY r.created_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(CleanupRecord {
            id: row.get(0)?, record_type: row.get(1)?, content: row.get(2)?,
            is_favorite: row.get::<_, i64>(3)? != 0,
            has_label: row.get::<_, i64>(4)? != 0,
            created_at: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;
    let mut records = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    if let Some(cutoff) = cutoff {
        return Ok(records.into_iter().filter(|record| {
            !record.is_favorite && chrono::DateTime::parse_from_rfc3339(&record.created_at)
                .is_ok_and(|created_at| created_at < cutoff)
        }).collect());
    }
    records.sort_by(|left, right| {
        let left_time = chrono::DateTime::parse_from_rfc3339(&left.created_at).ok();
        let right_time = chrono::DateTime::parse_from_rfc3339(&right.created_at).ok();
        right_time.cmp(&left_time).then_with(|| right.created_at.cmp(&left.created_at))
    });
    let mut groups: HashMap<(String, String), Vec<CleanupRecord>> = HashMap::new();
    for record in records {
        let plaintext = crate::secrets::reveal(&record.content)?;
        groups.entry((record.record_type.clone(), plaintext)).or_default().push(record);
    }
    let mut candidates = Vec::new();
    for group in groups.into_values() {
        if group.len() < 2 { continue; }
        let protected_exists = group.iter().any(|record| record.is_favorite || record.has_label);
        for (index, record) in group.into_iter().enumerate() {
            if !record.is_favorite && !record.has_label && (protected_exists || index > 0) {
                candidates.push(record);
            }
        }
    }
    Ok(candidates)
}

#[tauri::command]
pub fn preview_clipboard_cleanup(app: AppHandle, mode: String, period: Option<String>) -> Result<usize, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(cleanup_candidates(&conn, &mode, period.as_deref())?.len())
}

#[tauri::command]
pub fn apply_clipboard_cleanup(app: AppHandle, mode: String, period: Option<String>) -> Result<usize, String> {
    let candidates = {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        let candidates = cleanup_candidates(&conn, &mode, period.as_deref())?;
        if candidates.is_empty() { return Ok(0); }
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for record in &candidates {
            tx.execute("DELETE FROM api_key_labels WHERE record_id = ?1", params![&record.id]).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM clipboard_records WHERE id = ?1", params![&record.id]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        candidates
    };
    let image_contents: Vec<String> = candidates.iter().filter(|record| record.record_type == "image").map(|record| record.content.clone()).collect();
    let state = app.state::<DbState>();
    let unreferenced = collect_unreferenced_image_contents(&state, &image_contents)?;
    let base_dir = get_storage_dir(&app);
    for content in unreferenced { remove_stored_image(&base_dir, &content); }
    let _ = app.emit("clipboard-refresh", ());
    crate::tray::schedule_tray_refresh(&app);
    Ok(candidates.len())
}

#[tauri::command]
pub fn list_api_services(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT name, api_base FROM api_services ORDER BY name COLLATE NOCASE")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(serde_json::json!({
            "name": row.get::<_, String>(0)?,
            "apiBase": row.get::<_, String>(1)?,
        }))
    }).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_api_key_label(app: AppHandle, record_id: String) -> Option<serde_json::Value> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().ok()?;
    conn.query_row(
        "SELECT key_preview, service, api_base, note, is_expired, created_at FROM api_key_labels WHERE record_id = ?1",
        params![record_id],
        |row| {
            Ok(serde_json::json!({
                "record_id": record_id,
                "key_preview": row.get::<_, String>(0)?,
                "service": row.get::<_, String>(1)?,
                "api_base": row.get::<_, String>(2)?,
                "note": row.get::<_, String>(3)?,
                "is_expired": row.get::<_, i64>(4)? != 0,
                "created_at": row.get::<_, String>(5)?,
            }))
        },
    )
    .ok()
}

#[tauri::command]
pub fn delete_api_key_label(app: AppHandle, record_id: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM api_key_labels WHERE record_id = ?1",
        params![record_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn list_labels_internal(conn: &Connection) -> Result<Vec<serde_json::Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT record_id, key_preview, service, api_base, note, is_expired, created_at \
             FROM api_key_labels ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "record_id": row.get::<_, String>(0)?,
                "key_preview": row.get::<_, String>(1)?,
                "service": row.get::<_, String>(2)?,
                "api_base": row.get::<_, String>(3)?,
                "note": row.get::<_, String>(4)?,
                "is_expired": row.get::<_, i64>(5)? != 0,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut labels = Vec::new();
    for row in rows {
        labels.push(row.map_err(|e| e.to_string())?);
    }
    Ok(labels)
}

#[tauri::command]
pub fn list_api_key_labels(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    list_labels_internal(&conn)
}

#[tauri::command]
pub fn mark_expired(app: AppHandle, record_id: String, expired: bool) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE api_key_labels SET is_expired = ?1 WHERE record_id = ?2",
        params![expired as i64, record_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn export_labels_json(app: AppHandle) -> Result<String, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let labels = list_labels_internal(&conn)?;
    serde_json::to_string_pretty(&labels).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_toast_shown(app: AppHandle, key_preview: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO toast_shown (key_preview) VALUES (?1)",
        params![key_preview],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn is_toast_shown(app: AppHandle, key_preview: String) -> bool {
    is_toast_shown_internal(&app, &key_preview)
}

#[tauri::command]
pub fn set_user_api_key(app: AppHandle, id: String, value: bool) -> Result<(), String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let content: String = conn.query_row("SELECT content FROM clipboard_records WHERE id = ?1", params![&id], |row| row.get(0)).map_err(|e| e.to_string())?;
    let stored_content = if value && !crate::secrets::is_protected(&content) {
        crate::secrets::protect(&content)?
    } else { content };
    conn.execute(
        "UPDATE clipboard_records SET user_api_key = ?1, content = ?2 WHERE id = ?3",
        params![value as i64, stored_content, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cleanup_test_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clipboard_records (
                id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
                is_favorite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
            );
            CREATE TABLE api_key_labels (record_id TEXT PRIMARY KEY);",
        ).unwrap();
        conn
    }

    #[test]
    fn manual_dedupe_keeps_favorites_and_labeled_keys() {
        let conn = cleanup_test_connection();
        let protected_key = crate::secrets::protect("sk-example-secret").unwrap();
        for (id, content, favorite, created_at) in [
            ("old", "same", 0, "2026-09-20T10:00:00Z"),
            ("new", "same", 0, "2026-09-21T10:00:00Z"),
            ("favorite", "same", 1, "2026-09-19T10:00:00Z"),
            ("key", protected_key.as_str(), 0, "2026-09-22T10:00:00Z"),
            ("key-duplicate", "sk-example-secret", 0, "2026-09-23T10:00:00Z"),
        ] {
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, is_favorite, created_at) VALUES (?1, 'text', ?2, ?3, ?4)",
                params![id, content, favorite, created_at],
            ).unwrap();
        }
        conn.execute("INSERT INTO api_key_labels (record_id) VALUES ('key')", []).unwrap();
        let mut ids: Vec<_> = cleanup_candidates(&conn, "dedupe", None).unwrap()
            .into_iter().map(|record| record.id).collect();
        ids.sort();
        assert_eq!(ids, ["key-duplicate", "new", "old"]);
    }

    #[test]
    fn bulk_delete_uses_local_day_boundary_and_skips_favorites() {
        let conn = cleanup_test_connection();
        let cutoff = cleanup_cutoff("today").unwrap();
        let before = (cutoff - chrono::Duration::seconds(1)).to_rfc3339();
        let after = cutoff.to_rfc3339();
        for (id, favorite, created_at) in [
            ("old", 0, before.as_str()),
            ("favorite", 1, before.as_str()),
            ("today", 0, after.as_str()),
        ] {
            conn.execute(
                "INSERT INTO clipboard_records (id, type, content, is_favorite, created_at) VALUES (?1, 'text', ?1, ?2, ?3)",
                params![id, favorite, created_at],
            ).unwrap();
        }
        let ids: Vec<_> = cleanup_candidates(&conn, "older_than", Some("today")).unwrap()
            .into_iter().map(|record| record.id).collect();
        assert_eq!(ids, ["old"]);
    }

    #[test]
    fn ambiguous_sk_prefix_does_not_assign_a_provider() {
        assert_eq!(guess_service("sk-example-shared-prefix"), None);
        assert_eq!(guess_service("AIza-example"), Some("Gemini"));
    }

    #[test]
    fn migrates_existing_plaintext_secrets() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE clipboard_records (id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, user_api_key INTEGER DEFAULT 0);").unwrap();
        conn.execute("INSERT INTO settings VALUES ('ai_api_key', 'sk-example-translation-secret')", []).unwrap();
        conn.execute("INSERT INTO clipboard_records VALUES ('one', 'text', 'sk-example-clipboard-secret', 0)", []).unwrap();
        migrate_secrets(&mut conn).unwrap();
        let setting: String = conn.query_row("SELECT value FROM settings WHERE key = 'ai_api_key'", [], |row| row.get(0)).unwrap();
        let clipboard: String = conn.query_row("SELECT content FROM clipboard_records WHERE id = 'one'", [], |row| row.get(0)).unwrap();
        assert!(crate::secrets::is_protected(&setting));
        assert!(crate::secrets::is_protected(&clipboard));
        assert_eq!(crate::secrets::reveal(&setting).unwrap(), "sk-example-translation-secret");
        assert_eq!(crate::secrets::reveal(&clipboard).unwrap(), "sk-example-clipboard-secret");
    }

    #[test]
    fn favorite_migration_preserves_existing_clipboard_records() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "
            CREATE TABLE clipboard_records (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                source_app TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                user_api_key INTEGER DEFAULT 0
            );
            INSERT INTO clipboard_records
                (id, type, content, source_app, created_at, user_api_key)
            VALUES
                ('one', 'text', 'preserve me', '', '2026-07-11T00:00:00Z', 1),
                ('two', 'image', 'images/existing.png', '', '2026-07-11T00:01:00Z', 0);
            ",
        )
        .unwrap();

        migrate_clipboard_record_schema(&conn).unwrap();

        let rows: Vec<(String, String, i64, i64, String)> = conn
            .prepare(
                "SELECT id, content, user_api_key, is_favorite, favorite_note FROM clipboard_records ORDER BY id",
            )
            .unwrap()
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert_eq!(
            rows,
            vec![
                ("one".into(), "preserve me".into(), 1, 0, "".into()),
                ("two".into(), "images/existing.png".into(), 0, 0, "".into(),),
            ]
        );
    }

    #[test]
    fn favorite_migration_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clipboard_records (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                source_app TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );",
        )
        .unwrap();

        migrate_clipboard_record_schema(&conn).unwrap();
        migrate_clipboard_record_schema(&conn).unwrap();

        assert!(table_has_column(&conn, "clipboard_records", "user_api_key").unwrap());
        assert!(table_has_column(&conn, "clipboard_records", "is_favorite").unwrap());
        assert!(table_has_column(&conn, "clipboard_records", "favorite_note").unwrap());
    }

    #[test]
    fn favorite_note_normalization_trims_and_limits_characters() {
        assert_eq!(normalize_favorite_note("  项目账号  ").unwrap(), "项目账号");
        assert_eq!(
            normalize_favorite_note(&"备".repeat(FAVORITE_NOTE_MAX_CHARS)).unwrap(),
            "备".repeat(FAVORITE_NOTE_MAX_CHARS)
        );
        assert!(normalize_favorite_note(&"备".repeat(FAVORITE_NOTE_MAX_CHARS + 1)).is_err());
    }

    #[test]
    fn explorer_migration_reclassifies_only_absolute_addresses() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE clipboard_records (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                content TEXT NOT NULL,
                source_app TEXT DEFAULT '',
                created_at TEXT NOT NULL
            );
            INSERT INTO clipboard_records (id, type, content, created_at) VALUES
                ('drive', 'text', 'C:\Users\Public', '2026-07-11T00:00:00Z'),
                ('unc', 'text', '\\server\share', '2026-07-11T00:01:00Z'),
                ('relative', 'text', 'folder\child', '2026-07-11T00:02:00Z'),
                ('link', 'link', 'https://example.com', '2026-07-11T00:03:00Z'),
                ('file', 'file', 'C:\Users\Public\file.txt', '2026-07-11T00:04:00Z');
            "#,
        )
        .unwrap();

        migrate_clipboard_record_schema(&conn).unwrap();
        migrate_clipboard_record_schema(&conn).unwrap();

        let rows: Vec<(String, String)> = conn
            .prepare("SELECT id, type FROM clipboard_records ORDER BY id")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("drive".into(), "explorer".into()),
                ("file".into(), "file".into()),
                ("link".into(), "link".into()),
                ("relative".into(), "text".into()),
                ("unc".into(), "explorer".into()),
            ]
        );

        assert_eq!(
            category_sql(&Some("explorer".to_string())),
            (
                "WHERE type = 'explorer'".to_string(),
                "AND type = 'explorer'".to_string(),
            )
        );
    }

    #[test]
    fn unreferenced_image_lookup_releases_database_lock() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clipboard_records (
                id TEXT PRIMARY KEY,
                content TEXT NOT NULL
            );
            INSERT INTO clipboard_records (id, content)
            VALUES ('kept', 'images/kept.png');",
        )
        .unwrap();
        let state = DbState {
            conn: Mutex::new(conn),
        };

        let unreferenced = collect_unreferenced_image_contents(
            &state,
            &["images/kept.png".into(), "images/orphan.png".into()],
        )
        .unwrap();

        assert_eq!(unreferenced, vec!["images/orphan.png"]);
        assert!(state.conn.try_lock().is_ok());
    }
}
