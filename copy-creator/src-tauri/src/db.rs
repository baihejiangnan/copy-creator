use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
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

/// 生成密钥预览。按**字符**而非字节计数与切分：密钥内容可能包含任意
/// Unicode（用户可手动把中文记录标记为 API Key），按字节切片会落在字符
/// 中间并 panic。
pub fn make_key_preview(content: &str) -> String {
    let c = content.trim();
    let char_count = c.chars().count();
    if char_count >= 12 {
        let head: String = c.chars().take(8).collect();
        let tail: String = c.chars().skip(char_count - 4).collect();
        format!("{}...{}", head, tail)
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
            "AND (user_api_key = 1 OR (type IN ('text', 'link') AND (content LIKE 'dpapi:v1:%' OR content LIKE 'sk-%' OR content LIKE 'AIza%' OR content LIKE 'glpat-%' OR content LIKE 'ghp_%' OR content LIKE 'xai-%')))".to_string(),
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
    // Connection changes hold conn; event stamps may read under a lifecycle producer permit.
    pub storage_epoch: AtomicU64,
    pub asset_reclaim_cursor: Mutex<Option<(u64, String)>>,
}

// Hold a producer permit, accepted async operation, or the connection lock;
// migration cannot change the connection/epoch until that guard is released.
pub(crate) fn require_storage_epoch(app: &AppHandle, expected: Option<u64>) -> Result<(), String> {
    if expected.is_some_and(|epoch| epoch != app.state::<DbState>().storage_epoch.load(Ordering::Relaxed)) {
        return Err("notes.storageChanged".into());
    }
    Ok(())
}

#[tauri::command]
pub fn get_storage_epoch(state: tauri::State<'_, DbState>) -> Result<u64, String> {
    let _conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(state.storage_epoch.load(Ordering::Relaxed))
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
pub(crate) const FAVORITE_NOTE_MAX_CHARS: usize = 200;

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
    get_storage_dir_for_connection(app, &conn)
}

pub(crate) fn get_storage_dir_for_connection(app: &AppHandle, conn: &Connection) -> PathBuf {
    connection_storage_dir(conn).unwrap_or_else(|| app.path()
        .app_data_dir()
        .expect("failed to get app data dir"))
}

fn connection_storage_dir(conn: &Connection) -> Option<PathBuf> {
    // storage_path is a startup forwarding pointer. After a missing destination
    // falls back to this database, assets must follow the actual open connection.
    conn.path().filter(|path| !path.is_empty())
        .and_then(|path| Path::new(path).parent())
        .filter(|path| !path.as_os_str().is_empty()).map(Path::to_path_buf)
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

pub(crate) fn storage_content_path(base_dir: &Path, content: &str) -> Option<PathBuf> {
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

static IMAGE_ACTIVITY: Mutex<()> = Mutex::new(());

// Lock order: lifecycle producer, image activity, then the DB mutex. Capture
// holds this until its reference is committed; reclamation rechecks afterwards.
pub(crate) fn image_activity() -> std::sync::MutexGuard<'static, ()> {
    IMAGE_ACTIVITY.lock().unwrap_or_else(|error| error.into_inner())
}

fn remove_stored_image(base_dir: &Path, content: &str) -> bool {
    let relative = Path::new(content);
    if !relative.starts_with("images") { return true; }
    let Some(file_path) = storage_content_path(base_dir, content) else {
        return true;
    };
    let remove = |path: &Path| match std::fs::remove_file(path) {
        Ok(()) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    };
    let original_removed = remove(&file_path);
    let mut thumbnail_removed = true;
    if let Some(filename) = file_path.file_name() {
        let thumb_path = file_path
            .parent()
            .unwrap_or(base_dir)
            .join("thumbs")
            .join(filename);
        thumbnail_removed = remove(&thumb_path);
    }
    original_removed && thumbnail_removed
}

fn reclaim_image(conn: &mut Connection, base: &Path, content: &str) -> rusqlite::Result<bool> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let referenced: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM clipboard_records WHERE type='image' AND content=?1)", [content], |row| row.get(0))?;
    let removed = !referenced && remove_stored_image(base, content);
    if removed {
        tx.execute("DELETE FROM clipboard_assets WHERE path=?1 AND ref_count=0", [content])?;
    }
    tx.commit()?;
    Ok(removed)
}

fn reclaim_stored_image(app: &AppHandle, content: &str) -> Result<(), String> {
    let _activity = image_activity();
    let state = app.state::<DbState>();
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let base = get_storage_dir_for_connection(app, &conn);
    reclaim_image(&mut conn, &base, content).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn stored_image_size(base_dir: &Path, content: &str) -> u64 {
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

// The caller holds an accepted lifecycle producer guard while modifying image
// files. Metadata is measured outside the DB mutex and applied at the same epoch.
pub(crate) fn refresh_image_asset(app: &AppHandle, content: &str) -> Result<(), String> {
    let state = app.state::<DbState>();
    let (base,epoch) = {
        let conn=state.conn.lock().map_err(|e|e.to_string())?;
        (get_storage_dir_for_connection(app,&conn),state.storage_epoch.load(Ordering::Relaxed))
    };
    let bytes=stored_image_size(&base,content);
    let conn=state.conn.lock().map_err(|e|e.to_string())?;
    if epoch!=state.storage_epoch.load(Ordering::Relaxed) {return Err("notes.storageChanged".into());}
    crate::clipboard_usage::set_asset_size(&conn,content,bytes).map_err(|e|e.to_string())
}

#[cfg(test)]
#[derive(Clone)]
struct UsageRecord {
    id: String,
    record_type: String,
    content: String,
    is_favorite: bool,
    protected_key: bool,
}

#[cfg(test)]
fn load_usage_records(conn: &Connection) -> Result<Vec<UsageRecord>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, type, content, is_favorite, (user_api_key = 1 OR content LIKE 'dpapi:v1:%' OR EXISTS(SELECT 1 FROM api_key_labels l WHERE l.record_id = clipboard_records.id)) FROM clipboard_records ORDER BY created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(UsageRecord {
                id: row.get(0)?,
                record_type: row.get(1)?,
                content: row.get(2)?,
                is_favorite: row.get::<_, i64>(3)? != 0,
                protected_key: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
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

#[cfg(test)]
fn plan_limit_cleanup(records: &[UsageRecord], base_dir: &Path, max_items: u64, max_bytes: u64) -> (Vec<String>, Vec<String>) {
    let mut count = records.len() as u64;
    let (mut bytes, mut image_refs, image_sizes) = usage_bytes(records, base_dir);
    let mut deleted_ids = Vec::new();
    let mut orphaned_images = Vec::new();
    for record in records.iter().filter(|record| !record.is_favorite && !record.protected_key) {
        if count <= max_items && bytes <= max_bytes { break; }
        count = count.saturating_sub(1);
        bytes = bytes.saturating_sub(RECORD_OVERHEAD_BYTES);
        if record.record_type == "image" {
            if let Some(ref_count) = image_refs.get_mut(&record.content) {
                *ref_count = ref_count.saturating_sub(1);
                if *ref_count == 0 {
                    bytes = bytes.saturating_sub(image_sizes.get(&record.content).copied().unwrap_or(0));
                    orphaned_images.push(record.content.clone());
                }
            }
        } else { bytes = bytes.saturating_sub(record.content.len() as u64); }
        deleted_ids.push(record.id.clone());
    }
    (deleted_ids, orphaned_images)
}

fn plan_limit_cleanup_metadata(conn: &Connection, max_items: u64, max_bytes: u64) -> rusqlite::Result<(Vec<String>,Vec<String>)> {
    let usage=crate::clipboard_usage::get(conn)?;
    let (mut count,mut bytes)=(usage.records,usage.bytes);
    let mut deleted=Vec::new();let mut orphaned=Vec::new();let mut image_refs=HashMap::new();
    if count<=max_items && bytes<=max_bytes {return Ok((deleted,orphaned));}
    let mut statement=conn.prepare("SELECT r.id,CASE WHEN r.type='image' THEN r.content END,
        CASE WHEN r.type<>'image' THEN length(CAST(r.content AS BLOB)) ELSE 0 END,
        COALESCE(a.ref_count,0),COALESCE(a.byte_size,0)
        FROM clipboard_records r LEFT JOIN clipboard_assets a ON r.type='image' AND a.path=r.content
        WHERE r.is_favorite=0 AND r.user_api_key=0 AND r.content NOT LIKE 'dpapi:v1:%'
        AND NOT EXISTS(SELECT 1 FROM api_key_labels l WHERE l.record_id=r.id)
        ORDER BY r.created_at,r.id")?;
    let mut rows=statement.query([])?;
    while count>max_items || bytes>max_bytes {
        let Some(row)=rows.next()? else {break;};
        let id:String=row.get(0)?;let image:Option<String>=row.get(1)?;let text_bytes:u64=row.get(2)?;
        count=count.saturating_sub(1);bytes=bytes.saturating_sub(RECORD_OVERHEAD_BYTES+text_bytes);
        if let Some(path)=image {
            let remaining=image_refs.entry(path.clone()).or_insert(row.get::<_,u64>(3)?);
            *remaining=remaining.saturating_sub(1);
            if *remaining==0 {bytes=bytes.saturating_sub(row.get::<_,u64>(4)?);orphaned.push(path);}
        }
        deleted.push(id);
    }
    Ok((deleted,orphaned))
}

fn persist_clipboard_limit(conn: &mut Connection, _base_dir: &Path, key: &str, value: &str, confirmed_count: Option<usize>) -> Result<(bool, Vec<String>, Vec<String>), String> {
    let proposed = value.parse::<u64>().map_err(|_| "settings.invalidNumber")?;
    let max_items = if key == "max_history_items" { proposed } else { setting_u64(conn, "max_history_items", DEFAULT_MAX_HISTORY_ITEMS) };
    let max_mb = if key == "max_storage_mb" { proposed } else { setting_u64(conn, "max_storage_mb", DEFAULT_MAX_STORAGE_MB) };
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let (deleted_ids, orphaned_images) = plan_limit_cleanup_metadata(&tx,max_items,max_mb.saturating_mul(1024 * 1024)).map_err(|e|e.to_string())?;
    // Recompute while holding the same database lock used for the commit.
    // A changed cleanup count requires another confirmation before any write.
    if !deleted_ids.is_empty() && confirmed_count != Some(deleted_ids.len()) {
        return Ok((false, deleted_ids, orphaned_images));
    }
    tx.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2", params![key, value]).map_err(|e| e.to_string())?;
    for id in &deleted_ids {
        tx.execute("DELETE FROM api_key_labels WHERE record_id = ?1", [id]).map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM clipboard_records WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok((true, deleted_ids, orphaned_images))
}

#[tauri::command]
pub fn save_clipboard_limit(app: AppHandle, key: String, value: String, confirmed_count: Option<usize>, expected_storage_epoch: Option<u64>,
) -> Result<serde_json::Value, String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
    if !matches!(key.as_str(), "max_history_items" | "max_storage_mb") || validate_import_setting(&key, &value).is_none() {
        return Err("settings.invalidNumber".into());
    }
    let base_dir = get_storage_dir(&app);
    let (saved, deleted_ids, orphaned_images) = {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        persist_clipboard_limit(&mut conn, &base_dir, &key, &value, confirmed_count)?
    };
    if !saved { return Ok(serde_json::json!({ "saved": false, "cleanup_count": deleted_ids.len() })); }
    for content in orphaned_images { reclaim_stored_image(&app, &content)?; }
    for id in &deleted_ids { let _ = crate::storage_events::emit(&app,"clipboard-deleted", id); }
    crate::tray::schedule_tray_refresh(&app);
    Ok(serde_json::json!({ "saved": true, "cleanup_count": deleted_ids.len() }))
}

pub fn enforce_clipboard_limits(app: &AppHandle) -> Result<usize, String> {
    let mut total = 0;
    loop {
      let deleted = {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        let max_items = setting_u64(&conn, "max_history_items", DEFAULT_MAX_HISTORY_ITEMS);
        let max_bytes = setting_u64(&conn, "max_storage_mb", DEFAULT_MAX_STORAGE_MB)
            .saturating_mul(1024 * 1024);
        let usage=crate::clipboard_usage::get(&conn).map_err(|e|e.to_string())?;
        if usage.records<=max_items && usage.bytes<=max_bytes {return Ok(total);}
        crate::clipboard_usage::cleanup_batch(&mut conn,max_items,max_bytes).map_err(|e|e.to_string())?
      };
      if deleted.is_empty() { return Ok(total); } // Protected records can exceed the limit.
      total += deleted.len();
      for (id, image) in deleted {
        if let Some(content) = image { reclaim_stored_image(app, &content)?; }
        let _ = crate::storage_events::emit(&app,"clipboard-deleted", &id);
      }
      std::thread::yield_now();
    }
}

#[tauri::command]
pub fn get_clipboard_storage_stats(app: AppHandle) -> Result<serde_json::Value, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let usage=crate::clipboard_usage::get(&conn).map_err(|e|e.to_string())?;
    let max_items = setting_u64(&conn, "max_history_items", DEFAULT_MAX_HISTORY_ITEMS);
    let max_storage_mb = setting_u64(&conn, "max_storage_mb", DEFAULT_MAX_STORAGE_MB);

    Ok(serde_json::json!({
        "record_count": usage.records,
        "favorite_count": usage.favorites,
        "usage_bytes": usage.bytes,
        "max_history_items": max_items,
        "max_storage_bytes": max_storage_mb.saturating_mul(1024 * 1024),
        "over_limit": usage.records > max_items
            || usage.bytes > max_storage_mb.saturating_mul(1024 * 1024),
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

/// The same connection contract is used for startup and storage destinations.
/// FULL syncs each WAL commit before acknowledging saved data. This relies on
/// the filesystem/device honoring sync; it is not a substitute for backups.
pub(crate) fn initialize_connection(conn: &mut Connection) -> Result<(), Box<dyn std::error::Error>> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > 6 {
        return Err("database schema is newer than this application".into());
    }
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let journal: String = conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    // SQLite can return a different mode without treating it as an error.
    // In-memory fixtures use 'memory'; persistent connections must use WAL.
    if journal != "wal" && journal != "memory" {
        return Err("storage.walUnavailable".into());
    }
    conn.execute_batch("PRAGMA synchronous=FULL; PRAGMA cache_size=-8000; PRAGMA foreign_keys=ON;")?;
    if version < 1 {
        let tx = conn.transaction()?;
        initialize_schema_v1(&tx)?;
        tx.execute_batch("PRAGMA user_version=1;")?;
        tx.commit()?;
    }
    if version < 2 {
        let tx = conn.transaction()?;
        crate::notes::init_schema(&tx)?;
        tx.execute_batch("PRAGMA user_version=2;")?;
        tx.commit()?;
    }
    if version < 3 {
        let tx = conn.transaction()?;
        crate::note_backup::init_schema(&tx)?;
        tx.execute_batch("PRAGMA user_version=3;")?;
        tx.commit()?;
    }
    if version < 4 {
        let tx = conn.transaction()?;
        crate::clipboard_usage::init_schema(&tx)?;
        tx.execute_batch("PRAGMA user_version=4;")?;
        tx.commit()?;
    }
    if version < 5 {
        let tx = conn.transaction()?;
        crate::note_search::init_schema(&tx)?;
        tx.execute_batch("PRAGMA user_version=5;")?;
        tx.commit()?;
    }
    if version < 6 {
        let tx = conn.transaction()?;
        crate::suiji::init_schema(&tx)?;
        crate::note_backup::promote_phrases(&tx)?;
        tx.execute("INSERT OR IGNORE INTO settings(key,value) VALUES('note_shortcut_key','Ctrl+Alt+N')",[])?;
        tx.execute_batch("PRAGMA user_version=6;")?;
        tx.commit()?;
    }
    migrate_secrets(conn)?;
    Ok(())
}

fn initialize_schema_v1(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
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
        INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_check_updates', '1');
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
    migrate_clipboard_record_schema(conn)?;
    conn.execute(
        "INSERT OR IGNORE INTO api_services (name, api_base) SELECT service, api_base FROM api_key_labels WHERE service <> '' ORDER BY updated_at DESC",
        [],
    )?;
    crate::vault::init_schema(conn)?;
    Ok(())
}

pub fn init_db(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let mut conn = Connection::open(db_path(app))?;
    initialize_connection(&mut conn)?;
    app.manage(DbState {
        conn: Mutex::new(conn),
        storage_epoch: AtomicU64::new(1),
        asset_reclaim_cursor: Mutex::new(None),
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

fn prune_expired_records(conn: &Connection, days: i64) -> rusqlite::Result<Vec<(String, String, String)>> {
    let tx = conn.unchecked_transaction()?;
    let records = {
        let mut stmt = tx.prepare("SELECT id, type, CASE WHEN type='image' THEN content ELSE '' END FROM clipboard_records WHERE is_favorite = 0
            AND user_api_key = 0 AND content NOT LIKE 'dpapi:v1:%'
            AND NOT EXISTS(SELECT 1 FROM api_key_labels l WHERE l.record_id = clipboard_records.id)
            AND datetime(created_at) < datetime('now', ?1) ORDER BY created_at,id LIMIT 100")?;
        let rows = stmt.query_map(params![format!("-{days} days")], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, _, _) in &records {
        tx.execute("DELETE FROM clipboard_records WHERE id = ?1", [id])?;
    }
    tx.commit()?;
    Ok(records)
}

pub fn prune_old_records(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    prune_records(app, false).map(|_| ())
}
pub(crate) fn prune_old_records_background(app: &AppHandle) -> Result<bool, Box<dyn std::error::Error>> {
    prune_records(app, true)
}
fn prune_records(app: &AppHandle, background: bool) -> Result<bool, Box<dyn std::error::Error>> {
    if background && crate::notes::writes_pending() { return Ok(false); }
    let days = {
        let state = app.state::<DbState>();
        let conn = if background {
            match state.conn.try_lock() { Ok(conn) => conn, Err(std::sync::TryLockError::WouldBlock) => return Ok(false), Err(_) => return Err("database lock failed".into()) }
        } else { state.conn.lock().map_err(|e| e.to_string())? };

        let retention: String = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'clipboard_retention'",
                [],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| "1month".to_string());

        match retention.as_str() {
            "1week" => 7,
            "3months" => 90,
            _ => 30,
        }
    };
    loop {
        let records = {
            let state = app.state::<DbState>();
            if background && crate::notes::writes_pending() { return Ok(false); }
            let waiting = std::time::Instant::now();
            let mut conn = if background {
                match state.conn.try_lock() { Ok(conn) => conn, Err(std::sync::TryLockError::WouldBlock) => return Ok(false), Err(_) => return Err("database lock failed".into()) }
            } else { state.conn.lock().map_err(|e| e.to_string())? };
            let lock_wait_us = waiting.elapsed().as_micros();
            if background && crate::notes::writes_pending() { return Ok(false); }
            let executing = std::time::Instant::now();
            let (result, sql) = crate::db_metrics::measure(&mut conn, |conn| prune_expired_records(conn, days));
            let held_us = executing.elapsed().as_micros();
            drop(conn);
            if let Some(metrics) = sql {
                log::debug!(target: "copy_creator::metrics", "cleanup operation=clipboard_ttl ok={} queued_us=0 lock_wait_us={lock_wait_us} held_us={held_us} sql_count={} sql_profile_ms={}", result.is_ok(), metrics.statements, metrics.elapsed_ms);
            }
            result?
        };
        let count = records.len();
        for (id, kind, content) in records {
            if kind == "image" { reclaim_stored_image(app, &content)?; }
            let _ = crate::storage_events::emit(&app,"clipboard-deleted", id);
        }
        if count < 100 { break; }
        if background { return Ok(false); }
        std::thread::yield_now();
    }
    // Failed unlinks leave zero-reference entries for bounded retry next time.
    let pending = {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let epoch = state.storage_epoch.load(Ordering::Relaxed);
        let mut cursor = state.asset_reclaim_cursor.lock().map_err(|e| e.to_string())?;
        let after = cursor.as_ref().filter(|(stored, _)| *stored == epoch).map(|(_, path)| path.as_str());
        let rows = crate::clipboard_usage::reclaim_candidates(&conn, after)?;
        *cursor = rows.last().map(|path| (epoch, path.clone()));
        rows
    };
    for content in pending { reclaim_stored_image(app, &content)?; }

    // Clean up temp paste image files older than retention period
    let paste_dir = crate::paste::paste_image_directory(app);
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

    // Tray refresh reads settings, so no database guard may be alive here.
    crate::tray::refresh_tray_menu(app).ok();

    Ok(true)
}

// ---- Tauri Commands ----

#[derive(serde::Deserialize)]
pub struct ClipboardCursor { created_at: String, id: String }

#[tauri::command(async)]
pub fn get_clipboard_records(
    app: AppHandle,
    search: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    category: Option<String>,
    cursor: Option<ClipboardCursor>,
    expected_storage_epoch: Option<u64>,
) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    if expected_storage_epoch.is_some_and(|epoch|epoch!=state.storage_epoch.load(Ordering::Relaxed)) {return Err("notes.storageChanged".into());}
    query_clipboard_records(&conn,search,limit,offset,category,cursor)
}

fn query_clipboard_records(conn:&Connection,search:Option<String>,limit:Option<u32>,offset:Option<u32>,category:Option<String>,cursor:Option<ClipboardCursor>) -> Result<Vec<serde_json::Value>,String> {
    let lim = limit.unwrap_or(200).clamp(1,200);
    let off = if cursor.is_some() {0} else {offset.unwrap_or(0)};
    let category_filter=category_sql(&category).1;
    let search=search.filter(|q|!q.is_empty()).map(|q|q.replace('\\',"\\\\").replace('%',"\\%").replace('_',"\\_"));
    let sql=format!("SELECT id,type,content,source_app,created_at,user_api_key,is_favorite,favorite_note FROM clipboard_records WHERE (?1 IS NULL OR content LIKE '%'||?1||'%' ESCAPE '\\' OR favorite_note LIKE '%'||?1||'%' ESCAPE '\\') {category_filter} AND (?2 IS NULL OR created_at<?2 OR (created_at=?2 AND id<?3)) ORDER BY created_at DESC,id DESC LIMIT ?4 OFFSET ?5");
    let mut stmt=conn.prepare(&sql).map_err(|e|e.to_string())?;
    let rows=stmt.query_map(params![search,cursor.as_ref().map(|c|&c.created_at),cursor.as_ref().map(|c|&c.id),lim,off],clipboard_record_json).map_err(|e|e.to_string())?;
    let records:Vec<serde_json::Value>=rows.collect::<rusqlite::Result<_>>().map_err(|e|e.to_string())?;

    // Build label map for API key enrichment
    let mut label_map: std::collections::HashMap<String, serde_json::Value> =
        std::collections::HashMap::new();
    if let Ok(mut stmt) =
        conn.prepare(&format!("SELECT record_id,service,api_base,note,is_expired FROM api_key_labels WHERE record_id IN ({})", (0..records.len()).map(|_|"?").collect::<Vec<_>>().join(",")))
    {
        if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(records.iter().map(|r|r["id"].as_str().unwrap_or(""))), |row| {
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
pub fn get_clipboard_record_content(app: AppHandle, id: String, expected_storage_epoch: Option<u64>) -> Result<String, String> {
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    if expected_storage_epoch.is_some_and(|epoch|epoch!=state.storage_epoch.load(Ordering::Relaxed)) {return Err("notes.storageChanged".into());}
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
) -> Result<(u64, Vec<ClipboardActionRecord>), String> {
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
    Ok((state.storage_epoch.load(Ordering::Relaxed), records))
}

#[tauri::command]
pub fn toggle_clipboard_favorite(app: AppHandle, id: String, expected_storage_epoch: Option<u64>,
) -> Result<bool, String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
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

    let _ = crate::storage_events::emit(&app,
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
    note: String, expected_storage_epoch: Option<u64>,
) -> Result<String, String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
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

    let _ = crate::storage_events::emit(&app,
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
    let _ = crate::storage_events::emit(&app,"clipboard-unread-changed", count);
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
pub fn mark_clipboard_read(app: AppHandle, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
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
    let _ = crate::storage_events::emit(&app,"clipboard-unread-changed", 0);
    crate::tray::schedule_tray_refresh(&app);
    Ok(())
}

#[tauri::command]
pub fn delete_clipboard_record(app: AppHandle, id: String, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
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

        let _ = crate::storage_events::emit(&app,"clipboard-deleted", &id);

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
        reclaim_stored_image(&app, &content)?;
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
pub fn create_phrase_group(app: AppHandle, name: String, expected_storage_epoch: Option<u64>,
) -> Result<serde_json::Value, String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO phrase_groups (id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, 0, ?3, ?4)",
        params![id, name, &now, &now],
    )
    .map_err(|e| e.to_string())?;
    let _ = crate::storage_events::emit(&app,"phrase-groups-changed", ());
    Ok(serde_json::json!({
        "id": id,
        "name": name,
        "sort_order": 0,
        "created_at": now,
        "updated_at": now,
    }))
}

#[tauri::command]
pub fn update_phrase_group(app: AppHandle, id: String, name: String, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE phrase_groups SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![name, &now, id],
    )
    .map_err(|e| e.to_string())?;
    let _ = crate::storage_events::emit(&app,"phrase-groups-changed", ());
    Ok(())
}

#[tauri::command]
pub fn delete_phrase_group(app: AppHandle, id: String, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
    let state = app.state::<DbState>();
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e|e.to_string())?;
    crate::note_backup::promote_phrases(&tx)?;
    crate::suiji::delete_group(&tx, &id)?;
    tx.commit().map_err(|e|e.to_string())?;
    let _ = crate::storage_events::emit(&app,"phrase-groups-changed", ());
    let _ = crate::storage_events::emit(&app,"notes-changed", ());
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
    content: String, expected_storage_epoch: Option<u64>,
) -> Result<serde_json::Value, String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
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
    content: String, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
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
pub fn delete_phrase(app: AppHandle, id: String, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
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
pub fn clear_translation_history(app: AppHandle, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM translation_history", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_setting(app: AppHandle, key: String) -> Result<String, String> {
    if key.starts_with("internal_") { return Err("internal setting".into()); }
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
        if k.starts_with("internal_") { continue; }
        if crate::secrets::is_setting_secret(&k) {
            map.insert(format!("{k}_configured"), (!v.is_empty()).to_string());
        } else {
            map.insert(k, v);
        }
    }
    Ok(map)
}

pub(crate) const EXPORT_SETTING_KEYS: &[&str] = &[
    "vault_auto_lock",
    "clipboard_retention",
    "dedupe_window_seconds",
    "default_translate_engine",
    "theme",
    "language",
    "radial_menu_enabled",
    "shortcut_key",
    "note_shortcut_key",
    "ai_api_url",
    "ai_model",
    "translate_proxy",
    "max_history_items",
    "max_storage_mb",
    "image_max_dimension",
    "image_compression_quality",
    "large_image_handling",
    "clipboard_notifications",
    "auto_check_updates",
];

pub(crate) fn validate_import_setting(key: &str, value: &str) -> Option<String> {
    if !EXPORT_SETTING_KEYS.contains(&key) || value.len() > 4_096 {
        return None;
    }

    let valid = match key {
        "vault_auto_lock" => matches!(value, "never" | "24hours" | "3hours" | "on_startup"),
        "clipboard_retention" => matches!(value, "1week" | "1month" | "3months"),
        "dedupe_window_seconds" => matches!(value, "1" | "5" | "30" | "60" | "300" | "900" | "1800"),
        "default_translate_engine" => matches!(value, "google" | "ai"),
        "theme" => matches!(value, "light" | "dark"),
        "language" => matches!(value, "zh-CN" | "en"),
        "radial_menu_enabled" | "clipboard_notifications" | "auto_check_updates" => matches!(value, "0" | "1"),
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

fn image_storage_dir(app: &AppHandle, expected: Option<u64>) -> Result<PathBuf,String> {
    let db=app.state::<DbState>(); let conn=db.conn.lock().map_err(|e|e.to_string())?;
    if expected.is_some_and(|epoch|epoch!=db.storage_epoch.load(Ordering::Relaxed)) {return Err("notes.storageChanged".into());}
    Ok(get_storage_dir_for_connection(app,&conn))
}

#[tauri::command(async)]
pub fn get_image_base64(
    app: AppHandle,
    path: String,
    max_size: u32,
    expected_storage_epoch: Option<u64>,
) -> Result<String, String> {
    let mut base_dir = image_storage_dir(&app, expected_storage_epoch)?;
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
pub fn get_image_thumbnail(app: AppHandle, path: String, max_size: u32, expected_storage_epoch: Option<u64>) -> Result<String, String> {
    let lifecycle=app.state::<crate::lifecycle::LifecycleState>();
    let _producer=lifecycle.try_producer().ok_or("lifecycle.busy")?;
    let base_dir = image_storage_dir(&app, expected_storage_epoch)?;
    let max_size = max_size.clamp(32, 512);
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
        // Decode stays outside image activity and the DB lock. A deleted
        // record can finish its read, but must not recreate a reclaimed asset.
        let _activity = image_activity();
        let referenced = {
            let state=app.state::<DbState>();
            let conn=state.conn.lock().map_err(|e|e.to_string())?;
            conn.query_row("SELECT EXISTS(SELECT 1 FROM clipboard_records WHERE type='image' AND content=?1)",[&path],|row|row.get::<_,bool>(0)).map_err(|e|e.to_string())?
        };
        if referenced && image_path.is_file() {
            std::fs::create_dir_all(&thumb_dir).ok();
            if std::fs::write(&thumb_path, &data).is_ok() {refresh_image_asset(&app,&path)?;}
        }
        data
    };

    Ok(base64::engine::general_purpose::STANDARD.encode(&thumb_bytes))
}

#[tauri::command]
pub fn set_setting(app: AppHandle, key: String, value: String, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    if key.starts_with("internal_") { return Err("internal setting".into()); }
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
    if key == "storage_path" {
        return Err("lifecycle.barrierRequired".into());
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
        crate::lifecycle::allow_write(&app)?;
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
    if key == "vault_auto_lock" {
        crate::vault::refresh_auto_lock(&app)?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_settings_batch(
    app: AppHandle,
    settings: std::collections::HashMap<String, String>, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
    if settings.contains_key("storage_path") { return Err("lifecycle.barrierRequired".into()); }
    if settings.keys().any(|key| key.starts_with("internal_")) { return Err("internal setting".into()); }

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
        crate::lifecycle::allow_write(&app)?;
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
    if settings.contains_key("vault_auto_lock") {
        crate::vault::refresh_auto_lock(&app)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn change_storage_directory(app: AppHandle, operation_token: String, new_path: String) -> Result<u64, String> {
    let guard = crate::lifecycle::claim_operation(&app, &operation_token, "storage")?;
    tauri::async_runtime::spawn_blocking(move || {
        {
            let db = app.state::<DbState>();
            let _conn = db.conn.lock().map_err(|_| "lifecycle.failed")?;
            guard.validate_epoch(&db)?;
        }
        migrate_storage(&app, &new_path)?;
        let db = app.state::<DbState>();
        let _conn = db.conn.lock().map_err(|_| "lifecycle.failed")?;
        Ok(db.storage_epoch.load(Ordering::Relaxed))
    }).await.map_err(|_| "lifecycle.failed")?
}
fn migrate_storage(app: &AppHandle, new_path: &str) -> Result<(), String> {
    let custom_dir = PathBuf::from(new_path);
    if !custom_dir.is_absolute() { return Err("notes.invalidStoragePath".into()); }
    std::fs::create_dir_all(&custom_dir).map_err(|_| "notes.storageMigrationFailed")?;
    let custom_dir = std::fs::canonicalize(custom_dir).map_err(|_| "notes.storageMigrationFailed")?;
    let custom_db = custom_dir.join("data.db");
    let destination_path = custom_dir.to_str().ok_or("notes.invalidStoragePath")?.to_owned();
    crate::vault::lock_and_notify(app);
    let state = app.state::<DbState>();
    let epoch = {
        let mut conn = state.conn.lock().map_err(|_| "notes.storageMigrationFailed")?;
        let source_file = conn.path().ok_or("notes.storageMigrationFailed")?;
        let source_file = std::fs::canonicalize(source_file).map_err(|_| "notes.storageMigrationFailed")?;
        if custom_db == source_file { return Ok(()); }
        let source_path = source_file.to_str().ok_or("notes.invalidStoragePath")?.to_owned();
        let mut destination = Connection::open(&custom_db).map_err(|_| "notes.storageMigrationFailed")?;
        initialize_connection(&mut destination).map_err(|_| "notes.storageMigrationFailed")?;
        crate::storage::prepare_target(&conn, &mut destination, &source_path, &destination_path, chrono::Utc::now().timestamp_millis())?;
        // A failure leaves the old connection/epoch intact. The committed target
        // receipt can verify and refresh only this operation's own staged data.
        conn.execute("INSERT INTO settings(key,value) VALUES('storage_path',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&destination_path])
            .map_err(|_| "notes.storageMigrationFailed")?;
        *conn = destination;
        state.storage_epoch.fetch_add(1, Ordering::Relaxed) + 1
    };
    let _ = app.emit("storage-changed", serde_json::json!({ "storage_epoch": epoch }));
    log::info!("Storage relocation committed at epoch {epoch}");
    Ok(())
}
#[tauri::command]
pub fn get_storage_path(app: AppHandle) -> Result<String, String> {
    Ok(get_storage_dir(&app).to_string_lossy().to_string())
}

#[tauri::command(async)]
pub fn ensure_thumbnail(app: AppHandle, path: String) -> Result<String, String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
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
    let dialog=crate::NativeDialogScope::new().ok_or("notes.busy")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let parent=app.get_webview_window("main").ok_or("notes.fileDialogFailed")?;
    app.dialog().file().set_parent(&parent).pick_folder(move |path| {
        let _dialog=dialog;
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
    note: String, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
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
    user_api_key: bool,
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

const DEFAULT_CLEANUP_CATEGORIES: &[&str] = &["text", "image", "link", "explorer", "file"];

fn cleanup_categories(categories: Option<&[String]>) -> Result<Vec<String>, String> {
    let categories = categories.map(|values| values.to_vec()).unwrap_or_else(|| {
        DEFAULT_CLEANUP_CATEGORIES.iter().map(|value| (*value).to_string()).collect()
    });
    if categories.iter().any(|value| !DEFAULT_CLEANUP_CATEGORIES.contains(&value.as_str()) && value != "apikey" && value != "vault") {
        return Err("invalid cleanup category".to_string());
    }
    Ok(categories)
}

fn cleanup_candidates(conn: &Connection, mode: &str, period: Option<&str>, categories: Option<&[String]>) -> Result<Vec<CleanupRecord>, String> {
    let cutoff = if mode == "older_than" {
        Some(cleanup_cutoff(period.ok_or_else(|| "missing cleanup period".to_string())?)?)
    } else if mode == "dedupe" {
        None
    } else {
        return Err("invalid cleanup mode".to_string());
    };
    let mut stmt = conn.prepare(
        "SELECT r.id, r.type, r.content, r.is_favorite, EXISTS(SELECT 1 FROM api_key_labels l WHERE l.record_id = r.id), r.created_at, r.user_api_key FROM clipboard_records r ORDER BY r.created_at DESC",
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(CleanupRecord {
            id: row.get(0)?, record_type: row.get(1)?, content: row.get(2)?,
            is_favorite: row.get::<_, i64>(3)? != 0,
            has_label: row.get::<_, i64>(4)? != 0,
            created_at: row.get(5)?,
            user_api_key: row.get::<_, i64>(6)? != 0,
        })
    }).map_err(|e| e.to_string())?;
    let mut records = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    if let Some(cutoff) = cutoff {
        let categories = cleanup_categories(categories)?;
        let mut candidates: Vec<_> = records.into_iter().filter(|record| {
            let is_key = record.user_api_key || record.has_label || crate::secrets::is_protected(&record.content)
                || (matches!(record.record_type.as_str(), "text" | "link") && is_api_key(&record.content));
            let category = if is_key { "apikey" } else { record.record_type.as_str() };
            categories.iter().any(|selected| selected == category)
                && !record.is_favorite && chrono::DateTime::parse_from_rfc3339(&record.created_at)
                .is_ok_and(|created_at| created_at < cutoff)
        }).collect();
        if categories.iter().any(|category| category == "vault") {
            let mut stmt = conn.prepare("SELECT id, created_at FROM vault_entries").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            for row in rows {
                let (id, created_at) = row.map_err(|e| e.to_string())?;
                if chrono::DateTime::parse_from_rfc3339(&created_at).is_ok_and(|created_at| created_at < cutoff) {
                    candidates.push(CleanupRecord {
                        id, created_at, record_type: "vault".to_string(), content: String::new(),
                        is_favorite: false, has_label: false, user_api_key: false,
                    });
                }
            }
        }
        return Ok(candidates);
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
pub fn preview_clipboard_cleanup(app: AppHandle, mode: String, period: Option<String>, categories: Option<Vec<String>>) -> Result<usize, String> {
    let preview = || {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        Ok(cleanup_candidates(&conn, &mode, period.as_deref(), categories.as_deref())?.len())
    };
    if mode == "older_than" && categories.as_ref().is_some_and(|values| values.iter().any(|value| value == "vault")) {
        crate::vault::with_cleanup_access(&app, preview)
    } else {
        preview()
    }
}

fn delete_cleanup_candidates(conn: &mut Connection, mode: &str, period: Option<&str>, categories: Option<&[String]>) -> Result<Vec<CleanupRecord>, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let candidates = cleanup_candidates(&tx, mode, period, categories)?;
    for record in &candidates {
        if record.record_type == "vault" {
            tx.execute("DELETE FROM vault_entries WHERE id = ?1", params![&record.id]).map_err(|e| e.to_string())?;
        } else {
            tx.execute("DELETE FROM api_key_labels WHERE record_id = ?1", params![&record.id]).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM clipboard_records WHERE id = ?1", params![&record.id]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(candidates)
}

#[tauri::command]
pub fn apply_clipboard_cleanup(app: AppHandle, mode: String, period: Option<String>, categories: Option<Vec<String>>, expected_storage_epoch: Option<u64>,
) -> Result<usize, String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
    let apply = || {
        let state = app.state::<DbState>();
        let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
        delete_cleanup_candidates(&mut conn, &mode, period.as_deref(), categories.as_deref())
    };
    let candidates = if mode == "older_than" && categories.as_ref().is_some_and(|values| values.iter().any(|value| value == "vault")) {
        crate::vault::with_cleanup_access(&app, apply)?
    } else {
        apply()?
    };
    let image_contents: Vec<String> = candidates.iter().filter(|record| record.record_type == "image").map(|record| record.content.clone()).collect();
    let state = app.state::<DbState>();
    let unreferenced = collect_unreferenced_image_contents(&state, &image_contents)?;
    for content in unreferenced { reclaim_stored_image(&app, &content)?; }
    let _ = crate::storage_events::emit(&app,"clipboard-refresh", ());
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
pub fn delete_api_key_label(app: AppHandle, record_id: String, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
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
pub fn mark_expired(app: AppHandle, record_id: String, expired: bool, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
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
pub fn mark_toast_shown(app: AppHandle, key_preview: String, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
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
pub fn set_user_api_key(app: AppHandle, id: String, value: bool, expected_storage_epoch: Option<u64>,
) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    require_storage_epoch(&app, expected_storage_epoch)?;
    let state = app.state::<DbState>();
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    set_user_api_key_conn(&conn, &id, value)
}

// Manual marking supports long tokens/JWTs/PEM keys; the 200-byte automatic
// detection heuristic is deliberately unrelated to this 16 KiB input budget.
const MANUAL_API_KEY_MAX_BYTES: usize = 16 * 1024;
fn set_user_api_key_conn(conn: &Connection, id: &str, value: bool) -> Result<(), String> {
    let (record_type, content): (String, String) = conn.query_row(
        "SELECT type,content FROM clipboard_records WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?))
    ).optional().map_err(|_| "clipboard.updateFailed")?.ok_or("clipboard.recordNotFound")?;
    if !matches!(record_type.as_str(), "text" | "link") { return Err("clipboard.invalidRecordType".into()); }
    if value {
        // Bound the ciphertext before decoding it, then apply the limit to the
        // recovered UTF-8 bytes, not DPAPI/base64 overhead.
        if content.len() > MANUAL_API_KEY_MAX_BYTES * 2 + 4096 { return Err("clipboard.apiKeyTooLong".into()); }
        let plain = crate::secrets::reveal(&content).map_err(|_| "clipboard.updateFailed")?;
        if plain.len() > MANUAL_API_KEY_MAX_BYTES { return Err("clipboard.apiKeyTooLong".into()); }
    }
    let stored_content = if value && !crate::secrets::is_protected(&content) {
        crate::secrets::protect(&content).map_err(|_| "clipboard.updateFailed")?
    } else { content };
    conn.execute(
        "UPDATE clipboard_records SET user_api_key = ?1, content = ?2 WHERE id = ?3",
        params![value as i64, stored_content, id],
    )
    .map_err(|_| "clipboard.updateFailed")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manual_key_db(kind: &str, content: &str) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE clipboard_records(id TEXT PRIMARY KEY,type TEXT,content TEXT,user_api_key INTEGER DEFAULT 0);").unwrap();
        conn.execute("INSERT INTO clipboard_records(id,type,content) VALUES('record',?1,?2)", params![kind,content]).unwrap();
        conn
    }
    fn manual_key_row(conn: &Connection) -> (String, i64) {
        conn.query_row("SELECT content,user_api_key FROM clipboard_records WHERE id='record'", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap()
    }
    #[test]
    fn manual_api_key_rejects_path_types_without_changing_content_or_flag() {
        for kind in ["image", "file", "explorer"] {
            let conn = manual_key_db(kind, "images/synthetic.png");
            let before = manual_key_row(&conn);
            assert_eq!(set_user_api_key_conn(&conn, "record", true).unwrap_err(), "clipboard.invalidRecordType");
            assert_eq!(manual_key_row(&conn), before);
        }
    }
    #[test]
    fn manual_api_key_supports_long_text_and_link_keys_and_ciphertext_retries() {
        for kind in ["text", "link"] {
            let plain = "k".repeat(MANUAL_API_KEY_MAX_BYTES);
            let conn = manual_key_db(kind, &plain);
            set_user_api_key_conn(&conn, "record", true).unwrap();
            let (stored, flag) = manual_key_row(&conn);
            assert!(crate::secrets::is_protected(&stored)); assert_eq!(flag, 1);
            assert_eq!(crate::secrets::reveal(&stored).unwrap(), plain);
            set_user_api_key_conn(&conn, "record", true).unwrap();
            assert_eq!(manual_key_row(&conn).0, stored);
        }
    }
    #[test]
    fn manual_api_key_rejects_oversized_utf8_without_mutation_but_allows_unmarking() {
        for plain in ["k".repeat(MANUAL_API_KEY_MAX_BYTES + 1), "中".repeat(MANUAL_API_KEY_MAX_BYTES / 3 + 1)] {
            for content in [plain.clone(), crate::secrets::protect(&plain).unwrap()] {
                let conn = manual_key_db("text", &content);
                let before = manual_key_row(&conn);
                assert_eq!(set_user_api_key_conn(&conn, "record", true).unwrap_err(), "clipboard.apiKeyTooLong");
                assert_eq!(manual_key_row(&conn), before);
                set_user_api_key_conn(&conn, "record", false).unwrap();
                assert_eq!(manual_key_row(&conn).0, content);
            }
        }
    }

    fn legacy_v3(conn: &Connection) {
        initialize_schema_v1(conn).unwrap();
        crate::notes::init_schema(conn).unwrap();
        crate::note_backup::init_schema(conn).unwrap();
        conn.execute_batch("PRAGMA user_version=3;").unwrap();
    }

    #[test]
    fn clipboard_accounting_migrates_existing_shared_assets_once_and_rolls_back_failures() {
        let root=std::env::temp_dir().join(format!("copy-creator-accounting-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("images/thumbs")).unwrap();
        std::fs::write(root.join("images/shared.png"),[0u8;100]).unwrap();
        std::fs::write(root.join("images/thumbs/shared.png"),[0u8;20]).unwrap();
        let path=root.join("data.db");
        {
            let mut conn=Connection::open(&path).unwrap();legacy_v3(&conn);
            conn.execute_batch("INSERT INTO clipboard_records(id,type,content,created_at,is_favorite) VALUES
              ('a','image','images/shared.png','now',0),('b','image','images/shared.png','now',1),('c','text','中文','now',0);").unwrap();
            initialize_connection(&mut conn).unwrap();
            let usage=crate::clipboard_usage::get(&conn).unwrap();
            assert_eq!((usage.records,usage.favorites,usage.bytes),(3,1,894));
            initialize_connection(&mut conn).unwrap();assert_eq!(crate::clipboard_usage::get(&conn).unwrap().bytes,894);
        }
        for file in ["images/shared.png","images/thumbs/shared.png","data.db","data.db-wal","data.db-shm"] {let _=std::fs::remove_file(root.join(file));}
        std::fs::remove_dir(root.join("images/thumbs")).unwrap();std::fs::remove_dir(root.join("images")).unwrap();std::fs::remove_dir(root).unwrap();
        let mut broken=Connection::open_in_memory().unwrap();legacy_v3(&broken);
        broken.execute_batch("CREATE TABLE clipboard_assets(existing TEXT);INSERT INTO clipboard_assets VALUES('kept');").unwrap();
        assert!(initialize_connection(&mut broken).is_err());
        assert_eq!(broken.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),3);
        assert!(broken.prepare("SELECT * FROM clipboard_usage").is_err());
        assert_eq!(broken.query_row("SELECT existing FROM clipboard_assets",[],|r|r.get::<_,String>(0)).unwrap(),"kept");
    }

    #[test]
    fn clipboard_reclamation_rechecks_references_and_retains_failed_unlinks() {
        let root=std::env::temp_dir().join(format!("copy-creator-reclaim-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("images/thumbs")).unwrap();
        std::fs::write(root.join("images/shared.png"),[0u8;10]).unwrap();
        std::fs::write(root.join("images/thumbs/shared.png"),[0u8;5]).unwrap();
        let mut conn=Connection::open_in_memory().unwrap();initialize_connection(&mut conn).unwrap();
        conn.execute_batch("INSERT INTO clipboard_records(id,type,content,created_at) VALUES('new-reference','image','images/shared.png','now');").unwrap();
        crate::clipboard_usage::set_asset_size(&conn,"images/shared.png",15).unwrap();
        assert!(!reclaim_image(&mut conn,&root,"images/shared.png").unwrap());
        assert!(root.join("images/shared.png").exists());
        conn.execute("DELETE FROM clipboard_records",[]).unwrap();
        assert!(reclaim_image(&mut conn,&root,"images/shared.png").unwrap());
        assert!(!root.join("images/shared.png").exists());assert!(!root.join("images/thumbs/shared.png").exists());
        // A directory cannot be unlinked as a file. Keep its zero-reference
        // ledger entry for retry rather than claiming reclamation succeeded.
        std::fs::create_dir(root.join("images/blocked.png")).unwrap();
        crate::clipboard_usage::set_asset_size(&conn,"images/blocked.png",20).unwrap();
        assert!(!reclaim_image(&mut conn,&root,"images/blocked.png").unwrap());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM clipboard_assets",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        std::fs::write(root.join("data.db"),b"keep").unwrap();
        crate::clipboard_usage::set_asset_size(&conn,"data.db",4).unwrap();
        assert!(reclaim_image(&mut conn,&root,"data.db").unwrap());assert!(root.join("data.db").exists());
        std::fs::remove_file(root.join("data.db")).unwrap();std::fs::remove_dir(root.join("images/blocked.png")).unwrap();
        std::fs::remove_dir(root.join("images/thumbs")).unwrap();std::fs::remove_dir(root.join("images")).unwrap();std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn clipboard_retention_batches_do_not_materialize_text_bodies() {
        let mut conn=Connection::open_in_memory().unwrap();initialize_connection(&mut conn).unwrap();
        conn.execute_batch("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<205)
          INSERT INTO clipboard_records(id,type,content,created_at) SELECT printf('%03d',x),'text',CAST(zeroblob(4096) AS TEXT),'2000-01-01' FROM n;").unwrap();
        let first=prune_expired_records(&conn,30).unwrap();assert_eq!(first.len(),100);assert!(first.iter().all(|r|r.2.is_empty()));
        assert_eq!(prune_expired_records(&conn,30).unwrap().len(),100);
        assert_eq!(prune_expired_records(&conn,30).unwrap().len(),5);
        assert_eq!(crate::clipboard_usage::get(&conn).unwrap().bytes,0);
    }

    #[test]
    fn assets_follow_open_database_even_when_forwarding_destination_is_missing() {
        let root = std::env::temp_dir().join(format!("copy-creator-route-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let missing = root.join("missing-destination");
        let file = root.join("data.db");
        let conn = Connection::open(&file).unwrap();
        conn.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)").unwrap();
        conn.execute("INSERT INTO settings VALUES('storage_path',?1)", [missing.to_str().unwrap()]).unwrap();
        assert_eq!(connection_storage_dir(&conn), Some(root.clone()));
        assert!(!missing.exists());
        assert_eq!(connection_storage_dir(&Connection::open_in_memory().unwrap()), None);
        drop(conn);
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn permanent_unlink_failures_do_not_starve_later_assets() {
        let root = std::env::temp_dir().join(format!("copy-creator-retry-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("images")).unwrap();
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_connection(&mut conn).unwrap();
        for index in 0..205 {
            let path = format!("images/{index:03}.png");
            if index < 100 { std::fs::create_dir(root.join(&path)).unwrap(); }
            else { std::fs::write(root.join(&path), b"synthetic").unwrap(); }
            crate::clipboard_usage::set_asset_size(&conn, &path, 9).unwrap();
        }
        let mut cursor = None;
        let mut removed = 0;
        for _ in 0..3 {
            let page = crate::clipboard_usage::reclaim_candidates(&conn, cursor.as_deref()).unwrap();
            assert!(page.len() <= 100);
            cursor = page.last().cloned();
            for path in page { removed += usize::from(reclaim_image(&mut conn, &root, &path).unwrap()); }
        }
        assert_eq!(removed, 105);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM clipboard_assets", [], |row| row.get::<_, i64>(0)).unwrap(), 100);
        for index in 0..100 { std::fs::remove_dir(root.join(format!("images/{index:03}.png"))).unwrap(); }
        std::fs::remove_dir(root.join("images")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    #[ignore = "Release-only synthetic accounting comparison; run explicitly"]
    fn clipboard_accounting_release_benchmark() {
        assert!(!cfg!(debug_assertions),"run with cargo test --release");
        let root=std::env::temp_dir().join(format!("copy-creator-benchmark-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("images/thumbs")).unwrap();
        let mut conn=Connection::open_in_memory().unwrap();initialize_connection(&mut conn).unwrap();
        {
            let tx=conn.transaction().unwrap();
            let body="x".repeat(4096);
            for index in 0..5000 {tx.execute("INSERT INTO clipboard_records(id,type,content,created_at) VALUES(?1,'text',?2,'2026-10-07')",params![format!("text-{index}"),body]).unwrap();}
            for index in 0..32 {
                let path=format!("images/{index}.png");
                std::fs::write(root.join(&path),[0u8;64]).unwrap();std::fs::write(root.join(format!("images/thumbs/{index}.png")),[0u8;16]).unwrap();
                crate::clipboard_usage::set_asset_size(&tx,&path,80).unwrap();
                tx.execute("INSERT INTO clipboard_records(id,type,content,created_at) VALUES(?1,'image',?2,'2026-10-07')",params![format!("image-{index}"),path]).unwrap();
            }
            tx.commit().unwrap();
        }
        let expected=usage_bytes(&load_usage_records(&conn).unwrap(),&root).0;
        assert_eq!(crate::clipboard_usage::get(&conn).unwrap().bytes,expected);
        fn measure(mut operation:impl FnMut()) -> serde_json::Value {
            for _ in 0..5 {operation();}
            let mut samples=Vec::new();
            for _ in 0..60 {let begin=std::time::Instant::now();operation();samples.push(begin.elapsed().as_secs_f64()*1000.0);}
            samples.sort_by(f64::total_cmp);
            serde_json::json!({"p50_ms":samples[29],"p95_ms":samples[56],"samples":samples.len()})
        }
        let old=measure(||{std::hint::black_box(usage_bytes(&load_usage_records(&conn).unwrap(),&root));});
        let incremental=measure(||{std::hint::black_box(crate::clipboard_usage::get(&conn).unwrap());});
        println!("BENCHMARK_JSON {}",serde_json::json!({"kind":"clipboard-accounting","profile":"release","fixture":{"text_records":5000,"text_bytes_each":4096,"unique_images":32,"image_and_thumb_bytes_each":80},"expected_usage_bytes":expected,"old_full_scan_and_metadata":old,"incremental":incremental,"scope":"warm in-memory SQLite accounting only; excludes IPC, capture, filesystem allocation and application latency"}));
        drop(conn);
        for index in 0..32 {std::fs::remove_file(root.join(format!("images/{index}.png"))).unwrap();std::fs::remove_file(root.join(format!("images/thumbs/{index}.png"))).unwrap();}
        std::fs::remove_dir(root.join("images/thumbs")).unwrap();std::fs::remove_dir(root.join("images")).unwrap();std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn clipboard_cursor_ties_and_new_inserts_do_not_shift_later_pages() {
        let mut conn=Connection::open_in_memory().unwrap(); initialize_connection(&mut conn).unwrap();
        for id in ["a","b","c","d"] {
            conn.execute("INSERT INTO clipboard_records(id,type,content,created_at) VALUES(?1,'text',?1,'2026-10-07T00:00:00Z')",[id]).unwrap();
        }
        let first=query_clipboard_records(&conn,None,Some(2),None,None,None).unwrap();
        assert_eq!(first.iter().map(|r|r["id"].as_str().unwrap()).collect::<Vec<_>>(),vec!["d","c"]);
        conn.execute("INSERT INTO clipboard_records(id,type,content,created_at) VALUES('new','text','new','2026-10-08T00:00:00Z')",[]).unwrap();
        let next=query_clipboard_records(&conn,None,Some(2),Some(100),None,Some(ClipboardCursor{created_at:first[1]["created_at"].as_str().unwrap().into(),id:"c".into()})).unwrap();
        assert_eq!(next.iter().map(|r|r["id"].as_str().unwrap()).collect::<Vec<_>>(),vec!["b","a"]);
    }

    #[test]
    fn clipboard_page_search_is_literal_and_enriches_only_returned_protected_keys() {
        let mut conn=Connection::open_in_memory().unwrap(); initialize_connection(&mut conn).unwrap();
        conn.execute("INSERT INTO clipboard_records(id,type,content,created_at,favorite_note) VALUES('literal','text','plain','now','100%_done')",[]).unwrap();
        conn.execute("INSERT INTO clipboard_records(id,type,content,created_at,favorite_note) VALUES('other','text','plain','now','100XXdone')",[]).unwrap();
        let result=query_clipboard_records(&conn,Some("%_".into()),Some(10),None,None,None).unwrap();
        assert_eq!(result.len(),1); assert_eq!(result[0]["id"],"literal");
        let protected=crate::secrets::protect("sk-fixture-example-1234567890").unwrap();
        conn.execute("INSERT INTO clipboard_records(id,type,content,created_at) VALUES('key','text',?1,'later')",[protected]).unwrap();
        conn.execute("INSERT INTO api_key_labels(record_id,key_preview,service,created_at,updated_at) VALUES('key','preview','fixture','now','now')",[]).unwrap();
        let keys=query_clipboard_records(&conn,None,Some(10),None,Some("apikey".into()),None).unwrap();
        assert_eq!(keys.len(),1); assert_eq!(keys[0]["label"]["service"],"fixture");
        assert!(!keys[0]["content"].as_str().unwrap().contains("1234567890"));
    }

    #[test]
    fn shared_connection_migration_is_idempotent_and_preserves_existing_target_data() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_connection(&mut conn).unwrap();
        conn.execute("INSERT INTO api_key_labels(record_id,key_preview,service,created_at,updated_at) VALUES ('kept','preview','service','now','now')", []).unwrap();
        conn.execute("UPDATE settings SET value='dark' WHERE key='theme'", []).unwrap();
        initialize_connection(&mut conn).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version",[],|r| r.get::<_,i64>(0)).unwrap(),6);
        assert_eq!(conn.query_row("PRAGMA synchronous",[],|r| r.get::<_,i64>(0)).unwrap(),2);
        assert_eq!(conn.query_row("PRAGMA foreign_keys",[],|r| r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(conn.query_row("PRAGMA cache_size",[],|r| r.get::<_,i64>(0)).unwrap(),-8000);
        assert_eq!(conn.query_row("PRAGMA busy_timeout",[],|r| r.get::<_,i64>(0)).unwrap(),5000);
        assert_eq!(conn.query_row("SELECT value FROM settings WHERE key='theme'",[],|r| r.get::<_,String>(0)).unwrap(),"dark");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM api_key_labels",[],|r| r.get::<_,i64>(0)).unwrap(),1);
        for table in ["notes","note_refs","vault_entries","vault_config","clipboard_records","translation_history","phrases"] {
            assert!(conn.prepare(&format!("SELECT * FROM {table} LIMIT 0")).is_ok());
        }
    }

    #[test]
    fn failed_schema_step_rolls_back_tables_and_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        // A malformed legacy table forces the first migration to fail after creating tables.
        conn.execute_batch("CREATE TABLE clipboard_records(id TEXT PRIMARY KEY);").unwrap();
        assert!(initialize_connection(&mut conn).is_err());
        assert_eq!(conn.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert!(!conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='settings')",[],|r|r.get::<_,bool>(0)).unwrap());
        assert!(table_has_column(&conn,"clipboard_records","id").unwrap());
    }

    #[test]
    fn future_schema_is_rejected_without_migrating_or_removing_data() {
        let mut conn=Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA user_version=99; CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES ('preserved');").unwrap();
        assert!(initialize_connection(&mut conn).is_err());
        assert_eq!(conn.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),99);
        assert_eq!(conn.query_row("SELECT value FROM future_data",[],|r|r.get::<_,String>(0)).unwrap(),"preserved");
        assert!(conn.prepare("SELECT * FROM notes").is_err());
    }

    #[test]
    fn file_connections_share_wal_configuration() {
        let path = std::env::temp_dir().join(format!("copy-creator-schema-{}.db", uuid::Uuid::new_v4()));
        for _ in 0..2 {
            let mut conn = Connection::open(&path).unwrap();
            initialize_connection(&mut conn).unwrap();
            assert_eq!(conn.query_row("PRAGMA journal_mode",[],|r|r.get::<_,String>(0)).unwrap(),"wal");
            assert_eq!(conn.query_row("PRAGMA synchronous",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn notes_step_failure_keeps_the_previous_schema_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_connection(&mut conn).unwrap();
        conn.execute_batch("DROP TABLE note_refs; DROP TABLE notes; CREATE TABLE notes(id TEXT PRIMARY KEY); PRAGMA user_version=1;").unwrap();
        assert!(initialize_connection(&mut conn).is_err());
        assert_eq!(conn.query_row("PRAGMA user_version",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert!(conn.prepare("SELECT * FROM note_refs").is_err());
        assert!(conn.prepare("SELECT * FROM settings").is_ok());
    }

    #[test]
    fn clipboard_retention_does_not_remove_independent_notes_or_refs() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_connection(&mut conn).unwrap();
        conn.execute_batch("INSERT INTO clipboard_records(id,type,content,created_at) VALUES ('expired','text','original','2000-01-01');
            INSERT INTO notes(id,title,body,summary,char_count,byte_count,created_at_ms,updated_at_ms,revision,creation_mutation_id,creation_hash,last_mutation_id,last_mutation_hash)
            VALUES ('independent','','snapshot','snapshot',8,8,1,1,1,'creation','hash','creation','hash');
            INSERT INTO note_refs VALUES ('ref','independent','url','https://example.com','reference',0);").unwrap();
        assert_eq!(prune_expired_records(&conn,30).unwrap().len(),1);
        assert_eq!(conn.query_row("SELECT body FROM notes WHERE id='independent'",[],|r|r.get::<_,String>(0)).unwrap(),"snapshot");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM note_refs",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn limit_save_requires_current_confirmation_and_preserves_protected_records() {
        let mut conn = cleanup_test_connection();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES ('max_history_items', '2000');").unwrap();
        for (id, favorite, key) in [("favorite", 1, 0), ("key", 0, 1), ("old", 0, 0), ("new", 0, 0)] {
            conn.execute("INSERT INTO clipboard_records (id, type, content, is_favorite, user_api_key, created_at) VALUES (?1, 'text', ?1, ?2, ?3, ?1)", params![id, favorite, key]).unwrap();
        }
        let base = Path::new("unused-test-storage");
        let proposal = persist_clipboard_limit(&mut conn, base, "max_history_items", "2", None).unwrap();
        assert!(!proposal.0);
        assert_eq!(proposal.1.len(), 2);
        assert_eq!(setting_u64(&conn, "max_history_items", 0), 2000);
        assert_eq!(load_usage_records(&conn).unwrap().len(), 4);
        conn.execute("INSERT INTO clipboard_records VALUES ('added', 'text', 'added', 0, 'added', 0)", []).unwrap();
        let changed = persist_clipboard_limit(&mut conn, base, "max_history_items", "2", Some(2)).unwrap();
        assert!(!changed.0);
        assert_eq!(changed.1.len(), 3);
        assert_eq!(setting_u64(&conn, "max_history_items", 0), 2000);
        assert_eq!(load_usage_records(&conn).unwrap().len(), 5);
        conn.execute_batch("CREATE TRIGGER fail_cleanup BEFORE DELETE ON clipboard_records WHEN OLD.id = 'new' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;").unwrap();
        assert!(persist_clipboard_limit(&mut conn, base, "max_history_items", "2", Some(3)).is_err());
        assert_eq!(setting_u64(&conn, "max_history_items", 0), 2000);
        assert_eq!(load_usage_records(&conn).unwrap().len(), 5);
        conn.execute_batch("DROP TRIGGER fail_cleanup;").unwrap();
        let committed = persist_clipboard_limit(&mut conn, base, "max_history_items", "2", Some(3)).unwrap();
        assert!(committed.0);
        assert_eq!(setting_u64(&conn, "max_history_items", 0), 2);
        let remaining = load_usage_records(&conn).unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().all(|record| record.is_favorite || record.protected_key));
    }

    #[test]
    fn limit_cleanup_keeps_shared_images_until_last_reference() {
        let record = |id: &str, favorite| UsageRecord { id: id.into(), record_type: "image".into(), content: "shared.png".into(), is_favorite: favorite, protected_key: false };
        let records = [record("old", false), record("new", false), record("favorite", true)];
        let (deleted, images) = plan_limit_cleanup(&records, Path::new("unused-test-storage"), 1, u64::MAX);
        assert_eq!(deleted, ["old", "new"]);
        assert!(images.is_empty());
        let (deleted, images) = plan_limit_cleanup(&records[..2], Path::new("unused-test-storage"), 0, u64::MAX);
        assert_eq!(deleted, ["old", "new"]);
        assert_eq!(images, ["shared.png"]);
    }

    fn cleanup_test_connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clipboard_records (
                id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
                is_favorite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
                user_api_key INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE api_key_labels (record_id TEXT PRIMARY KEY);",
        ).unwrap();
        crate::clipboard_usage::init_schema(&conn).unwrap();
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
        let mut ids: Vec<_> = cleanup_candidates(&conn, "dedupe", None, None).unwrap()
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
        let ids: Vec<_> = cleanup_candidates(&conn, "older_than", Some("today"), None).unwrap()
            .into_iter().map(|record| record.id).collect();
        assert_eq!(ids, ["old"]);
    }

    #[test]
    fn ambiguous_sk_prefix_does_not_assign_a_provider() {
        assert_eq!(guess_service("sk-example-shared-prefix"), None);
        assert_eq!(guess_service("AIza-example"), Some("Gemini"));
    }

    fn bulk_cleanup_fixture() -> Connection {
        let conn = cleanup_test_connection();
        conn.execute_batch("CREATE TABLE vault_entries (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);").unwrap();
        let cutoff = cleanup_cutoff("today").unwrap();
        let old = (cutoff - chrono::Duration::seconds(1)).to_rfc3339();
        let recent = cutoff.to_rfc3339();
        for (id, kind, content, favorite, user_key, created_at) in [
            ("text", "text", "ordinary text", 0, 0, old.as_str()),
            ("image", "image", "image.png", 0, 0, old.as_str()),
            ("link", "link", "https://example.test", 0, 0, old.as_str()),
            ("explorer", "explorer", "C:\\folder", 0, 0, old.as_str()),
            ("file", "file", "C:\\file.txt", 0, 0, old.as_str()),
            ("detected-key", "text", "sk-example-clipboard-secret", 0, 0, old.as_str()),
            ("link-key", "link", "sk-example-clipboard-secret", 0, 0, old.as_str()),
            ("manual-key", "text", "custom credential", 0, 1, old.as_str()),
            ("encrypted-key", "text", "dpapi:v1:opaque", 0, 0, old.as_str()),
            ("labeled-key", "text", "custom labeled credential", 0, 0, old.as_str()),
            ("favorite-key", "text", "sk-example-favorite-secret", 1, 1, old.as_str()),
            ("favorite", "text", "keep favorite", 1, 0, old.as_str()),
            ("recent", "text", "keep recent", 0, 0, recent.as_str()),
        ] {
            conn.execute("INSERT INTO clipboard_records (id, type, content, is_favorite, user_api_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, kind, content, favorite, user_key, created_at]).unwrap();
        }
        conn.execute("INSERT INTO api_key_labels VALUES ('labeled-key')", []).unwrap();
        conn.execute("INSERT INTO vault_entries VALUES ('text', ?1), ('recent-vault', ?2)", params![old, recent]).unwrap();
        conn
    }

    #[test]
    fn bulk_delete_defaults_preserve_all_key_variants_and_vault() {
        let mut conn = bulk_cleanup_fixture();
        let preview = cleanup_candidates(&conn, "older_than", Some("today"), None).unwrap();
        let deleted = delete_cleanup_candidates(&mut conn, "older_than", Some("today"), None).unwrap();
        assert_eq!(preview.len(), 5);
        assert_eq!(deleted.len(), preview.len());
        let remaining: i64 = conn.query_row("SELECT COUNT(*) FROM clipboard_records", [], |row| row.get(0)).unwrap();
        let vault: i64 = conn.query_row("SELECT COUNT(*) FROM vault_entries", [], |row| row.get(0)).unwrap();
        assert_eq!(remaining, 8);
        assert_eq!(vault, 2);
        assert!(deleted.iter().all(|record| DEFAULT_CLEANUP_CATEGORIES.contains(&record.record_type.as_str())));
    }

    #[test]
    fn bulk_delete_text_selection_excludes_keys_and_other_types() {
        let mut conn = bulk_cleanup_fixture();
        let categories = vec!["text".to_string()];
        let deleted = delete_cleanup_candidates(&mut conn, "older_than", Some("today"), Some(&categories)).unwrap();
        assert_eq!(deleted.iter().map(|record| record.id.as_str()).collect::<Vec<_>>(), ["text"]);
    }

    #[test]
    fn bulk_delete_keys_and_vault_require_explicit_categories() {
        let mut conn = bulk_cleanup_fixture();
        let categories = vec!["apikey".to_string(), "vault".to_string()];
        let preview = cleanup_candidates(&conn, "older_than", Some("today"), Some(&categories)).unwrap();
        let deleted = delete_cleanup_candidates(&mut conn, "older_than", Some("today"), Some(&categories)).unwrap();
        assert_eq!(preview.len(), 6);
        assert_eq!(deleted.len(), preview.len());
        let remaining: i64 = conn.query_row("SELECT COUNT(*) FROM clipboard_records", [], |row| row.get(0)).unwrap();
        assert_eq!(remaining, 8);
        let vault_ids: Vec<String> = conn.prepare("SELECT id FROM vault_entries").unwrap().query_map([], |row| row.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(vault_ids, ["recent-vault"]);
        let labels: i64 = conn.query_row("SELECT COUNT(*) FROM api_key_labels", [], |row| row.get(0)).unwrap();
        assert_eq!(labels, 0);
        // IDs may coincide across the clipboard and vault; deleting one must not delete the other.
        assert!(conn.query_row("SELECT 1 FROM clipboard_records WHERE id = 'text'", [], |_| Ok(())).is_ok());
    }

    #[test]
    fn bulk_delete_empty_or_invalid_selection_does_not_delete() {
        let mut conn = bulk_cleanup_fixture();
        assert!(delete_cleanup_candidates(&mut conn, "older_than", Some("today"), Some(&[])).unwrap().is_empty());
        assert!(delete_cleanup_candidates(&mut conn, "older_than", Some("today"), Some(&["all".to_string()])).is_err());
        assert!(delete_cleanup_candidates(&mut conn, "older_than", Some("invalid"), None).is_err());
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM clipboard_records", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 13);
    }

    #[test]
    fn bulk_delete_rolls_back_clipboard_when_vault_deletion_fails() {
        let mut conn = bulk_cleanup_fixture();
        conn.execute_batch("CREATE TRIGGER fail_vault_delete BEFORE DELETE ON vault_entries BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        let categories = vec!["text".to_string(), "vault".to_string()];
        assert!(delete_cleanup_candidates(&mut conn, "older_than", Some("today"), Some(&categories)).is_err());
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM clipboard_records", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 13);
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
            storage_epoch: AtomicU64::new(1),
            asset_reclaim_cursor: Mutex::new(None),
        };

        let unreferenced = collect_unreferenced_image_contents(
            &state,
            &["images/kept.png".into(), "images/orphan.png".into()],
        )
        .unwrap();

        assert_eq!(unreferenced, vec!["images/orphan.png"]);
        assert!(state.conn.try_lock().is_ok());
    }

    #[test]
    fn automatic_cleanup_preserves_unfavorited_restored_api_keys() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE clipboard_records (id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL,
            user_api_key INTEGER DEFAULT 0, is_favorite INTEGER DEFAULT 0, created_at TEXT NOT NULL);
            CREATE TABLE api_key_labels (record_id TEXT PRIMARY KEY);
            INSERT INTO clipboard_records VALUES
            ('ordinary', 'text', 'Old ordinary text', 0, 0, '2020-01-01T00:00:00Z'),
            ('manual-key', 'text', 'Manual key', 1, 0, '2020-01-01T00:00:00Z'),
            ('protected-key', 'text', 'dpapi:v1:ciphertext', 0, 0, '2020-01-01T00:00:00Z'),
            ('labeled-key', 'text', 'Labeled key', 0, 0, '2020-01-01T00:00:00Z'),
            ('favorite', 'text', 'Favorite', 0, 1, '2020-01-01T00:00:00Z');
            INSERT INTO api_key_labels VALUES ('labeled-key');").unwrap();
        let records = load_usage_records(&conn).unwrap();
        let eligible: Vec<_> = records.iter().filter(|record| !record.is_favorite && !record.protected_key).map(|record| record.id.as_str()).collect();
        assert_eq!(eligible, ["ordinary"]);
        assert_eq!(records.iter().filter(|record| record.is_favorite).count(), 1);
        let deleted = prune_expired_records(&conn, 30).unwrap();
        assert_eq!(deleted.len(), 1); assert_eq!(deleted[0].0, "ordinary");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM clipboard_records", [], |row| row.get::<_, i64>(0)).unwrap(), 4);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM api_key_labels", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn key_preview_never_splits_a_multibyte_character() {
        // "sk-" + 6 个汉字 = 21 字节但只有 9 个字符。旧实现按字节切第 8 字节
        // 会落在 '二' 中间并 panic（这是用户可正常触发的路径：粘贴这样一个
        // 字符串就会让 get_clipboard_records 在持锁状态下 panic）。
        let content = "sk-一二三四五六";
        assert_eq!(content.len(), 21);
        assert_eq!(content.chars().count(), 9);
        assert!(is_api_key(content));
        assert_eq!(make_key_preview(content), "sk-一二三四五六");

        // 12 个字符以上才截断；中文按字符计，8 个头 + 4 个尾。
        let long = "sk-中文密钥内容重复二十次";
        assert_eq!(long.chars().count(), 14);
        assert_eq!(make_key_preview(long), "sk-中文密钥内...复二十次");
    }

    #[test]
    fn key_preview_keeps_ascii_behaviour_byte_identical() {
        // ASCII 输入下字符数等于字节数，输出必须与旧实现逐字节一致。
        assert_eq!(make_key_preview("sk-abcdefghijklmnop"), "sk-abcde...mnop");
        assert_eq!(make_key_preview("123456789012"), "12345678...9012");
        // 恰好 11 个字符不截断。
        assert_eq!(make_key_preview("12345678901"), "12345678901");
        assert_eq!(make_key_preview("short"), "short");
        assert_eq!(make_key_preview(""), "");
        // 两端空白先被 trim，与旧实现一致。
        assert_eq!(make_key_preview("  spaced  "), "spaced");
        assert_eq!(make_key_preview("AIzaSyD-1234567890abcdefghij"), "AIzaSyD-...ghij");
    }

    #[test]
    fn key_preview_handles_emoji_and_wide_characters() {
        // 每个 emoji 4 字节：旧实现会切出 2 个头字符 + 1 个尾字符。
        let emoji = "🔑".repeat(12);
        let preview = make_key_preview(&emoji);
        assert_eq!(preview, format!("{}...{}", "🔑".repeat(8), "🔑".repeat(4)));

        // 12 个字符恰好达到截断门槛。
        assert_eq!(make_key_preview(&"中".repeat(12)), format!("{}...{}", "中".repeat(8), "中".repeat(4)));
        // 11 个字符不截断。
        assert_eq!(make_key_preview(&"中".repeat(11)), "中".repeat(11));
    }
}
