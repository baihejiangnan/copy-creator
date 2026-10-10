use crate::{backup_limits, db, note_backup, secrets, vault, vault_crypto as crypto};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use zeroize::{Zeroize, Zeroizing};

const FORMAT: &str = "copy-creator-encrypted-backup";
const KDF: &str = "argon2id-v19-m65536-t3-p1";
const CIPHER: &str = "aes-256-gcm";
const AAD: &[u8] = b"copy-creator/user-backup/v2/argon2id-v19-m65536-t3-p1/aes-256-gcm";
const AAD_V4: &[u8] = b"copy-creator/user-backup/v4/argon2id-v19-m65536-t3-p1/aes-256-gcm";
const AAD_V3: &[u8] = b"copy-creator/user-backup/v3/argon2id-v19-m65536-t3-p1/aes-256-gcm";
const MAX_FILE: usize = 100 * 1024 * 1024;
const MAX_PAYLOAD: usize = 74 * 1024 * 1024;
const SECRET_SETTINGS: &[&str] = &["ai_api_key", "google_api_key", "baidu_secret"];
const IMPORT_LIFETIME: Duration = Duration::from_secs(300);
fn accept_worker() -> Result<tokio::sync::OwnedSemaphorePermit,String> {
    static WORKERS:OnceLock<Arc<tokio::sync::Semaphore>>=OnceLock::new();
    WORKERS.get_or_init(||Arc::new(tokio::sync::Semaphore::new(2))).clone().try_acquire_owned().map_err(|_| "backup.busy".into())
}

#[derive(Default)]
pub struct BackupState {
    pending: Mutex<Option<PendingImport>>,
}
struct PendingImport {
    token: String,
    path: PathBuf,
    bytes: Arc<Zeroizing<Vec<u8>>>,
    selected_at: Instant,
}

#[derive(Deserialize)]
struct Header {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    version: u32,
}

#[derive(Serialize, Deserialize)]
struct EncryptedBackup<'a> {
    format: String,
    version: u32,
    kdf: String,
    cipher: String,
    salt: String,
    #[serde(borrow)]
    payload: std::borrow::Cow<'a, str>,
}

#[derive(Serialize, Deserialize)]
struct BackupBundle {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    exported_at: String,
    settings: HashMap<String, String>,
    #[serde(default)]
    favorites: Vec<BackupRecord>,
    #[serde(default)]
    vault: Option<vault::VaultBackup>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    notes: Vec<note_backup::BackupNote>,
    #[serde(default, skip_serializing_if="Vec::is_empty")]
    note_groups: Vec<crate::suiji::NoteGroup>,
}

fn default_favorite() -> bool {
    true
}
#[derive(Serialize, Deserialize)]
struct BackupRecord {
    id: String,
    #[serde(rename = "type")]
    record_type: String,
    content: String,
    #[serde(default)]
    source_app: String,
    created_at: String,
    #[serde(default)]
    user_api_key: bool,
    #[serde(default = "default_favorite")]
    is_favorite: bool,
    #[serde(default)]
    favorite_note: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    image_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_label: Option<ApiLabel>,
}

#[derive(Serialize, Deserialize)]
struct ApiLabel {
    service: String,
    #[serde(default)]
    api_base: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    is_expired: bool,
    created_at: String,
    updated_at: String,
}

// Keys exist in plaintext only in native memory while building or reading an encrypted backup.
impl Drop for BackupBundle {
    fn drop(&mut self) {
        for value in self.settings.values_mut() {
            value.zeroize();
        }
        for record in &mut self.favorites {
            record.content.zeroize();
            record.favorite_note.zeroize();
            record.source_app.zeroize();
            if let Some(image) = &mut record.image_base64 {
                image.zeroize();
            }
            if let Some(label) = &mut record.api_label {
                label.service.zeroize();
                label.api_base.zeroize();
                label.note.zeroize();
            }
        }
        for note in &mut self.notes {
            note.title.zeroize(); note.body.zeroize();
            for reference in &mut note.refs { reference.target.zeroize(); reference.display_name.zeroize(); }
            if let Some(source) = &mut note.source { source.source_app.zeroize(); }
        }
    }
}

fn file_is_encrypted(bytes: &[u8]) -> Result<bool, String> {
    let header: Header = serde_json::from_slice(bytes).map_err(|_| "backup.invalidFile")?;
    match header.format.as_deref() {
        Some(FORMAT) if matches!(header.version, 2 | 3 | 4) => Ok(true),
        None if matches!(header.version, 0 | 1) => Ok(false),
        _ => Err("backup.unsupportedVersion".into()),
    }
}

fn validate_backup_password(password: &str) -> Result<(), String> {
    if password.chars().count() < 12 || password.len() > 1024 || password.trim().is_empty() {
        return Err("backup.passwordLength".into());
    }
    Ok(())
}

#[cfg(test)]
fn encode_bundle(bundle: &BackupBundle, password: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    validate_backup_password(password)?;
    if !matches!(bundle.version,3|4) && !(bundle.version == 2 && bundle.notes.is_empty()) { return Err("backup.unsupportedVersion".into()); }
    let plaintext = backup_limits::encode_json(bundle, MAX_PAYLOAD, false)?;
    encode_plaintext(bundle.version, plaintext, password)
}

fn encode_bundle_owned(bundle: BackupBundle, password: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    validate_backup_password(password)?;
    if !matches!(bundle.version,3|4) && !(bundle.version == 2 && bundle.notes.is_empty()) { return Err("backup.unsupportedVersion".into()); }
    let version = bundle.version;
    let plaintext = backup_limits::encode_json(&bundle, MAX_PAYLOAD, false)?;
    // Release bodies/images before KDF, base64 and outer JSON allocations.
    drop(bundle);
    encode_plaintext(version, plaintext, password)
}

fn encode_plaintext(version: u32, plaintext: Zeroizing<Vec<u8>>, password: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    let aad = if version == 4 { AAD_V4 } else if version == 3 { AAD_V3 } else { AAD };
    let salt = crypto::random_bytes::<16>()?;
    let key = crypto::derive_key(password, &salt)?;
    let envelope = EncryptedBackup {
        format: FORMAT.into(),
        version,
        kdf: KDF.into(),
        cipher: CIPHER.into(),
        salt: STANDARD.encode(salt),
        payload: crypto::encrypt_bound_owned(&key, aad, plaintext)?.into(),
    };
    backup_limits::encode_json(&envelope, MAX_FILE, true)
}

fn decode_bundle(bytes: &[u8], password: &str) -> Result<(BackupBundle, bool), String> {
    if bytes.len() > MAX_FILE {
        return Err("backup.fileTooLarge".into());
    }
    let encrypted = file_is_encrypted(bytes)?;
    let mut bundle = if encrypted {
        if password.is_empty() {
            return Err("backup.passwordRequired".into());
        }
        if password.len() > 1024 {
            return Err("backup.passwordLength".into());
        }
        let envelope: EncryptedBackup =
            serde_json::from_slice(bytes).map_err(|_| "backup.invalidFile")?;
        if envelope.kdf != KDF || envelope.cipher != CIPHER {
            return Err("backup.unsupportedVersion".into());
        }
        if envelope.payload.len()>3+4*(MAX_PAYLOAD+28).div_ceil(3) { return Err("backup.fileTooLarge".into()); }
        let salt = STANDARD
            .decode(&envelope.salt)
            .map_err(|_| "backup.invalidFile")?;
        if salt.len() != 16 {
            return Err("backup.invalidFile".into());
        }
        let key = crypto::derive_key(password, &salt)?;
        let aad = if envelope.version == 4 { AAD_V4 } else if envelope.version == 3 { AAD_V3 } else { AAD };
        let plaintext = crypto::decrypt_bound(&key, aad, &envelope.payload)
            .map_err(|_| "backup.wrongPassword")?;
        if plaintext.len() > MAX_PAYLOAD {
            return Err("backup.fileTooLarge".into());
        }
        let bundle: BackupBundle =
            serde_json::from_slice(&plaintext).map_err(|_| "backup.invalidFile")?;
        if bundle.version != envelope.version || (bundle.version == 2 && !bundle.notes.is_empty()) {
            return Err("backup.unsupportedVersion".into());
        }
        bundle
    } else {
        let bundle: BackupBundle =
            serde_json::from_slice(bytes).map_err(|_| "backup.invalidFile")?;
        // Legacy JSON never contained a vault. Ignore injected extension fields and keep local secrets.
        if bundle.vault.is_some() || !bundle.notes.is_empty() {
            return Err("backup.invalidFile".into());
        }
        bundle
    };
    if !encrypted {
        bundle
            .settings
            .retain(|key, _| !secrets::is_setting_secret(key));
        for record in &mut bundle.favorites {
            record.is_favorite = true;
            record.api_label = None;
        }
    }
    validate_bundle(&bundle)?;
    Ok((bundle, encrypted))
}

fn record_is_key(record: &BackupRecord) -> bool {
    record.user_api_key
        || record.api_label.is_some()
        || secrets::is_protected(&record.content)
        || db::is_api_key(&record.content)
}

fn validate_bundle(bundle: &BackupBundle) -> Result<(), String> {
    crate::suiji::validate_groups(&bundle.note_groups)?;
    if bundle.version < 4 && (!bundle.note_groups.is_empty() || bundle.notes.iter().any(|note|note.group_id.is_some() || note.starred)) { return Err("backup.unsupportedVersion".into()); }
    note_backup::validate(&bundle.notes)?;
    if bundle.settings.len() > 200 || bundle.favorites.len() > 100_000 {
        return Err("backup.invalidFile".into());
    }
    for (key, value) in &bundle.settings {
        if key.len() > 128 || value.len() > 4096 {
            return Err("backup.invalidFile".into());
        }
    }
    let mut seen = HashSet::new();
    for record in &bundle.favorites {
        if record.id.is_empty()
            || record.id.len() > 128
            || !seen.insert(&record.id)
            || !matches!(
                record.record_type.as_str(),
                "text" | "image" | "link" | "explorer" | "file"
            )
            || record.content.len() > 10 * 1024 * 1024
            || record.source_app.len() > 4096
            || record.created_at.len() > 64
            || record.favorite_note.chars().count() > db::FAVORITE_NOTE_MAX_CHARS
            || (record_is_key(record) && !matches!(record.record_type.as_str(), "text" | "link"))
        {
            return Err("backup.invalidFile".into());
        }
        if let Some(label) = &record.api_label {
            if label.service.trim().is_empty()
                || label.service.chars().count() > 80
                || label.note.chars().count() > 100
                || label.api_base.len() > 2048
                || label.created_at.len() > 64
                || label.updated_at.len() > 64
            {
                return Err("backup.invalidFile".into());
            }
            if !label.api_base.is_empty() {
                let url = reqwest::Url::parse(&label.api_base).map_err(|_| "backup.invalidFile")?;
                if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
                    return Err("backup.invalidFile".into());
                }
            }
        }
    }
    if let Some(vault) = &bundle.vault {
        vault::validate_backup(vault)?;
    }
    Ok(())
}

fn export_snapshot(conn: &Connection) -> Result<BackupBundle, String> {
    preflight_snapshot(conn)?;
    let mut budget = backup_limits::Budget::new(MAX_PAYLOAD);
    let mut bundle = BackupBundle {
        version: 4,
        exported_at: chrono::Utc::now().to_rfc3339(),
        settings: HashMap::new(),
        favorites: Vec::new(),
        vault: None,
        notes: Vec::new(),
        note_groups: Vec::new(),
    };
    budget.include(&bundle)?;
    bundle.vault = vault::snapshot_backup(conn)?;
    if let Some(vault) = &bundle.vault { budget.include(vault)?; }
    bundle.note_groups=crate::suiji::groups(conn).map_err(|_|"backup.databaseFailed")?;
    for group in &bundle.note_groups {budget.include(group)?;}
    bundle.notes = note_backup::snapshot(conn,&mut budget)?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings")
        .map_err(|_| "backup.databaseFailed")?;
    for row in stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|_| "backup.databaseFailed")?
    {
        let (key, mut value) = row.map_err(|_| "backup.databaseFailed")?;
        if db::EXPORT_SETTING_KEYS.contains(&key.as_str()) {
            budget.include(&(&key,&value))?;
            bundle.settings.insert(key, value);
        } else if secrets::is_setting_secret(&key) && !value.is_empty() {
            let plaintext = secrets::reveal(&value).map_err(|_| "backup.secretUnavailable")?;
            value.zeroize();
            budget.include(&(&key,&plaintext))?;
            bundle.settings.insert(key, plaintext);
        }
    }
    let mut stmt = conn.prepare("SELECT r.id, r.type, r.content, r.source_app, r.created_at, r.user_api_key, r.is_favorite, r.favorite_note,
        l.service, l.api_base, l.note, l.is_expired, l.created_at, l.updated_at
        FROM clipboard_records r LEFT JOIN api_key_labels l ON l.record_id = r.id
        WHERE r.is_favorite = 1 OR r.user_api_key = 1 OR l.record_id IS NOT NULL OR (r.type IN ('text', 'link') AND
        (r.content LIKE 'dpapi:v1:%' OR r.content LIKE 'sk-%' OR r.content LIKE 'AIza%' OR r.content LIKE 'glpat-%' OR r.content LIKE 'ghp_%' OR r.content LIKE 'xai-%')) ORDER BY r.created_at DESC")
        .map_err(|_| "backup.databaseFailed")?;
    let rows = stmt
        .query_map([], |row| {
            let service: Option<String> = row.get(8)?;
            Ok(BackupRecord {
                id: row.get(0)?,
                record_type: row.get(1)?,
                content: row.get(2)?,
                source_app: row.get(3)?,
                created_at: row.get(4)?,
                user_api_key: row.get::<_, i64>(5)? != 0,
                is_favorite: row.get::<_, i64>(6)? != 0,
                favorite_note: row.get(7)?,
                image_base64: None,
                api_label: if let Some(service) = service {
                    Some(ApiLabel {
                        service,
                        api_base: row.get(9)?,
                        note: row.get(10)?,
                        is_expired: row.get::<_, i64>(11)? != 0,
                        created_at: row.get(12)?,
                        updated_at: row.get(13)?,
                    })
                } else {
                    None
                },
            })
        })
        .map_err(|_| "backup.databaseFailed")?;
    for row in rows {
        let mut record = row.map_err(|_| "backup.databaseFailed")?;
        if record_is_key(&record) {
            let plaintext =
                secrets::reveal(&record.content).map_err(|_| "backup.secretUnavailable")?;
            record.content.zeroize();
            record.content = plaintext;
            record.user_api_key = true;
        } else if !record.is_favorite {
            continue;
        }
        budget.include(&record)?;
        bundle.favorites.push(record);
    }
    validate_bundle(&bundle)?;
    Ok(bundle)
}
// Query lengths/counts before loading bodies/ciphertext. This is a lower-bound
// admission check, followed by cumulative JSON accounting and exact writers.
fn preflight_snapshot(conn: &Connection) -> Result<(), String> {
    let predicate="r.is_favorite=1 OR r.user_api_key=1 OR l.record_id IS NOT NULL OR (r.type IN ('text','link') AND (r.content LIKE 'dpapi:v1:%' OR r.content LIKE 'sk-%' OR r.content LIKE 'AIza%' OR r.content LIKE 'glpat-%' OR r.content LIKE 'ghp_%' OR r.content LIKE 'xai-%'))";
    let queries=[
        format!("SELECT COALESCE(SUM(CASE WHEN r.content LIKE 'dpapi:v1:%' THEN 0 ELSE length(CAST(r.content AS BLOB)) END + length(CAST(r.favorite_note AS BLOB)) + length(CAST(r.source_app AS BLOB))),0),count(*) FROM clipboard_records r LEFT JOIN api_key_labels l ON l.record_id=r.id WHERE {predicate}"),
        "SELECT COALESCE(SUM(length(CAST(title AS BLOB))+length(CAST(body AS BLOB))+COALESCE(length(CAST(source_json AS BLOB)),0)),0),count(*) FROM notes WHERE deleted_at_ms IS NULL".into(),
        "SELECT COALESCE(SUM(length(CAST(target AS BLOB))+length(CAST(display_name AS BLOB))),0),count(*) FROM note_refs WHERE note_id IN (SELECT id FROM notes WHERE deleted_at_ms IS NULL)".into(),
        "SELECT COALESCE(SUM(length(CAST(encrypted_data AS BLOB))),0),count(*) FROM vault_entries".into(),
    ];
    let mut bytes=0u64;
    for (index,query) in queries.iter().enumerate() {
        let (size,count):(i64,i64)=conn.query_row(query,[],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|_| "backup.databaseFailed")?;
        if size<0 || count<0 || count>if index==2 {2_000_000} else {100_000} {return Err("backup.fileTooLarge".into());}
        bytes=bytes.saturating_add(size as u64);
        if bytes>MAX_PAYLOAD as u64 {return Err("backup.fileTooLarge".into());}
    }
    let invalid:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM notes WHERE deleted_at_ms IS NULL AND (length(CAST(body AS BLOB))>262144 OR length(title)>128) AND COALESCE(json_extract(source_json,'$.kind'),'')<>'phrase')",[],|r|r.get(0)).map_err(|_| "backup.databaseFailed")?;
    if invalid {return Err("backup.invalidFile".into());}
    let invalid_records:bool=conn.query_row(&format!("SELECT EXISTS(SELECT 1 FROM clipboard_records r LEFT JOIN api_key_labels l ON l.record_id=r.id WHERE ({predicate}) AND (length(CAST(r.content AS BLOB))>16777216 OR length(CAST(r.source_app AS BLOB))>4096 OR length(r.favorite_note)>{} OR length(l.service)>80 OR length(l.note)>100 OR length(CAST(l.api_base AS BLOB))>2048))",db::FAVORITE_NOTE_MAX_CHARS),[],|r|r.get(0)).map_err(|_| "backup.databaseFailed")?;
    let invalid_refs:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM note_refs WHERE note_id IN(SELECT id FROM notes WHERE deleted_at_ms IS NULL) AND (length(CAST(target AS BLOB))>32768 OR length(display_name)>512))",[],|r|r.get(0)).map_err(|_| "backup.databaseFailed")?;
    let invalid_vault:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM vault_entries WHERE length(encrypted_data)>350000) OR EXISTS(SELECT 1 FROM vault_config WHERE length(salt)>64 OR length(verifier)>256)",[],|r|r.get(0)).map_err(|_| "backup.databaseFailed")?;
    if invalid_records || invalid_refs || invalid_vault {return Err("backup.invalidFile".into());}
    let mut stmt=conn.prepare("SELECT key,length(CAST(value AS BLOB)) FROM settings WHERE length(key)<=128").map_err(|_| "backup.databaseFailed")?;
    let mut rows=stmt.query([]).map_err(|_| "backup.databaseFailed")?;
    while let Some(row)=rows.next().map_err(|_| "backup.databaseFailed")? {
        let key:String=row.get(0).map_err(|_| "backup.databaseFailed")?;
        let size:i64=row.get(1).map_err(|_| "backup.databaseFailed")?;
        if (db::EXPORT_SETTING_KEYS.contains(&key.as_str()) && size>4096) || (secrets::is_setting_secret(&key) && size>16384) {return Err("backup.invalidFile".into());}
    }
    Ok(())
}

fn bundle_counts(bundle: &BackupBundle) -> (usize, usize, usize, usize) {
    let settings = bundle
        .settings
        .iter()
        .filter(|(key, value)| db::validate_import_setting(key, value).is_some())
        .count();
    let favorites = bundle
        .favorites
        .iter()
        .filter(|record| record.is_favorite)
        .count();
    let keys = bundle
        .settings
        .iter()
        .filter(|(key, value)| secrets::is_setting_secret(key) && !value.is_empty())
        .count()
        + bundle
            .favorites
            .iter()
            .filter(|record| record_is_key(record))
            .count();
    (
        settings,
        favorites,
        keys,
        bundle.vault.as_ref().map_or(0, |vault| vault.entries.len()),
    )
}

async fn select_path(app: &AppHandle, export: bool) -> Result<PathBuf, String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog=crate::NativeDialogScope::new().ok_or("backup.busy")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let parent=app.get_webview_window("main").ok_or("backup.fileFailed")?;
    let picker = app.dialog().file().set_parent(&parent);
    if export {
        picker
            .set_file_name("copy-creator-backup.ccbackup")
            .add_filter("Copy Creator encrypted backup", &["ccbackup"])
            .save_file(move |path| {
                let _dialog=dialog;
                let _ = tx.send(path.map(|value| value.to_string()));
            });
    } else {
        picker
            .add_filter("Copy Creator backup", &["ccbackup", "json"])
            .pick_file(move |path| {
                let _dialog=dialog;
                let _ = tx.send(path.map(|value| value.to_string()));
            });
    }
    let selected =
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(120)))
            .await
            .map_err(|_| "backup.fileFailed")?
            .map_err(|_| "backup.fileFailed")?
            .ok_or("cancelled")?;
    Ok(PathBuf::from(selected))
}

#[tauri::command]
pub async fn export_user_data(
    app: AppHandle,
    operation_token: String,
    backup_password: String,
) -> Result<serde_json::Value, String> {
    let operation = crate::lifecycle::claim_operation(&app, &operation_token, "export")?;
    let password = Zeroizing::new(backup_password);
    validate_backup_password(&password)?;
    let path = select_path(&app, true).await?;
    let permit=accept_worker()?;
    let accepted=Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit=permit;
        crate::db_metrics::backup_worker("export",accepted,|| {
        let (base_dir, mut bundle) = { let state = app.state::<db::DbState>();
            crate::db_metrics::backup_connection(&state,"export_snapshot","backup.databaseFailed",|conn| {
            operation.validate_epoch(&state)?;
            let snapshot=conn.unchecked_transaction().map_err(|_| "backup.databaseFailed")?;
            Ok((db::get_storage_dir_for_connection(&app, &snapshot), export_snapshot(&snapshot)?)) })? };
        let mut projected=backup_limits::serialized_size(&bundle,MAX_PAYLOAD)?;
        for record in bundle.favorites.iter().filter(|r|r.record_type=="image") {
            let path=db::storage_content_path(&base_dir,&record.content).ok_or("backup.invalidFile")?;
            let size=std::fs::metadata(path).map_err(|_| "backup.fileFailed")?.len();
            if size>50*1024*1024 {return Err("backup.fileTooLarge".into());}
            projected=projected.saturating_add(4*(size as usize).div_ceil(3)+20);
            if projected>MAX_PAYLOAD {return Err("backup.fileTooLarge".into());}
        }
        for record in bundle.favorites.iter_mut().filter(|record| record.record_type == "image") {
            let image_path = db::storage_content_path(&base_dir, &record.content).ok_or("backup.invalidFile")?;
            let bytes = read_bounded(&image_path, 50 * 1024 * 1024)?;
            record.image_base64 = Some(STANDARD.encode(&bytes));
        }
        let (settings, favorites, keys, entries) = bundle_counts(&bundle);
        let notes_count = bundle.notes.len();
        let note_refs_count: usize = bundle.notes.iter().map(|n| n.refs.len()).sum();
        let bytes = encode_bundle_owned(bundle, &password)?;
        // Finish encryption before opening the destination: failures cannot leave a plaintext or empty backup.
        write_backup(&path, &bytes)?;
        Ok(serde_json::json!({"path": path.to_string_lossy(), "settings_count": settings, "favorites_count": favorites,
            "api_keys_count": keys, "vault_count": entries, "vault_skipped": 0, "notes_count": notes_count,
            "note_refs_count": note_refs_count, "notes_skipped": 0, "notes_conflicts": 0}))
        })
    }).await.map_err(|_| "backup.fileFailed")?
}

fn read_bounded(path: &Path, maximum: usize) -> Result<Zeroizing<Vec<u8>>, String> {
    let file = std::fs::File::open(path).map_err(|_| "backup.fileFailed")?;
    let expected = file.metadata().map_err(|_| "backup.fileFailed")?.len();
    if expected > maximum as u64 {
        return Err("backup.fileTooLarge".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    bytes.try_reserve_exact(expected as usize + 1).map_err(|_| "backup.fileTooLarge")?;
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "backup.fileFailed")?;
    if bytes.len() > maximum {
        return Err("backup.fileTooLarge".into());
    }
    Ok(bytes)
}

fn write_backup(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary =
        path.with_file_name(format!(".copy-creator-backup-{}.tmp", uuid::Uuid::new_v4()));
    let mut staged = StagedImages {
        files: vec![temporary.clone()],
        committed: false,
    };
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "backup.fileFailed")?;
    file.write_all(bytes).map_err(|_| "backup.fileFailed")?;
    file.sync_all().map_err(|_| "backup.fileFailed")?;
    drop(file);
    std::fs::rename(&temporary, path).map_err(|_| "backup.fileFailed")?;
    staged.committed = true;
    Ok(())
}

#[tauri::command]
pub async fn select_user_data_import(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = select_path(&app, false).await?;
    let permit=accept_worker()?;
    let accepted=Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit=permit;
        crate::db_metrics::backup_worker("select",accepted,|| {
        let bytes = read_bounded(&path, MAX_FILE)?;
        let encrypted = file_is_encrypted(&bytes)?;
        let token = uuid::Uuid::new_v4().to_string();
        let result = serde_json::json!({ "token": token, "path": path.to_string_lossy(), "encrypted": encrypted });
        *app.state::<BackupState>().pending.lock().map_err(|_| "backup.expired")? = Some(PendingImport { token, path, bytes:Arc::new(bytes), selected_at: Instant::now() });
        Ok(result)
        })
    }).await.map_err(|_| "backup.fileFailed")?
}

fn pending_bytes(app: &AppHandle, token: &str) -> Result<(PathBuf, Arc<Zeroizing<Vec<u8>>>), String> {
    let state = app.state::<BackupState>();
    let mut pending = state.pending.lock().map_err(|_| "backup.expired")?;
    if pending
        .as_ref()
        .is_some_and(|value| value.selected_at.elapsed() >= IMPORT_LIFETIME)
    {
        *pending = None;
    }
    let value = pending
        .as_ref()
        .filter(|value| value.token == token)
        .ok_or("backup.expired")?;
    Ok((value.path.clone(), value.bytes.clone()))
}

#[tauri::command]
pub fn cancel_user_data_import(app: AppHandle, token: String) {
    if let Ok(mut pending) = app.state::<BackupState>().pending.lock() {
        if pending.as_ref().is_some_and(|value| value.token == token) {
            *pending = None;
        }
    }
}

#[tauri::command]
pub async fn preview_user_data_import(
    app: AppHandle,
    token: String,
    backup_password: String,
) -> Result<serde_json::Value, String> {
    let password = Zeroizing::new(backup_password);
    let permit=accept_worker()?;
    let accepted=Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit=permit;
        crate::db_metrics::backup_worker("preview",accepted,|| {
        let (_, bytes) = pending_bytes(&app, &token)?;
        let (bundle, _) = decode_bundle(&bytes, &password)?;
        let (settings, favorites, keys, entries) = bundle_counts(&bundle);
        let (mode, needs_passwords, note_counts) = { let state = app.state::<db::DbState>();
            crate::db_metrics::backup_connection(&state,"preview_snapshot","backup.databaseFailed",|conn| {
            let snapshot=conn.unchecked_transaction().map_err(|_| "backup.databaseFailed")?;
            let (mode, needs) = vault::backup_mode(&snapshot, bundle.vault.as_ref())?;
            Ok((mode, needs, note_backup::preview(&snapshot,&bundle.notes)?)) })? };
        Ok(serde_json::json!({ "settings_count": settings, "favorites_count": favorites, "api_keys_count": keys, "vault_count": entries,
            "vault_mode": mode, "needs_vault_passwords": needs_passwords, "notes_count": bundle.notes.len(),
            "note_refs_count": bundle.notes.iter().map(|n|n.refs.len()).sum::<usize>(), "notes_conflicts": note_counts.conflicts, "notes_skipped": note_counts.skipped }))
        })
    }).await.map_err(|_| "backup.fileFailed")?
}

struct StagedImages {
    files: Vec<PathBuf>,
    committed: bool,
}
impl Drop for StagedImages {
    fn drop(&mut self) {
        if !self.committed {
            for path in &self.files {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

fn prepare_settings(
    bundle: &BackupBundle,
    encrypted: bool,
) -> Result<HashMap<String, String>, String> {
    let mut settings = HashMap::new();
    for (key, value) in &bundle.settings {
        if let Some(value) = db::validate_import_setting(key, value) {
            settings.insert(key.clone(), value);
        } else if encrypted && SECRET_SETTINGS.contains(&key.as_str()) && !value.is_empty() {
            if secrets::is_protected(value) {
                return Err("backup.invalidFile".into());
            }
            settings.insert(
                key.clone(),
                secrets::protect(value).map_err(|_| "backup.secretUnavailable")?,
            );
        }
    }
    Ok(settings)
}

fn protect_record_keys(bundle: &mut BackupBundle, encrypted: bool) -> Result<(), String> {
    for record in &mut bundle.favorites {
        if !encrypted {
            record.is_favorite = true;
            record.api_label = None;
        }
        if record_is_key(record) {
            // Only new encrypted backups carry portable plaintext keys. A legacy DPAPI value can only be read on its originating Windows account.
            if encrypted && secrets::is_protected(&record.content) {
                return Err("backup.invalidFile".into());
            }
            let key = Zeroizing::new(
                secrets::reveal(&record.content).map_err(|_| "backup.secretUnavailable")?,
            );
            record.content.zeroize();
            record.content = secrets::protect(&key).map_err(|_| "backup.secretUnavailable")?;
            record.user_api_key = true;
        }
        record.favorite_note = record.favorite_note.trim().to_string();
    }
    Ok(())
}

fn stage_images(
    bundle: &mut BackupBundle,
    existing: &HashSet<String>,
    base_dir: &Path,
    staged: &mut StagedImages,
) -> Result<(), String> {
    let images_dir = base_dir.join("images");
    for record in bundle
        .favorites
        .iter_mut()
        .filter(|record| record.record_type == "image")
    {
        if existing.contains(&record.id) {
            continue;
        }
        let encoded = record
            .image_base64
            .as_deref()
            .ok_or("backup.invalidImage")?;
        if encoded.len() > 68 * 1024 * 1024 {
            return Err("backup.invalidImage".into());
        }
        let bytes = Zeroizing::new(
            STANDARD
                .decode(encoded)
                .map_err(|_| "backup.invalidImage")?,
        );
        if bytes.len() > 50 * 1024 * 1024 || image::load_from_memory(&bytes).is_err() {
            return Err("backup.invalidImage".into());
        }
        let extension = if image::guess_format(&bytes).ok() == Some(image::ImageFormat::Jpeg) {
            "jpg"
        } else {
            "png"
        };
        std::fs::create_dir_all(&images_dir).map_err(|_| "backup.fileFailed")?;
        let filename = format!("import-{}.{}", uuid::Uuid::new_v4(), extension);
        let path = images_dir.join(&filename);
        staged.files.push(path.clone());
        std::fs::write(&path, &bytes).map_err(|_| "backup.fileFailed")?;
        record.content = format!("images/{filename}");
    }
    Ok(())
}

#[cfg(test)]
fn apply_bundle(
    conn: &mut Connection,
    bundle: &BackupBundle,
    settings: &HashMap<String,String>,
    plan: &vault::VaultImportPlan,
) -> Result<(usize,usize),String> {
    apply_bundle_full(conn,bundle,settings,plan,&HashMap::new(),None).map(|(entries,skipped,_)|(entries,skipped))
}
fn apply_bundle_full(
    conn: &mut Connection,
    bundle: &BackupBundle,
    settings: &HashMap<String, String>,
    plan: &vault::VaultImportPlan,
    image_sizes: &HashMap<String,u64>,
    expected_images: Option<&HashSet<String>>,
) -> Result<(usize, usize, note_backup::ImportCounts), String> {
    if settings
        .iter()
        .any(|(key, value)| secrets::is_setting_secret(key) && !secrets::is_protected(value))
        || bundle
            .favorites
            .iter()
            .any(|record| record_is_key(record) && !secrets::is_protected(&record.content))
    {
        return Err("backup.invalidFile".into());
    }
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "backup.databaseFailed")?;
    if let Some(expected) = expected_images {
        for record in bundle.favorites.iter().filter(|record|record.record_type=="image") {
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM clipboard_records WHERE id=?1)",[&record.id],|row|row.get(0)).map_err(|_| "backup.databaseFailed")?;
            if exists!=expected.contains(&record.id) {return Err("backup.dataChanged".into());}
        }
    }
    for (path,bytes) in image_sizes {
        crate::clipboard_usage::set_asset_size(&tx,path,*bytes).map_err(|_| "backup.databaseFailed")?;
    }
    for (key, value) in settings {
        tx.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])
            .map_err(|_| "backup.databaseFailed")?;
    }
    for record in &bundle.favorites {
        let existing: Option<(String, String)> = tx
            .query_row(
                "SELECT type, content FROM clipboard_records WHERE id = ?1",
                [&record.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| "backup.databaseFailed")?;
        tx.execute("INSERT INTO clipboard_records (id, type, content, source_app, created_at, user_api_key, is_favorite, favorite_note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(id) DO UPDATE SET is_favorite = MAX(clipboard_records.is_favorite, excluded.is_favorite),
            favorite_note = CASE WHEN clipboard_records.favorite_note = '' THEN excluded.favorite_note ELSE clipboard_records.favorite_note END",
            params![record.id, record.record_type, record.content, record.source_app, record.created_at, record.user_api_key as i64, record.is_favorite as i64, record.favorite_note])
            .map_err(|_| "backup.databaseFailed")?;
        // An ID collision with a different local record must not attach someone else's key label.
        let label_matches = match existing {
            None => true,
            Some((kind, content)) if kind == record.record_type && record.user_api_key => {
                let local = Zeroizing::new(
                    secrets::reveal(&content).map_err(|_| "backup.secretUnavailable")?,
                );
                let incoming = Zeroizing::new(
                    secrets::reveal(&record.content).map_err(|_| "backup.secretUnavailable")?,
                );
                *local == *incoming
            }
            Some(_) => false,
        };
        if label_matches {
            if let Some(label) = &record.api_label {
                let key = Zeroizing::new(
                    secrets::reveal(&record.content).map_err(|_| "backup.secretUnavailable")?,
                );
                // The preview is deliberately omitted from the file and recomputed on this device.
                let preview = if key.chars().count() >= 12 {
                    let start: String = key.chars().take(8).collect();
                    let end: String = key
                        .chars()
                        .rev()
                        .take(4)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    format!("{start}...{end}")
                } else {
                    key.to_string()
                };
                tx.execute("INSERT INTO api_key_labels (record_id, key_preview, service, api_base, note, is_expired, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(record_id) DO NOTHING",
                    params![record.id, preview, label.service, label.api_base, label.note, label.is_expired as i64, label.created_at, label.updated_at]).map_err(|_| "backup.databaseFailed")?;
                tx.execute("INSERT INTO api_services (name, api_base) VALUES (?1, ?2) ON CONFLICT(name) DO NOTHING", params![label.service, label.api_base]).map_err(|_| "backup.databaseFailed")?;
            }
        }
    }
    let result = vault::apply_backup_import(&tx, plan)?;
    crate::suiji::restore_groups(&tx,&bundle.note_groups)?;
    let notes=note_backup::apply(&tx,&bundle.notes)?;
    tx.commit().map_err(|_| "backup.databaseFailed")?;
    Ok((result.0,result.1,notes))
}

use rusqlite::OptionalExtension;

#[tauri::command]
pub async fn import_user_data(
    app: AppHandle,
    operation_token: String,
    token: String,
    backup_password: String,
    current_master_password: String,
    source_master_password: String,
) -> Result<serde_json::Value, String> {
    let operation = crate::lifecycle::claim_operation(&app, &operation_token, "import")?;
    let permit=accept_worker()?;
    let password = Zeroizing::new(backup_password);
    let current_password = Zeroizing::new(current_master_password);
    let source_password = Zeroizing::new(source_master_password);
    let accepted=Instant::now();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit=permit;
        crate::db_metrics::backup_worker("import",accepted,|| {
        let (path, bytes) = pending_bytes(&app, &token)?;
        let (mut bundle, encrypted) = decode_bundle(&bytes, &password)?;
        let (settings_count, favorites, keys, _) = bundle_counts(&bundle);
        let settings = prepare_settings(&bundle, encrypted)?;
        protect_record_keys(&mut bundle, encrypted)?;
        let incoming_vault = bundle.vault.take();
        let mut staged = StagedImages { files: Vec::new(), committed: false };
        let (base_dir,existing_images)={
            let state=app.state::<db::DbState>();
            crate::db_metrics::backup_connection(&state,"image_conflicts","backup.databaseFailed",|conn| {
            operation.validate_epoch(&state)?;
            let mut existing=HashSet::new();
            let mut stmt=conn.prepare("SELECT EXISTS(SELECT 1 FROM clipboard_records WHERE id=?1)").map_err(|_| "backup.databaseFailed")?;
            for record in bundle.favorites.iter().filter(|r|r.record_type=="image") {
                if stmt.query_row([&record.id],|r|r.get::<_,bool>(0)).map_err(|_| "backup.databaseFailed")? {existing.insert(record.id.clone());}
            }
            Ok((db::get_storage_dir_for_connection(&app,conn),existing)) })?
        };
        // Decode/validate and prepare files without the database mutex. The
        // operation lease keeps the directory stable; commit rechecks conflicts.
        stage_images(&mut bundle,&existing_images,&base_dir,&mut staged)?;
        let image_sizes:HashMap<_,_>=bundle.favorites.iter().filter(|record|record.record_type=="image" && !existing_images.contains(&record.id))
            .map(|record|(record.content.clone(),db::stored_image_size(&base_dir,&record.content))).collect();
        // All tables share one transaction. Password or data errors cannot partially replace settings or keys.
        let (entries, skipped, note_counts) = vault::with_backup_import(&app, incoming_vault.as_ref(), &current_password, &source_password, |conn, plan| {
            operation.validate_epoch(&app.state::<db::DbState>())?;
            let (entries, skipped,note_counts) = apply_bundle_full(conn, &bundle, &settings, plan,&image_sizes,Some(&existing_images))?;
            app.state::<db::DbState>().storage_epoch.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok((entries,skipped,note_counts))
        })?;
        let epoch = {
            let db = app.state::<db::DbState>();
            crate::db_metrics::backup_connection(&db,"committed_epoch","backup.databaseFailed",|_conn|
                Ok(db.storage_epoch.load(std::sync::atomic::Ordering::Relaxed)))?
        };
        let _ = app.emit("storage-changed", serde_json::json!({ "storage_epoch": epoch }));
        staged.committed = true;
        cancel_user_data_import(app.clone(), token);
        if let Err(error) = db::enforce_clipboard_limits(&app) { log::warn!("clipboard limit enforcement after import failed: {error}"); }
        let _ = crate::storage_events::emit(&app, "clipboard-refresh", ());
        crate::tray::schedule_tray_refresh(&app);
        Ok(serde_json::json!({"path": path.to_string_lossy(), "settings_count": settings_count, "favorites_count": favorites,
            "api_keys_count": keys, "vault_count": entries, "vault_skipped": skipped, "notes_count": note_counts.imported,
            "note_refs_count": bundle.notes.iter().map(|n|n.refs.len()).sum::<usize>(), "notes_skipped": note_counts.skipped, "notes_conflicts": note_counts.conflicts}))
        })
    }).await.map_err(|_| "backup.fileFailed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = "Original-vault-master-2026!";
    const BACKUP_PASSWORD: &str = "Independent-backup-password!";
    const KEY: &str = "sk-backup-private-test-key-123456789";

    fn note_fixture() -> note_backup::BackupNote {
        note_backup::BackupNote {id:uuid::Uuid::new_v4().to_string(),title:"便签".into(),body:"  完整正文\n第二行  ".into(),refs:vec![crate::notes::NoteRef {
            id:uuid::Uuid::new_v4().to_string(),kind:"file".into(),target:"C:\\external\\keep.txt".into(),display_name:"keep".into()}],
            source:Some(crate::notes::NoteSource {kind:"text".into(),record_id:uuid::Uuid::new_v4().to_string(),source_app:"fixture".into(),captured_at_ms:2}),created_at_ms:1,updated_at_ms:2,archived_at_ms:Some(3),group_id:None,starred:false}
    }
    #[test]
    fn encrypted_v3_remains_readable_and_v4_preserves_organization() {
        let mut source=connection(); let mut note=note_fixture();
        let group=crate::suiji::NoteGroup{id:uuid::Uuid::new_v4().to_string(),name:"group".into(),color:"#aabbcc".into(),sort_order:2,count:0};
        {let tx=source.transaction().unwrap();crate::suiji::restore_groups(&tx,&[group.clone()]).unwrap();note.group_id=Some(group.id.clone());note.starred=true;note_backup::apply(&tx,&[note.clone()]).unwrap();tx.commit().unwrap();}
        let bytes=encode_bundle_owned(export_snapshot(&source).unwrap(),BACKUP_PASSWORD).unwrap();
        let (bundle,_)=decode_bundle(&bytes,BACKUP_PASSWORD).unwrap();
        assert_eq!(bundle.version,4); assert_eq!(bundle.note_groups[0].name,group.name);assert!(bundle.notes[0].starred);
        let mut destination=connection();let import_plan=plan(&destination,None,"","").unwrap();
        apply_bundle(&mut destination,&bundle,&HashMap::new(),&import_plan).unwrap();
        let restored=crate::notes::read_note(&destination,&note.id).unwrap();assert_eq!(restored.summary.group_id,note.group_id);assert!(restored.summary.starred);
        let mut old=export_snapshot(&connection()).unwrap();old.version=3;note.group_id=None;note.starred=false;old.notes.push(note);
        let bytes=encode_bundle(&old,BACKUP_PASSWORD).unwrap();let (restored,_)=decode_bundle(&bytes,BACKUP_PASSWORD).unwrap();
        assert_eq!(restored.version,3);assert!(!restored.notes[0].starred);assert!(restored.notes[0].group_id.is_none());
    }
    #[test]
    fn v4_backup_round_trips_notes_and_excludes_trash_with_separate_authenticated_version() {
        let mut source=connection(); let note=note_fixture(); let mut trash=note_fixture(); trash.title="trash".into();
        {let tx=source.transaction().unwrap();note_backup::apply(&tx,&[note.clone(),trash.clone()]).unwrap();tx.commit().unwrap();}
        source.execute("UPDATE notes SET deleted_at_ms=4 WHERE id=?1",[&trash.id]).unwrap();
        let snapshot=export_snapshot(&source).unwrap(); assert_eq!(snapshot.version,4); assert_eq!(snapshot.notes.len(),1);
        let bytes=encode_bundle_owned(snapshot,BACKUP_PASSWORD).unwrap(); let (restored,_)=decode_bundle(&bytes,BACKUP_PASSWORD).unwrap();
        assert_eq!(restored.notes[0].body,note.body); assert_eq!(restored.notes[0].source,note.source);
        let mut envelope:EncryptedBackup=serde_json::from_slice(&bytes).unwrap(); envelope.version=2;
        assert_eq!(decode_bundle(&serde_json::to_vec(&envelope).unwrap(),BACKUP_PASSWORD).err().unwrap(),"backup.wrongPassword");
    }
    #[test]
    fn encrypted_v2_and_legacy_v0_v1_remain_readable_without_notes() {
        let mut snapshot=export_snapshot(&connection()).unwrap(); snapshot.version=2;
        let bytes=encode_bundle(&snapshot,BACKUP_PASSWORD).unwrap(); let (restored,encrypted)=decode_bundle(&bytes,BACKUP_PASSWORD).unwrap();
        assert_eq!(restored.version,2); assert!(encrypted); assert!(restored.notes.is_empty());
        for version in [0,1] {
            let json=format!("{{\"version\":{version},\"settings\":{{\"theme\":\"dark\"}}}}");
            let (restored,encrypted)=decode_bundle(json.as_bytes(),"").unwrap(); assert!(!encrypted); assert!(restored.notes.is_empty());
        }
    }
    #[test]
    fn note_failure_rolls_back_existing_import_objects() {
        let mut destination=connection(); let mut bundle=export_snapshot(&connection()).unwrap(); bundle.notes.push(note_fixture());
        let settings=HashMap::from([("theme".into(),"dark".into())]); let plan=plan(&destination,None,"","").unwrap();
        destination.execute_batch("CREATE TRIGGER refuse_notes BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(apply_bundle(&mut destination,&bundle,&settings,&plan).is_err());
        assert_eq!(destination.query_row("SELECT value FROM settings WHERE key='theme'",[],|r|r.get::<_,String>(0)).unwrap(),"light");
        assert_eq!(destination.query_row("SELECT count(*) FROM note_import_origins",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }

    #[test]
    fn image_import_accounting_and_conflict_recheck_share_the_commit_transaction() {
        let source=connection();
        source.execute_batch("INSERT INTO clipboard_records(id,type,content,created_at,is_favorite) VALUES('image','image','images/prepared.png','now',1);").unwrap();
        let bundle=export_snapshot(&source).unwrap();
        let mut destination=connection();let import_plan=plan(&destination,None,"","").unwrap();
        let sizes=HashMap::from([("images/prepared.png".into(),1234)]);
        // A record appeared after file staging. Reject before any object or
        // asset size is written, even though the in-process epoch is unchanged.
        destination.execute_batch("INSERT INTO clipboard_records(id,type,content,created_at) VALUES('image','text','existing','now');").unwrap();
        assert_eq!(apply_bundle_full(&mut destination,&bundle,&HashMap::new(),&import_plan,&sizes,Some(&HashSet::new())).err().unwrap(),"backup.dataChanged");
        assert_eq!(destination.query_row("SELECT COUNT(*) FROM clipboard_assets",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        destination.execute("DELETE FROM clipboard_records",[]).unwrap();
        apply_bundle_full(&mut destination,&bundle,&HashMap::new(),&import_plan,&sizes,Some(&HashSet::new())).unwrap();
        assert_eq!(crate::clipboard_usage::get(&destination).unwrap().bytes,1490);
        // A later table failure must roll back both the imported image's
        // reference and its prepared-size ledger entry.
        let mut broken=connection();let broken_plan=plan(&broken,None,"","").unwrap();
        let mut with_note=export_snapshot(&source).unwrap();with_note.notes.push(note_fixture());
        broken.execute_batch("CREATE TRIGGER refuse_notes BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(apply_bundle_full(&mut broken,&with_note,&HashMap::new(),&broken_plan,&sizes,Some(&HashSet::new())).is_err());
        assert_eq!(crate::clipboard_usage::get(&broken).unwrap().records,0);
        assert_eq!(broken.query_row("SELECT COUNT(*) FROM clipboard_assets",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }
    #[test]
    fn aggregate_preflight_rejects_more_than_74_mib_of_notes_before_body_snapshot() {
        let source=connection();
        source.execute_batch("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300)
            INSERT INTO notes SELECT printf('fixture-%d',x),'',CAST(zeroblob(262144) AS TEXT),'',262144,262144,1,1,1,NULL,NULL,NULL,printf('creation-%d',x),'hash','mutation','hash' FROM n;").unwrap();
        assert_eq!(export_snapshot(&source).err().unwrap(),"backup.fileTooLarge");
    }
    #[test]
    fn preflight_keeps_the_existing_200_character_favorite_note_limit() {
        let source=connection();
        source.execute("INSERT INTO clipboard_records(id,type,content,created_at,is_favorite,favorite_note) VALUES('fixture','text','body','2026-10-07',1,?1)",["备".repeat(db::FAVORITE_NOTE_MAX_CHARS)]).unwrap();
        let bundle=export_snapshot(&source).unwrap();
        assert_eq!(bundle.favorites[0].favorite_note.chars().count(),db::FAVORITE_NOTE_MAX_CHARS);
    }

    #[test]
    fn update_preferences_survive_backup_restore() {
        for enabled in ["0", "1"] {
            let source = connection();
            source.execute("INSERT INTO settings VALUES ('auto_check_updates', ?1)", [enabled]).unwrap();
            let snapshot = export_snapshot(&source).unwrap();
            assert_eq!(snapshot.settings["auto_check_updates"], enabled);
            let settings = prepare_settings(&snapshot, true).unwrap();
            let mut destination = connection();
            let import_plan = plan(&destination, None, "", "").unwrap();
            apply_bundle(&mut destination, &snapshot, &settings, &import_plan).unwrap();
            let restored: String = destination.query_row(
                "SELECT value FROM settings WHERE key = 'auto_check_updates'", [], |row| row.get(0),
            ).unwrap();
            assert_eq!(restored, enabled);
        }
        assert!(db::validate_import_setting("auto_check_updates", "invalid").is_none());
    }

    #[test]
    fn vault_auto_lock_preferences_survive_backup_restore() {
        for policy in ["never", "24hours", "3hours", "on_startup"] {
            let source = connection();
            source.execute("INSERT INTO settings VALUES ('vault_auto_lock', ?1)", [policy]).unwrap();
            let snapshot = export_snapshot(&source).unwrap();
            assert_eq!(snapshot.settings["vault_auto_lock"], policy);
            let settings = prepare_settings(&snapshot, true).unwrap();
            let mut destination = connection();
            let import_plan = plan(&destination, None, "", "").unwrap();
            apply_bundle(&mut destination, &snapshot, &settings, &import_plan).unwrap();
            let restored: String = destination.query_row(
                "SELECT value FROM settings WHERE key = 'vault_auto_lock'", [], |row| row.get(0),
            ).unwrap();
            assert_eq!(restored, policy);
        }
        assert!(db::validate_import_setting("vault_auto_lock", "invalid").is_none());
    }

    fn connection() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE clipboard_records (id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, source_app TEXT DEFAULT '',
            created_at TEXT NOT NULL, user_api_key INTEGER DEFAULT 0, is_favorite INTEGER DEFAULT 0, favorite_note TEXT DEFAULT '');
            CREATE TABLE api_key_labels (record_id TEXT PRIMARY KEY, key_preview TEXT NOT NULL, service TEXT NOT NULL, api_base TEXT DEFAULT '',
            note TEXT DEFAULT '', is_expired INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE api_services (name TEXT PRIMARY KEY, api_base TEXT NOT NULL DEFAULT '');
            INSERT INTO settings VALUES ('theme', 'light');").unwrap();
        conn.execute_batch("CREATE TABLE phrase_groups(id TEXT PRIMARY KEY,name TEXT NOT NULL,sort_order INTEGER,created_at TEXT,updated_at TEXT);").unwrap();
        vault::init_schema(&conn).unwrap();
        crate::notes::init_schema(&conn).unwrap();
        note_backup::init_schema(&conn).unwrap();
        crate::clipboard_usage::init_schema(&conn).unwrap();
        conn
    }

    fn seed_vault(
        conn: &Connection,
        master: &str,
        salt: [u8; 16],
        id: &str,
        title: &str,
    ) -> Zeroizing<[u8; 32]> {
        let key = crypto::derive_key(master, &salt).unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO vault_config VALUES (1, 1, ?1, ?2)",
            params![
                STANDARD.encode(salt),
                crypto::encrypt(&key, crypto::VERIFIER_ID, crypto::VERIFIER).unwrap()
            ],
        )
        .unwrap();
        let entry = vault::VaultEntry {
            id: id.into(),
            title: title.into(),
            website: "https://example.test/".into(),
            username: "private-account".into(),
            email: "private@example.test".into(),
            phone: "13800000000".into(),
            password: "Private-website-password!".into(),
            fields: vec![vault::VaultField {
                id: "personal-name".into(),
                label: "Name".into(),
                value: "Private name".into(),
                sensitive: true,
            }],
            verification: vec![vault::VerificationMethod {
                id: "recovery".into(),
                kind: "recovery_codes".into(),
                label: "Recovery".into(),
                value: "PRIVATE-RECOVERY-CODE".into(),
                note: "one per line".into(),
            }],
            notes: "Private website note".into(),
            created_at: "2026-10-01T12:00:00Z".into(),
            updated_at: "2026-10-05T12:00:00Z".into(),
            ..Default::default()
        };
        let plaintext = Zeroizing::new(serde_json::to_vec(&entry).unwrap());
        conn.execute(
            "INSERT INTO vault_entries VALUES (?1, ?2, ?3, ?4)",
            params![
                entry.id,
                crypto::encrypt(&key, &entry.id, &plaintext).unwrap(),
                entry.created_at,
                entry.updated_at
            ],
        )
        .unwrap();
        key
    }

    fn source() -> (Connection, String, Zeroizing<[u8; 32]>) {
        let conn = connection();
        conn.execute("UPDATE settings SET value = 'dark' WHERE key = 'theme'", [])
            .unwrap();
        for setting in SECRET_SETTINGS {
            conn.execute(
                "INSERT INTO settings VALUES (?1, ?2)",
                params![setting, secrets::protect(KEY).unwrap()],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO settings VALUES ('storage_path', 'C:/must-not-move-target')",
            [],
        )
        .unwrap();
        let protected = secrets::protect(KEY).unwrap();
        conn.execute("INSERT INTO clipboard_records VALUES ('key-record', 'text', ?1, 'test app', '2026-10-01T00:00:00Z', 1, 0, 'Key note')", [&protected]).unwrap();
        conn.execute("INSERT INTO api_key_labels VALUES ('key-record', 'omitted-preview', 'Test provider', 'https://api.example.test/v1', 'Account key', 1, '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z')", []).unwrap();
        conn.execute("INSERT INTO clipboard_records VALUES ('favorite', 'text', 'Favorite text', '', '2026-10-01T00:00:00Z', 0, 1, 'Favorite note')", []).unwrap();
        conn.execute("INSERT INTO clipboard_records VALUES ('ordinary-history', 'text', 'History should not be backed up', '', '2026-10-01T00:00:00Z', 0, 0, '')", []).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let key = seed_vault(&conn, MASTER, [7; 16], &id, "Private website title");
        (conn, id, key)
    }

    fn plan(
        conn: &Connection,
        incoming: Option<&vault::VaultBackup>,
        current: &str,
        source: &str,
    ) -> Result<vault::VaultImportPlan, String> {
        let configuration =
            vault::snapshot_backup(conn)?.map(|backup| (backup.salt, backup.verifier));
        vault::prepare_backup_import(configuration, incoming, current, source)
    }

    fn restore_entry(conn: &Connection, key: &[u8; 32], id: &str) -> vault::VaultEntry {
        let ciphertext: String = conn
            .query_row(
                "SELECT encrypted_data FROM vault_entries WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .unwrap();
        let plaintext = crypto::decrypt(key, id, &ciphertext).unwrap();
        serde_json::from_slice(&plaintext).unwrap()
    }

    #[test]
    fn encrypted_backup_is_portable_and_restores_keys_labels_and_vault() {
        let (source, id, vault_key) = source();
        let snapshot = export_snapshot(&source).unwrap();
        assert_eq!(bundle_counts(&snapshot), (1, 1, 4, 1));
        assert!(!snapshot.settings.contains_key("storage_path"));
        assert!(!snapshot
            .favorites
            .iter()
            .any(|record| record.id == "ordinary-history"));
        assert_eq!(snapshot.settings["ai_api_key"], KEY);
        let bytes = encode_bundle(&snapshot, BACKUP_PASSWORD).unwrap();
        let wire = std::str::from_utf8(&bytes).unwrap();
        for private in [
            KEY,
            "Private website title",
            "private@example.test",
            "Private-website-password!",
            "PRIVATE-RECOVERY-CODE",
            "Account key",
            "api.example.test",
            "Favorite text",
            "dpapi:v1:",
        ] {
            assert!(!wire.contains(private));
        }
        let (mut restored, encrypted) = decode_bundle(&bytes, BACKUP_PASSWORD).unwrap();
        assert!(encrypted);
        // Payload API keys are portable values, not DPAPI ciphertext from the source machine.
        assert_eq!(
            restored
                .favorites
                .iter()
                .find(|record| record.id == "key-record")
                .unwrap()
                .content,
            KEY
        );
        let mut destination = connection();
        let settings = prepare_settings(&restored, true).unwrap();
        protect_record_keys(&mut restored, true).unwrap();
        let import_plan = plan(&destination, restored.vault.as_ref(), "", "").unwrap();
        assert_eq!(
            apply_bundle(&mut destination, &restored, &settings, &import_plan).unwrap(),
            (1, 0)
        );
        for setting in SECRET_SETTINGS {
            let stored: String = destination
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    [setting],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(secrets::is_protected(&stored));
            assert_eq!(secrets::reveal(&stored).unwrap(), KEY);
        }
        let (content, favorite, flag): (String, i64, i64) = destination.query_row("SELECT content, is_favorite, user_api_key FROM clipboard_records WHERE id = 'key-record'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap();
        assert!(secrets::is_protected(&content));
        assert_eq!(secrets::reveal(&content).unwrap(), KEY);
        assert_eq!((favorite, flag), (0, 1));
        let (label, expired): (String, i64) = destination
            .query_row(
                "SELECT note, is_expired FROM api_key_labels WHERE record_id = 'key-record'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(label, "Account key");
        assert_eq!(expired, 1);
        let entry = restore_entry(&destination, &vault_key, &id);
        assert_eq!(entry.password, "Private-website-password!");
        assert_eq!(entry.fields[0].value, "Private name");
        assert_eq!(entry.verification[0].value, "PRIVATE-RECOVERY-CODE");
        assert_eq!(entry.created_at, "2026-10-01T12:00:00Z");
        let repeat = plan(&destination, restored.vault.as_ref(), "", "").unwrap();
        assert_eq!(
            apply_bundle(&mut destination, &restored, &settings, &repeat).unwrap(),
            (0, 1)
        );
        assert_eq!(
            destination
                .query_row("SELECT COUNT(*) FROM clipboard_records", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            vault::backup_mode(&destination, restored.vault.as_ref()).unwrap(),
            ("merge", false)
        );
    }

    #[test]
    fn wrong_password_tampering_and_unknown_formats_are_rejected() {
        let snapshot = export_snapshot(&connection()).unwrap();
        let bytes = encode_bundle(&snapshot, BACKUP_PASSWORD).unwrap();
        assert_eq!(
            decode_bundle(&bytes, "wrong-password").err().unwrap(),
            "backup.wrongPassword"
        );
        let mut envelope: EncryptedBackup = serde_json::from_slice(&bytes).unwrap();
        let mut ciphertext = STANDARD
            .decode(envelope.payload.strip_prefix("v1:").unwrap())
            .unwrap();
        ciphertext[15] ^= 1;
        envelope.payload = format!("v1:{}", STANDARD.encode(ciphertext)).into();
        assert_eq!(
            decode_bundle(&serde_json::to_vec(&envelope).unwrap(), BACKUP_PASSWORD)
                .err()
                .unwrap(),
            "backup.wrongPassword"
        );
        envelope.kdf = "argon2id-arbitrary-cost".into();
        assert_eq!(
            decode_bundle(&serde_json::to_vec(&envelope).unwrap(), BACKUP_PASSWORD)
                .err()
                .unwrap(),
            "backup.unsupportedVersion"
        );
        envelope.version = 99;
        assert_eq!(
            decode_bundle(&serde_json::to_vec(&envelope).unwrap(), BACKUP_PASSWORD)
                .err()
                .unwrap(),
            "backup.unsupportedVersion"
        );
        assert!(encode_bundle(&snapshot, "short").is_err());
        assert_eq!(
            decode_bundle(br#"{"version":2,"settings":{}}"#, BACKUP_PASSWORD)
                .err()
                .unwrap(),
            "backup.unsupportedVersion"
        );
    }

    #[test]
    fn different_master_vaults_merge_without_overwriting_local_accounts() {
        let (source, id, source_key) = source();
        let extra_id = uuid::Uuid::new_v4().to_string();
        seed_vault(&source, MASTER, [7; 16], &extra_id, "New source account");
        let mut destination = connection();
        let destination_key = seed_vault(
            &destination,
            "Destination-master-password!",
            [8; 16],
            &id,
            "Local account must win",
        );
        let configuration = vault::snapshot_backup(&destination).unwrap().unwrap();
        let mut snapshot = export_snapshot(&source).unwrap();
        protect_record_keys(&mut snapshot, true).unwrap();
        assert_eq!(
            vault::backup_mode(&destination, snapshot.vault.as_ref()).unwrap(),
            ("merge", true)
        );
        assert_eq!(
            plan(&destination, snapshot.vault.as_ref(), "", "")
                .err()
                .unwrap(),
            "backup.vaultPasswordsRequired"
        );
        assert_eq!(
            plan(
                &destination,
                snapshot.vault.as_ref(),
                "Wrong-current-master!",
                MASTER
            )
            .err()
            .unwrap(),
            "vault.wrongMaster"
        );
        assert_eq!(
            plan(
                &destination,
                snapshot.vault.as_ref(),
                "Destination-master-password!",
                "Wrong-original-master!"
            )
            .err()
            .unwrap(),
            "backup.wrongSourceMaster"
        );
        let import_plan = plan(
            &destination,
            snapshot.vault.as_ref(),
            "Destination-master-password!",
            MASTER,
        )
        .unwrap();
        assert_eq!(
            apply_bundle(&mut destination, &snapshot, &HashMap::new(), &import_plan).unwrap(),
            (1, 1)
        );
        assert_eq!(
            restore_entry(&destination, &destination_key, &id).title,
            "Local account must win"
        );
        let imported = restore_entry(&destination, &destination_key, &extra_id);
        assert_eq!(imported.title, "New source account");
        assert_eq!(imported.verification[0].value, "PRIVATE-RECOVERY-CODE");
        let ciphertext: String = destination
            .query_row(
                "SELECT encrypted_data FROM vault_entries WHERE id = ?1",
                [&extra_id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(crypto::decrypt(&source_key, &extra_id, &ciphertext).is_err());
        let after = vault::snapshot_backup(&destination).unwrap().unwrap();
        assert_eq!(
            (configuration.salt, configuration.verifier),
            (after.salt, after.verifier)
        );
    }

    #[test]
    fn transaction_failure_rolls_back_settings_keys_labels_and_vault_configuration() {
        let (source, _, _) = source();
        let mut snapshot = export_snapshot(&source).unwrap();
        let settings = prepare_settings(&snapshot, true).unwrap();
        protect_record_keys(&mut snapshot, true).unwrap();
        let mut destination = connection();
        destination.execute_batch("CREATE TRIGGER fail_vault BEFORE INSERT ON vault_entries BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        let import_plan = plan(&destination, snapshot.vault.as_ref(), "", "").unwrap();
        assert!(apply_bundle(&mut destination, &snapshot, &settings, &import_plan).is_err());
        assert_eq!(
            destination
                .query_row(
                    "SELECT value FROM settings WHERE key = 'theme'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "light"
        );
        assert_eq!(
            destination
                .query_row("SELECT COUNT(*) FROM settings", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        for table in [
            "clipboard_records",
            "api_key_labels",
            "api_services",
            "vault_entries",
            "vault_config",
        ] {
            assert_eq!(
                destination
                    .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row
                        .get::<_, i64>(0))
                    .unwrap(),
                0
            );
        }
    }

    #[test]
    fn legacy_json_reprotects_record_keys_and_preserves_current_vault_and_translation_keys() {
        let json = format!(
            r#"{{"version":1,"settings":{{"theme":"dark","ai_api_key":"do-not-replace-existing-key"}},"favorites":[{{"id":"legacy","type":"text","content":"{KEY}","created_at":"2026-10-01T00:00:00Z","favorite_note":"Legacy note"}}]}}"#
        );
        let (mut bundle, encrypted) = decode_bundle(json.as_bytes(), "").unwrap();
        assert!(!encrypted);
        assert!(!bundle.settings.contains_key("ai_api_key"));
        let (mut destination, id, vault_key) = source();
        let settings = prepare_settings(&bundle, false).unwrap();
        protect_record_keys(&mut bundle, false).unwrap();
        let import_plan = plan(&destination, None, "", "").unwrap();
        apply_bundle(&mut destination, &bundle, &settings, &import_plan).unwrap();
        let stored: String = destination
            .query_row(
                "SELECT content FROM clipboard_records WHERE id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(secrets::is_protected(&stored));
        assert_eq!(secrets::reveal(&stored).unwrap(), KEY);
        let setting: String = destination
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai_api_key'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(secrets::reveal(&setting).unwrap(), KEY);
        assert_eq!(
            restore_entry(&destination, &vault_key, &id).title,
            "Private website title"
        );
        assert!(decode_bundle(br#"{"settings":{"theme":"light"},"favorites":[]}"#, "").is_ok());
    }

    #[test]
    fn duplicate_vault_ids_and_mismatched_record_binding_are_rejected() {
        let (source, _, _) = source();
        let mut snapshot = export_snapshot(&source).unwrap();
        let source_backup = snapshot.vault.as_mut().unwrap();
        source_backup.entries.push(source_backup.entries[0].clone());
        assert_eq!(
            validate_bundle(&snapshot).err().unwrap(),
            "backup.invalidFile"
        );
        let source_backup = snapshot.vault.as_mut().unwrap();
        source_backup.entries.pop();
        source_backup.entries[0].id = uuid::Uuid::new_v4().to_string();
        let destination = connection();
        seed_vault(
            &destination,
            "Destination-master-password!",
            [8; 16],
            &uuid::Uuid::new_v4().to_string(),
            "Existing",
        );
        assert_eq!(
            plan(
                &destination,
                snapshot.vault.as_ref(),
                "Destination-master-password!",
                MASTER
            )
            .err()
            .unwrap(),
            "backup.invalidFile"
        );
    }

    #[test]
    fn image_staging_failure_removes_previously_written_files() {
        let directory =
            std::env::temp_dir().join(format!("copy-creator-backup-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgba8(1, 1)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let mut bundle = export_snapshot(&connection()).unwrap();
        for (id, image_base64) in [
            ("valid", STANDARD.encode(png.into_inner())),
            ("invalid", "not-an-image".into()),
        ] {
            bundle.favorites.push(BackupRecord {
                id: id.into(),
                record_type: "image".into(),
                content: "images/original.png".into(),
                source_app: String::new(),
                created_at: "2026-10-01T00:00:00Z".into(),
                user_api_key: false,
                is_favorite: true,
                favorite_note: String::new(),
                image_base64: Some(image_base64),
                api_label: None,
            });
        }
        {
            let mut staged = StagedImages {
                files: Vec::new(),
                committed: false,
            };
            assert_eq!(
                stage_images(&mut bundle, &HashSet::new(), &directory, &mut staged)
                    .err()
                    .unwrap(),
                "backup.invalidImage"
            );
            assert_eq!(staged.files.len(), 1);
            assert!(staged.files[0].exists());
        }
        assert_eq!(
            std::fs::read_dir(directory.join("images")).unwrap().count(),
            0
        );
        std::fs::remove_dir(directory.join("images")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn conflicting_local_key_ids_do_not_receive_foreign_labels() {
        let (source, _, _) = source();
        let mut bundle = export_snapshot(&source).unwrap();
        protect_record_keys(&mut bundle, true).unwrap();
        let mut destination = connection();
        destination.execute("INSERT INTO clipboard_records VALUES ('key-record', 'text', 'Local ordinary content', '', '2026-10-01T00:00:00Z', 0, 0, 'Local note')", []).unwrap();
        let import_plan = plan(&destination, bundle.vault.as_ref(), "", "").unwrap();
        apply_bundle(&mut destination, &bundle, &HashMap::new(), &import_plan).unwrap();
        let (content, note): (String, String) = destination
            .query_row(
                "SELECT content, favorite_note FROM clipboard_records WHERE id = 'key-record'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(content, "Local ordinary content");
        assert_eq!(note, "Local note");
        assert_eq!(
            destination
                .query_row("SELECT COUNT(*) FROM api_key_labels", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn backup_file_replacement_is_atomic_and_failed_rename_leaves_no_temporary_file() {
        let directory =
            std::env::temp_dir().join(format!("copy-creator-backup-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let target = directory.join("backup.ccbackup");
        std::fs::write(&target, b"existing backup").unwrap();
        write_backup(&target, b"complete encrypted backup").unwrap();
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"complete encrypted backup"
        );
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        let blocked = directory.join("existing-directory");
        std::fs::create_dir(&blocked).unwrap();
        assert!(write_backup(&blocked, b"encrypted backup").is_err());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 2);
        assert!(blocked.is_dir());
        std::fs::remove_file(target).unwrap();
        std::fs::remove_dir(blocked).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
