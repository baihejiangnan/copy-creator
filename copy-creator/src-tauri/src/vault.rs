use crate::{db::DbState, vault_crypto as crypto};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
enum AutoLock {
    #[serde(rename = "never")]
    Never,
    #[serde(rename = "24hours")]
    After24Hours,
    #[default]
    #[serde(rename = "3hours")]
    After3Hours,
    #[serde(rename = "on_startup")]
    OnStartup,
}

impl AutoLock {
    fn from_setting(value: &str) -> Self {
        match value {
            "never" => Self::Never,
            "24hours" => Self::After24Hours,
            "on_startup" => Self::OnStartup,
            _ => Self::After3Hours,
        }
    }

    fn timeout(self) -> Option<Duration> {
        match self {
            Self::After24Hours => Some(Duration::from_secs(24 * 60 * 60)),
            Self::After3Hours => Some(Duration::from_secs(3 * 60 * 60)),
            Self::Never | Self::OnStartup => None,
        }
    }
}

#[derive(Default)]
struct Session {
    key: Option<Zeroizing<[u8; 32]>>,
    activity: Option<Instant>,
    epoch: u64,
    failures: u32,
    retry_at: Option<Instant>,
    auto_lock: AutoLock,
}

impl Session {
    fn unlocked(&self) -> bool {
        self.key.is_some() && self.auto_lock.timeout().is_none_or(|timeout| {
            self.activity.is_some_and(|time| time.elapsed() < timeout)
        })
    }
    fn lock(&mut self) {
        self.key = None;
        self.activity = None;
        self.epoch = self.epoch.wrapping_add(1);
    }
}

#[derive(Default)]
pub struct VaultState {
    session: Mutex<Session>,
    operation: Mutex<()>,
}

#[derive(Serialize)]
pub struct VaultStatus {
    configured: bool,
    unlocked: bool,
    auto_lock: AutoLock,
}

fn storage_epoch(app: &AppHandle) -> u64 {
    app.state::<DbState>().storage_epoch.load(std::sync::atomic::Ordering::Relaxed)
}

fn read_auto_lock(app: &AppHandle) -> Result<(AutoLock, u64), String> {
    let db = app.state::<DbState>();
    let conn = db.conn.lock().map_err(|_| "vault.databaseFailed")?;
    let value: Option<String> = conn.query_row(
        "SELECT value FROM settings WHERE key = 'vault_auto_lock'", [], |row| row.get(0),
    ).optional().map_err(|_| "vault.databaseFailed")?;
    Ok((AutoLock::from_setting(value.as_deref().unwrap_or("3hours")), storage_epoch(app)))
}

pub(crate) fn refresh_auto_lock(app: &AppHandle) -> Result<(), String> {
    let (policy, origin) = read_auto_lock(app)?;
    let state = app.state::<VaultState>();
    let mut session = state.session.lock().map_err(|_| "vault.locked")?;
    if storage_epoch(app) != origin { return Err("notes.storageChanged".into()); }
    session.auto_lock = policy;
    // A shorter timeout takes effect immediately, without extending the session.
    let expired = session.key.is_some() && !session.unlocked();
    if expired { session.lock(); }
    drop(session);
    if expired { notify_locked(app, origin); }
    Ok(())
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultField {
    pub id: String,
    pub label: String,
    pub value: String,
    pub sensitive: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct VerificationMethod {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub value: String,
    pub note: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct VaultEntry {
    pub id: String,
    pub title: String,
    pub website: String,
    pub username: String,
    pub email: String,
    pub phone: String,
    pub password: String,
    pub tags: Vec<String>,
    pub fields: Vec<VaultField>,
    pub verification: Vec<VerificationMethod>,
    pub notes: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
pub struct VaultSummary {
    id: String,
    title: String,
    website: String,
    username: String,
    email: String,
    tags: Vec<String>,
    has_password: bool,
    verification_count: usize,
    updated_at: String,
}

impl VaultEntry {
    fn summary(&self) -> VaultSummary {
        VaultSummary {
            id: self.id.clone(),
            title: self.title.clone(),
            website: self.website.clone(),
            username: self.username.clone(),
            email: self.email.clone(),
            tags: self.tags.clone(),
            has_password: !self.password.is_empty(),
            verification_count: self.verification.len(),
            updated_at: self.updated_at.clone(),
        }
    }
    fn matches(&self, query: &str) -> bool {
        let searchable = format!(
            "{} {} {} {} {} {} {} {}",
            self.title,
            self.website,
            self.username,
            self.email,
            self.phone,
            self.tags.join(" "),
            self.notes,
            self.fields
                .iter()
                .filter(|field| !field.sensitive)
                .map(|field| format!("{} {}", field.label, field.value))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let searchable = searchable.to_lowercase();
        query
            .to_lowercase()
            .split_whitespace()
            .all(|term| searchable.contains(term))
    }
    fn validate(&mut self) -> Result<(), String> {
        self.title = self.title.trim().to_string();
        self.website = self.website.trim().to_string();
        self.username = self.username.trim().to_string();
        self.email = self.email.trim().to_string();
        self.phone = self.phone.trim().to_string();
        if self.title.is_empty() || self.title.chars().count() > 120 {
            return Err("vault.titleRequired".into());
        }
        if !self.website.is_empty() {
            let url = if self.website.contains("://") {
                self.website.clone()
            } else {
                format!("https://{}", self.website)
            };
            let parsed = reqwest::Url::parse(&url).map_err(|_| "vault.invalidWebsite")?;
            if !matches!(parsed.scheme(), "http" | "https")
                || parsed.host_str().is_none()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
                || url.len() > 2048
            {
                return Err("vault.invalidWebsite".into());
            }
            self.website = parsed.to_string();
        }
        if self.fields.len() > 64
            || self.verification.len() > 32
            || self.tags.len() > 20
            || [&self.username, &self.email, &self.phone, &self.password]
                .iter()
                .any(|value| value.len() > 2048)
            || self.notes.len() > 16384
            || self.tags.iter().any(|tag| tag.chars().count() > 40)
        {
            return Err("vault.tooMuchData".into());
        }
        let mut ids = std::collections::HashSet::new();
        for field in &mut self.fields {
            field.label = field.label.trim().to_string();
            if field.id.is_empty() {
                field.id = uuid::Uuid::new_v4().to_string();
            }
            if field.label.is_empty()
                || field.label.chars().count() > 80
                || field.value.len() > 16384
                || !ids.insert(field.id.clone())
            {
                return Err("vault.invalidField".into());
            }
        }
        for method in &mut self.verification {
            method.label = method.label.trim().to_string();
            if method.id.is_empty() {
                method.id = uuid::Uuid::new_v4().to_string();
            }
            if method.label.is_empty()
                || method.label.chars().count() > 80
                || method.value.len() > 16384
                || method.note.len() > 4096
                || !matches!(
                    method.kind.as_str(),
                    "email"
                        | "sms"
                        | "recovery_codes"
                        | "security_question"
                        | "authenticator"
                        | "passkey"
                        | "custom"
                )
                || !ids.insert(method.id.clone())
            {
                return Err("vault.invalidField".into());
            }
        }
        self.tags = self
            .tags
            .iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .collect();
        Ok(())
    }
    fn field_value(&self, field: &str) -> Result<&str, String> {
        match field {
            "username" => Ok(&self.username),
            "email" => Ok(&self.email),
            "phone" => Ok(&self.phone),
            "password" => Ok(&self.password),
            "website" => Ok(&self.website),
            "notes" => Ok(&self.notes),
            _ => {
                if let Some(id) = field.strip_prefix("field:") {
                    return self
                        .fields
                        .iter()
                        .find(|value| value.id == id)
                        .map(|value| value.value.as_str())
                        .ok_or_else(|| "vault.notFound".into());
                }
                if let Some(id) = field.strip_prefix("verification:") {
                    return self
                        .verification
                        .iter()
                        .find(|value| value.id == id)
                        .map(|value| value.value.as_str())
                        .ok_or_else(|| "vault.notFound".into());
                }
                Err("vault.notFound".into())
            }
        }
    }
}

pub fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS vault_config (
        id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, salt TEXT NOT NULL, verifier TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS vault_entries (
        id TEXT PRIMARY KEY, encrypted_data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );")
}

fn config(conn: &Connection) -> Result<Option<(String, String)>, String> {
    let value: Option<(i64, String, String)> = conn
        .query_row(
            "SELECT version, salt, verifier FROM vault_config WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|_| "vault.databaseFailed")?;
    match value {
        Some((1, salt, verifier)) => Ok(Some((salt, verifier))),
        Some(_) => Err("vault.invalidData".into()),
        None => {
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM vault_entries", [], |row| row.get(0))
                .map_err(|_| "vault.databaseFailed")?;
            if count != 0 {
                return Err("vault.invalidData".into());
            }
            Ok(None)
        }
    }
}

pub fn ensure_empty_storage(destination: &Connection) -> Result<(), String> {
    if config(destination)?.is_some() {
        return Err("vault.storageConflict".into());
    }
    Ok(())
}

#[cfg(test)]
pub fn copy_encrypted_storage(
    source: &Connection,
    destination: &mut Connection,
) -> Result<(), String> {
    let tx = destination.transaction().map_err(|_| "vault.databaseFailed")?;
    copy_encrypted_into(source, &tx)?;
    tx.commit().map_err(|_| "vault.databaseFailed".to_string())
}
/// The caller owns the transaction, so notes/settings/vault share one commit.
pub(crate) fn copy_encrypted_into(source: &Connection, destination: &Connection) -> Result<(), String> {
    let Some((salt, verifier)) = config(source)? else {
        return Ok(());
    };
    ensure_empty_storage(destination)?;
    destination.execute(
        "INSERT INTO vault_config (id, version, salt, verifier) VALUES (1, 1, ?1, ?2)",
        params![salt, verifier],
    )
    .map_err(|_| "vault.databaseFailed")?;
    let mut stmt = source
        .prepare("SELECT id, encrypted_data, created_at, updated_at FROM vault_entries")
        .map_err(|_| "vault.databaseFailed")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|_| "vault.databaseFailed")?;
    for row in rows {
        let (id, encrypted, created, updated) = row.map_err(|_| "vault.databaseFailed")?;
        destination.execute("INSERT INTO vault_entries (id, encrypted_data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)", params![id, encrypted, created, updated]).map_err(|_| "vault.databaseFailed")?;
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
pub(crate) struct VaultBackup {
    pub version: u32,
    pub salt: String,
    pub verifier: String,
    pub entries: Vec<EncryptedBackupEntry>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct EncryptedBackupEntry {
    pub id: String,
    pub encrypted_data: String,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn snapshot_backup(conn: &Connection) -> Result<Option<VaultBackup>, String> {
    let Some((salt, verifier)) = config(conn)? else {
        return Ok(None);
    };
    let mut stmt = conn
        .prepare("SELECT id, encrypted_data, created_at, updated_at FROM vault_entries ORDER BY id")
        .map_err(|_| "vault.databaseFailed")?;
    let entries = stmt
        .query_map([], |row| {
            Ok(EncryptedBackupEntry {
                id: row.get(0)?,
                encrypted_data: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|_| "vault.databaseFailed")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|_| "vault.databaseFailed")?;
    let backup = VaultBackup {
        version: 1,
        salt,
        verifier,
        entries,
    };
    validate_backup(&backup)?;
    Ok(Some(backup))
}

pub(crate) fn validate_backup(backup: &VaultBackup) -> Result<(), String> {
    fn valid_envelope(value: &str, maximum: usize) -> bool {
        value.len() <= maximum
            && value
                .strip_prefix("v1:")
                .and_then(|encoded| STANDARD.decode(encoded).ok())
                .is_some_and(|bytes| bytes.len() >= 28)
    }
    if backup.version != 1
        || !STANDARD
            .decode(&backup.salt)
            .ok()
            .is_some_and(|salt| salt.len() == 16)
        || !valid_envelope(&backup.verifier, 256)
        || backup.entries.len() > 100_000
    {
        return Err("backup.invalidFile".into());
    }
    let mut ids = std::collections::HashSet::new();
    for entry in &backup.entries {
        if uuid::Uuid::parse_str(&entry.id).is_err()
            || !ids.insert(&entry.id)
            || !valid_envelope(&entry.encrypted_data, 350_000)
            || chrono::DateTime::parse_from_rfc3339(&entry.created_at).is_err()
            || chrono::DateTime::parse_from_rfc3339(&entry.updated_at).is_err()
        {
            return Err("backup.invalidFile".into());
        }
    }
    Ok(())
}

pub(crate) fn backup_mode(
    conn: &Connection,
    incoming: Option<&VaultBackup>,
) -> Result<(&'static str, bool), String> {
    let Some(incoming) = incoming else {
        return Ok(("none", false));
    };
    match config(conn)? {
        None => Ok(("restore", false)),
        Some(current) => Ok((
            "merge",
            !incoming.entries.is_empty()
                && current != (incoming.salt.clone(), incoming.verifier.clone()),
        )),
    }
}

pub(crate) struct VaultImportPlan {
    expected: Option<(String, String)>,
    create: Option<(String, String)>,
    entries: Vec<EncryptedBackupEntry>,
}

// Parsed account fields are erased after re-encryption, including validation failures.
struct BackupPlainEntry(VaultEntry);
impl Drop for BackupPlainEntry {
    fn drop(&mut self) {
        let entry = &mut self.0;
        for text in [
            &mut entry.id,
            &mut entry.title,
            &mut entry.website,
            &mut entry.username,
            &mut entry.email,
            &mut entry.phone,
            &mut entry.password,
            &mut entry.notes,
            &mut entry.created_at,
            &mut entry.updated_at,
        ] {
            text.zeroize();
        }
        entry.tags.zeroize();
        for field in &mut entry.fields {
            field.id.zeroize();
            field.label.zeroize();
            field.value.zeroize();
        }
        for method in &mut entry.verification {
            method.id.zeroize();
            method.kind.zeroize();
            method.label.zeroize();
            method.value.zeroize();
            method.note.zeroize();
        }
    }
}

fn verified_backup_key(
    salt: &str,
    verifier: &str,
    password: &str,
    error: &str,
) -> Result<Zeroizing<[u8; 32]>, String> {
    let salt = STANDARD.decode(salt).map_err(|_| "backup.invalidFile")?;
    let key = crypto::derive_key(password, &salt)?;
    if !crypto::decrypt(&key, crypto::VERIFIER_ID, verifier)
        .is_ok_and(|value| value.as_slice() == crypto::VERIFIER)
    {
        return Err(error.into());
    }
    Ok(key)
}

pub(crate) fn prepare_backup_import(
    current: Option<(String, String)>,
    incoming: Option<&VaultBackup>,
    current_password: &str,
    source_password: &str,
) -> Result<VaultImportPlan, String> {
    let mut plan = VaultImportPlan {
        expected: current.clone(),
        create: None,
        entries: Vec::new(),
    };
    let Some(incoming) = incoming else {
        return Ok(plan);
    };
    validate_backup(incoming)?;
    let source_config = (incoming.salt.clone(), incoming.verifier.clone());
    if current.is_none() {
        plan.create = Some(source_config);
        plan.entries = incoming.entries.clone();
    } else if current.as_ref() == Some(&source_config) || incoming.entries.is_empty() {
        plan.entries = incoming.entries.clone();
    } else {
        if current_password.is_empty() || source_password.is_empty() {
            return Err("backup.vaultPasswordsRequired".into());
        }
        let (salt, verifier) = current.as_ref().unwrap();
        let current_key =
            verified_backup_key(salt, verifier, current_password, "vault.wrongMaster")?;
        let source_key = verified_backup_key(
            &incoming.salt,
            &incoming.verifier,
            source_password,
            "backup.wrongSourceMaster",
        )?;
        for record in &incoming.entries {
            let plaintext = crypto::decrypt(&source_key, &record.id, &record.encrypted_data)
                .map_err(|_| "backup.invalidFile")?;
            if plaintext.len() > 262144 {
                return Err("backup.invalidFile".into());
            }
            let mut entry = BackupPlainEntry(
                serde_json::from_slice(&plaintext).map_err(|_| "backup.invalidFile")?,
            );
            if entry.0.id != record.id
                || entry.0.created_at != record.created_at
                || entry.0.updated_at != record.updated_at
            {
                return Err("backup.invalidFile".into());
            }
            entry.0.validate().map_err(|_| "backup.invalidFile")?;
            let normalized =
                Zeroizing::new(serde_json::to_vec(&entry.0).map_err(|_| "backup.invalidFile")?);
            plan.entries.push(EncryptedBackupEntry {
                encrypted_data: crypto::encrypt(&current_key, &record.id, &normalized)?,
                ..record.clone()
            });
        }
    }
    Ok(plan)
}

pub(crate) fn apply_backup_import(
    conn: &Connection,
    plan: &VaultImportPlan,
) -> Result<(usize, usize), String> {
    if config(conn)? != plan.expected {
        return Err("backup.vaultChanged".into());
    }
    if let Some((salt, verifier)) = &plan.create {
        conn.execute(
            "INSERT INTO vault_config (id, version, salt, verifier) VALUES (1, 1, ?1, ?2)",
            params![salt, verifier],
        )
        .map_err(|_| "vault.databaseFailed")?;
    }
    let mut imported = 0;
    for record in &plan.entries {
        imported += conn.execute("INSERT INTO vault_entries (id, encrypted_data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO NOTHING",
            params![record.id, record.encrypted_data, record.created_at, record.updated_at]).map_err(|_| "vault.databaseFailed")?;
    }
    Ok((imported, plan.entries.len() - imported))
}

pub(crate) fn with_backup_import<T>(
    app: &AppHandle,
    incoming: Option<&VaultBackup>,
    current_password: &str,
    source_password: &str,
    action: impl FnOnce(&mut Connection, &VaultImportPlan) -> Result<T, String>,
) -> Result<T, String> {
    // The caller retains the exclusive storage handoff lease through import.
    let origin = storage_epoch(app);
    let state = app.state::<VaultState>();
    let _operation = state.operation.lock().map_err(|_| "vault.locked")?;
    let (current, needs_passwords) = {
        let db = app.state::<DbState>();
        crate::db_metrics::backup_connection(&db,"vault_config","vault.databaseFailed",|conn|
            Ok((config(conn)?, backup_mode(conn, incoming)?.1)))?
    };
    let epoch = {
        let session = state.session.lock().map_err(|_| "vault.locked")?;
        if needs_passwords && session.retry_at.is_some_and(|time| time > Instant::now()) {
            return Err("vault.retryLater".into());
        }
        session.epoch
    };
    let plan = match prepare_backup_import(current, incoming, current_password, source_password) {
        Ok(plan) => plan,
        Err(error) => {
            if error == "vault.wrongMaster" {
                let mut session = state.session.lock().map_err(|_| "vault.locked")?;
                session.failures += 1;
                if session.failures >= 5 {
                    session.retry_at = Some(Instant::now() + Duration::from_secs(30));
                }
            }
            return Err(error);
        }
    };
    let result = {
        let mut session = state.session.lock().map_err(|_| "vault.locked")?;
        if session.epoch != epoch {
            return Err("vault.locked".into());
        }
        let db = app.state::<DbState>();
        let result = crate::db_metrics::backup_connection(&db,"commit","vault.databaseFailed",|conn| action(conn, &plan));
        if result.is_ok() && incoming.is_some() {
            session.lock();
            session.failures = 0;
            session.retry_at = None;
        }
        result
    };
    if result.is_ok() && incoming.is_some() {
        notify_locked(app, origin);
    }
    result
}

fn rekey_entries(
    conn: &mut Connection,
    old_key: &[u8; 32],
    key: &[u8; 32],
    salt: &[u8; 16],
) -> Result<(), String> {
    let verifier = crypto::encrypt(key, crypto::VERIFIER_ID, crypto::VERIFIER)?;
    let tx = conn.transaction().map_err(|_| "vault.databaseFailed")?;
    let records = {
        let mut stmt = tx
            .prepare("SELECT id, encrypted_data FROM vault_entries")
            .map_err(|_| "vault.databaseFailed")?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|_| "vault.databaseFailed")?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| "vault.databaseFailed")?
    };
    for (id, encrypted) in records {
        let plaintext = crypto::decrypt(old_key, &id, &encrypted)?;
        tx.execute(
            "UPDATE vault_entries SET encrypted_data = ?1 WHERE id = ?2",
            params![crypto::encrypt(key, &id, &plaintext)?, id],
        )
        .map_err(|_| "vault.databaseFailed")?;
    }
    let count = tx
        .execute(
            "UPDATE vault_config SET salt = ?1, verifier = ?2 WHERE id = 1",
            params![STANDARD.encode(salt), verifier],
        )
        .map_err(|_| "vault.databaseFailed")?;
    if count != 1 {
        return Err("vault.notConfigured".into());
    }
    tx.commit().map_err(|_| "vault.databaseFailed".to_string())
}

fn read_entry(conn: &Connection, key: &[u8; 32], id: &str) -> Result<VaultEntry, String> {
    let encrypted: String = conn
        .query_row(
            "SELECT encrypted_data FROM vault_entries WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| "vault.databaseFailed")?
        .ok_or("vault.notFound")?;
    let plaintext = crypto::decrypt(key, id, &encrypted)?;
    let entry: VaultEntry = serde_json::from_slice(&plaintext).map_err(|_| "vault.invalidData")?;
    if entry.id != id {
        return Err("vault.invalidData".into());
    }
    Ok(entry)
}

fn save_entry(conn: &Connection, key: &[u8; 32], mut entry: VaultEntry) -> Result<String, String> {
    entry.validate()?;
    let now = chrono::Utc::now().to_rfc3339();
    if entry.id.is_empty() {
        entry.id = uuid::Uuid::new_v4().to_string();
        entry.created_at = now.clone();
    } else {
        uuid::Uuid::parse_str(&entry.id).map_err(|_| "vault.invalidData")?;
        entry.created_at = read_entry(conn, key, &entry.id)?.created_at;
    }
    entry.updated_at = now;
    let plaintext = Zeroizing::new(serde_json::to_vec(&entry).map_err(|_| "vault.invalidData")?);
    if plaintext.len() > 262144 {
        return Err("vault.tooMuchData".into());
    }
    let encrypted = crypto::encrypt(key, &entry.id, &plaintext)?;
    conn.execute("INSERT INTO vault_entries (id, encrypted_data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(id) DO UPDATE SET encrypted_data = excluded.encrypted_data, updated_at = excluded.updated_at",
        params![entry.id, encrypted, entry.created_at, entry.updated_at]).map_err(|_| "vault.databaseFailed")?;
    Ok(entry.id)
}

fn with_key<T>(
    app: &AppHandle,
    action: impl FnOnce(&[u8; 32]) -> Result<T, String>,
) -> Result<T, String> {
    let origin = storage_epoch(app);
    let state = app.state::<VaultState>();
    let mut session = state.session.lock().map_err(|_| "vault.locked")?;
    if !session.unlocked() {
        let was_open = session.key.is_some();
        session.lock();
        drop(session);
        if was_open {
            notify_locked(app, origin);
        }
        return Err("vault.locked".into());
    }
    session.activity = Some(Instant::now());
    action(session.key.as_ref().ok_or("vault.locked")?)
}

pub(crate) fn with_cleanup_access<T>(
    app: &AppHandle,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    with_key(app, |_| action())
}

fn notify_locked(app: &AppHandle, origin: u64) {
    // A copied credential remains available for the 30-second clipboard lease
    // so switching to the login window does not erase it before it can be pasted.
    let _ = crate::storage_events::emit_at(app, "vault-locked", (), origin);
}

pub fn lock_and_notify(app: &AppHandle) {
    let origin = storage_epoch(app);
    let Some(state) = app.try_state::<VaultState>() else {
        return;
    };
    if let Ok(mut session) = state.session.lock() {
        session.lock();
    }
    notify_locked(app, origin);
}

pub fn start_lock_worker(app: &AppHandle) -> Result<(), std::io::Error> {
    let app = app.clone();
    std::thread::Builder::new()
        .name("vault-lock-worker".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
            let Some(_producer) = lifecycle.try_producer() else { continue; };
            let origin = storage_epoch(&app);
            let state = app.state::<VaultState>();
            let should_lock = if let Ok(mut session) = state.session.lock() {
                if session.key.is_some() && !session.unlocked() {
                    session.lock();
                    true
                } else {
                    false
                }
            } else {
                false
            };
            if should_lock {
                notify_locked(&app, origin);
            }
        })
        .map(|_| ())
}

#[tauri::command]
pub fn get_vault_status(app: AppHandle) -> Result<VaultStatus, String> {
    refresh_auto_lock(&app)?;
    let configured = config(
        &*app
            .state::<DbState>()
            .conn
            .lock()
            .map_err(|_| "vault.databaseFailed")?,
    )?
    .is_some();
    let state = app.state::<VaultState>();
    let session = state.session.lock().map_err(|_| "vault.locked")?;
    Ok(VaultStatus {
        configured,
        unlocked: session.unlocked(),
        auto_lock: session.auto_lock,
    })
}

#[tauri::command]
pub async fn setup_vault(app: AppHandle, master_password: String, expected_storage_epoch: Option<u64>) -> Result<(), String> {
    let master_password = Zeroizing::new(master_password);
    let permit = crate::lifecycle::accept_async_operation(&app)?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let password = master_password;
        crypto::validate_master(&password)?;
        refresh_auto_lock(&app)?;
        let state = app.state::<VaultState>();
        let _operation = state.operation.lock().map_err(|_| "vault.locked")?;
        let epoch = state.session.lock().map_err(|_| "vault.locked")?.epoch;
        if config(
            &*app
                .state::<DbState>()
                .conn
                .lock()
                .map_err(|_| "vault.databaseFailed")?,
        )?
        .is_some()
        {
            return Err("vault.alreadyConfigured".into());
        }
        let salt = crypto::random_bytes::<16>()?;
        let key = crypto::derive_key(&password, &salt)?;
        let verifier = crypto::encrypt(&key, crypto::VERIFIER_ID, crypto::VERIFIER)?;
        let mut session = state.session.lock().map_err(|_| "vault.locked")?;
        if session.epoch != epoch {
            return Err("vault.locked".into());
        }
        app.state::<DbState>()
            .conn
            .lock()
            .map_err(|_| "vault.databaseFailed")?
            .execute(
                "INSERT INTO vault_config (id, version, salt, verifier) VALUES (1, 1, ?1, ?2)",
                params![STANDARD.encode(salt), verifier],
            )
            .map_err(|_| "vault.databaseFailed")?;
        session.key = Some(key);
        session.activity = Some(Instant::now());
        Ok(())
    })
    .await
    .map_err(|_| "vault.cryptoFailed")?
}

#[tauri::command]
pub async fn unlock_vault(app: AppHandle, master_password: String, expected_storage_epoch: Option<u64>) -> Result<(), String> {
    let master_password = Zeroizing::new(master_password);
    let permit = crate::lifecycle::accept_async_operation(&app)?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        refresh_auto_lock(&app)?;
        let password = master_password;
        let state = app.state::<VaultState>();
        let _operation = state.operation.lock().map_err(|_| "vault.locked")?;
        let epoch = {
            let session = state.session.lock().map_err(|_| "vault.locked")?;
            if session.retry_at.is_some_and(|time| time > Instant::now()) {
                return Err("vault.retryLater".into());
            }
            session.epoch
        };
        let (salt, verifier) = config(
            &*app
                .state::<DbState>()
                .conn
                .lock()
                .map_err(|_| "vault.databaseFailed")?,
        )?
        .ok_or("vault.notConfigured")?;
        let salt = STANDARD.decode(salt).map_err(|_| "vault.invalidData")?;
        let key = crypto::derive_key(&password, &salt)?;
        let valid = crypto::decrypt(&key, crypto::VERIFIER_ID, &verifier)
            .is_ok_and(|value| value.as_slice() == crypto::VERIFIER);
        let mut session = state.session.lock().map_err(|_| "vault.locked")?;
        if session.epoch != epoch {
            return Err("vault.locked".into());
        }
        if !valid {
            session.failures += 1;
            if session.failures >= 5 {
                session.retry_at = Some(Instant::now() + Duration::from_secs(30));
            }
            return Err("vault.wrongMaster".into());
        }
        session.failures = 0;
        session.retry_at = None;
        session.key = Some(key);
        session.activity = Some(Instant::now());
        Ok(())
    })
    .await
    .map_err(|_| "vault.cryptoFailed")?
}

#[tauri::command]
pub fn lock_vault(app: AppHandle, expected_storage_epoch: Option<u64>) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    lock_and_notify(&app);
    Ok(())
}

#[tauri::command]
pub fn touch_vault(app: AppHandle, expected_storage_epoch: Option<u64>) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    with_key(&app, |_| Ok(()))
}

#[tauri::command]
pub fn list_vault_entries(app: AppHandle, search: String, expected_storage_epoch: Option<u64>) -> Result<Vec<VaultSummary>, String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    if search.len() > 1024 {
        return Err("vault.tooMuchData".into());
    }
    with_key(&app, |key| {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|_| "vault.databaseFailed")?;
        let mut stmt = conn
            .prepare("SELECT id FROM vault_entries ORDER BY updated_at DESC")
            .map_err(|_| "vault.databaseFailed")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| "vault.databaseFailed")?;
        let mut entries = Vec::new();
        for id in ids {
            let entry = read_entry(&conn, key, &id.map_err(|_| "vault.databaseFailed")?)?;
            if entry.matches(&search) {
                entries.push(entry.summary());
            }
        }
        Ok(entries)
    })
}

#[tauri::command]
pub fn get_vault_entry(app: AppHandle, id: String, expected_storage_epoch: Option<u64>) -> Result<VaultEntry, String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    with_key(&app, |key| {
        let state = app.state::<DbState>();
        let conn = state.conn.lock().map_err(|_| "vault.databaseFailed")?;
        read_entry(&conn, key, &id)
    })
}

#[tauri::command]
pub fn save_vault_entry(app: AppHandle, entry: VaultEntry, expected_storage_epoch: Option<u64>) -> Result<String, String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    with_key(&app, |key| {
        save_entry(
            &*app
                .state::<DbState>()
                .conn
                .lock()
                .map_err(|_| "vault.databaseFailed")?,
            key,
            entry,
        )
    })
}

#[tauri::command]
pub fn delete_vault_entry(app: AppHandle, id: String, expected_storage_epoch: Option<u64>) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    with_key(&app, |_| {
        let count = app
            .state::<DbState>()
            .conn
            .lock()
            .map_err(|_| "vault.databaseFailed")?
            .execute("DELETE FROM vault_entries WHERE id = ?1", [id])
            .map_err(|_| "vault.databaseFailed")?;
        if count == 0 {
            return Err("vault.notFound".into());
        }
        Ok(())
    })
}

#[tauri::command]
pub fn generate_vault_password(options: crypto::PasswordOptions) -> Result<String, String> {
    crypto::generate(&options)
}

#[tauri::command]
pub fn copy_vault_field(app: AppHandle, id: String, field: String, expected_storage_epoch: Option<u64>) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    with_key(&app, |key| {
        let entry = read_entry(
            &*app
                .state::<DbState>()
                .conn
                .lock()
                .map_err(|_| "vault.databaseFailed")?,
            key,
            &id,
        )?;
        crate::paste::copy_sensitive_text(app.clone(), entry.field_value(&field)?.to_string())
    })
}

#[tauri::command]
pub async fn paste_vault_field(app: AppHandle, id: String, field: String, expected_storage_epoch: Option<u64>) -> Result<(), String> {
    let permit = crate::lifecycle::accept_async_operation(&app)?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        // Resolve the saved field under backend authorization. The frontend
        // sends only its IDs, never a plaintext value for the paste operation.
        let text = with_key(&app, |key| {
            let entry = read_entry(
                &*app
                    .state::<DbState>()
                    .conn
                    .lock()
                    .map_err(|_| "vault.databaseFailed")?,
                key,
                &id,
            )?;
            Ok(Zeroizing::new(entry.field_value(&field)?.to_string()))
        })?;
        crate::paste::paste_sensitive_text(app, text)
    })
    .await
    .map_err(|_| "vault.pasteFailed")?
}

#[tauri::command]
pub fn copy_vault_generated_password(app: AppHandle, password: String, expected_storage_epoch: Option<u64>) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    with_key(&app, |_| {
        if !(12..=128).contains(&password.len()) {
            return Err("vault.passwordLength".into());
        }
        crate::paste::copy_sensitive_text(app.clone(), password)
    })
}

#[tauri::command]
pub fn copy_vault_text(app: AppHandle, text: String, expected_storage_epoch: Option<u64>) -> Result<(), String> {
    let lifecycle = app.state::<crate::lifecycle::LifecycleState>();
    let _producer = lifecycle.try_producer().ok_or("lifecycle.busy")?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    with_key(&app, |_| {
        if text.is_empty() || text.len() > 65536 {
            return Err("vault.tooMuchData".into());
        }
        crate::paste::copy_sensitive_text(app.clone(), text)
    })
}

#[tauri::command]
pub async fn change_vault_master(
    app: AppHandle,
    current_password: String,
    new_password: String, expected_storage_epoch: Option<u64>) -> Result<(), String> {
    let current_password = Zeroizing::new(current_password);
    let new_password = Zeroizing::new(new_password);
    let permit = crate::lifecycle::accept_async_operation(&app)?;
    crate::db::require_storage_epoch(&app, expected_storage_epoch)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let current = current_password;
        let next = new_password;
        crypto::validate_master(&next)?;
        let state = app.state::<VaultState>();
        let _operation = state.operation.lock().map_err(|_| "vault.locked")?;
        let epoch = {
            let session = state.session.lock().map_err(|_| "vault.locked")?;
            if !session.unlocked() {
                return Err("vault.locked".into());
            }
            session.epoch
        };
        let (old_salt, verifier) = config(
            &*app
                .state::<DbState>()
                .conn
                .lock()
                .map_err(|_| "vault.databaseFailed")?,
        )?
        .ok_or("vault.notConfigured")?;
        let old_key = crypto::derive_key(
            &current,
            &STANDARD.decode(old_salt).map_err(|_| "vault.invalidData")?,
        )?;
        if !crypto::decrypt(&old_key, crypto::VERIFIER_ID, &verifier)
            .is_ok_and(|value| value.as_slice() == crypto::VERIFIER)
        {
            return Err("vault.wrongMaster".into());
        }
        let salt = crypto::random_bytes::<16>()?;
        let key = crypto::derive_key(&next, &salt)?;
        let mut session = state.session.lock().map_err(|_| "vault.locked")?;
        if session.epoch != epoch || !session.unlocked() {
            return Err("vault.locked".into());
        }
        let db = app.state::<DbState>();
        let mut conn = db.conn.lock().map_err(|_| "vault.databaseFailed")?;
        rekey_entries(&mut conn, &old_key, &key, &salt)?;
        session.key = Some(key);
        session.activity = Some(Instant::now());
        Ok(())
    })
    .await
    .map_err(|_| "vault.cryptoFailed")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_multiple_accounts_encrypted_and_preserves_custom_data() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        init_schema(&conn).unwrap();
        let key = [11; 32];
        let first = VaultEntry {
            title: "GitHub 工作".into(),
            website: "github.com".into(),
            username: "work-user".into(),
            email: "work@example.com".into(),
            phone: "13800000000".into(),
            password: "a-password-that-must-stay-secret".into(),
            fields: vec![VaultField {
                label: "姓名".into(),
                value: "张三".into(),
                ..Default::default()
            }],
            verification: vec![VerificationMethod {
                kind: "recovery_codes".into(),
                label: "恢复码".into(),
                value: "recovery-private".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let id = save_entry(&conn, &key, first.clone()).unwrap();
        let other_id = save_entry(
            &conn,
            &key,
            VaultEntry {
                username: "personal-user".into(),
                ..first
            },
        )
        .unwrap();
        assert_ne!(id, other_id);
        let encrypted: String = conn
            .query_row(
                "SELECT encrypted_data FROM vault_entries WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        for sensitive in [
            "github.com",
            "work@example.com",
            "recovery-private",
            "a-password-that-must-stay-secret",
            "张三",
        ] {
            assert!(!encrypted.contains(sensitive));
        }
        let mut entry = read_entry(&conn, &key, &id).unwrap();
        assert!(entry.matches("github work"));
        assert!(entry.matches("13800000000"));
        assert!(entry.matches("张三"));
        assert!(!entry.matches("recovery-private"));
        assert!(!entry.matches("a-password-that-must-stay-secret"));
        assert_eq!(entry.website, "https://github.com/");
        assert_eq!(entry.fields[0].value, "张三");
        let created_at = entry.created_at.clone();
        entry.username = "updated-user".into();
        save_entry(&conn, &key, entry).unwrap();
        let updated = read_entry(&conn, &key, &id).unwrap();
        assert_eq!(updated.created_at, created_at);
        assert_eq!(updated.username, "updated-user");
        assert_eq!(
            updated.field_value("verification:").unwrap_err(),
            "vault.notFound"
        );
        assert!(read_entry(&conn, &[12; 32], &id).is_err());
    }

    #[test]
    fn rejects_unsafe_websites_and_ambiguous_custom_fields() {
        let mut entry = VaultEntry {
            title: "site".into(),
            website: "javascript://example.com".into(),
            ..Default::default()
        };
        assert!(entry.validate().is_err());
        entry.website = "https://username:password@example.com".into();
        assert!(entry.validate().is_err());
        entry.website.clear();
        entry.fields = vec![
            VaultField {
                id: "duplicate".into(),
                label: "a".into(),
                ..Default::default()
            },
            VaultField {
                id: "duplicate".into(),
                label: "b".into(),
                ..Default::default()
            },
        ];
        assert!(entry.validate().is_err());
    }

    #[test]
    fn session_expires_and_lock_discards_the_key() {
        let mut session = Session::default();
        assert!(!session.unlocked());
        session.key = Some(Zeroizing::new([9; 32]));
        session.activity = Some(Instant::now());
        assert!(session.unlocked());
        session.activity = Some(Instant::now() - Duration::from_secs(3 * 60 * 60));
        assert!(!session.unlocked());
        session.lock();
        assert!(session.key.is_none());
        assert_eq!(session.epoch, 1);
    }

    #[test]
    fn auto_lock_policies_apply_at_the_selected_idle_boundary() {
        for (policy, seconds) in [(AutoLock::After3Hours, 3 * 60 * 60), (AutoLock::After24Hours, 24 * 60 * 60)] {
            let mut session = Session { key: Some(Zeroizing::new([9; 32])), auto_lock: policy, ..Default::default() };
            session.activity = Some(Instant::now() - Duration::from_secs(seconds - 1));
            assert!(session.unlocked());
            session.activity = Some(Instant::now() - Duration::from_secs(seconds));
            assert!(!session.unlocked());
            // Activity resets the idle timeout.
            session.activity = Some(Instant::now());
            assert!(session.unlocked());
        }
    }

    #[test]
    fn untimed_policies_keep_the_session_open_until_manual_lock() {
        for policy in [AutoLock::Never, AutoLock::OnStartup] {
            let mut session = Session { auto_lock: policy, ..Default::default() };
            // A new app session always starts locked.
            assert!(!session.unlocked());
            session.key = Some(Zeroizing::new([9; 32]));
            session.activity = Some(Instant::now() - Duration::from_secs(48 * 60 * 60));
            assert!(session.unlocked());
            session.lock();
            assert!(!session.unlocked());
            assert!(session.key.is_none());
        }
    }

    #[test]
    fn shorter_policy_expires_an_existing_idle_session() {
        let mut session = Session {
            key: Some(Zeroizing::new([9; 32])),
            activity: Some(Instant::now() - Duration::from_secs(4 * 60 * 60)),
            auto_lock: AutoLock::After24Hours,
            ..Default::default()
        };
        assert!(session.unlocked());
        session.auto_lock = AutoLock::After3Hours;
        assert!(!session.unlocked());
    }

    #[test]
    fn master_rotation_preserves_records_and_rolls_back_on_corruption() {
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        let old_key = [3; 32];
        let next_key = [5; 32];
        let next_salt = [7; 16];
        conn.execute(
            "INSERT INTO vault_config VALUES (1, 1, ?1, ?2)",
            params![
                STANDARD.encode([1; 16]),
                crypto::encrypt(&old_key, crypto::VERIFIER_ID, crypto::VERIFIER).unwrap()
            ],
        )
        .unwrap();
        let id = save_entry(
            &conn,
            &old_key,
            VaultEntry {
                title: "Example".into(),
                password: "secret".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let original = read_entry(&conn, &old_key, &id).unwrap();
        rekey_entries(&mut conn, &old_key, &next_key, &next_salt).unwrap();
        assert!(read_entry(&conn, &old_key, &id).is_err());
        let rotated = read_entry(&conn, &next_key, &id).unwrap();
        assert_eq!(rotated.password, original.password);
        assert_eq!(rotated.created_at, original.created_at);
        assert_eq!(rotated.updated_at, original.updated_at);
        let (salt, verifier) = config(&conn).unwrap().unwrap();
        assert_eq!(salt, STANDARD.encode(next_salt));
        assert_eq!(
            &*crypto::decrypt(&next_key, crypto::VERIFIER_ID, &verifier).unwrap(),
            crypto::VERIFIER
        );

        conn.execute(
            "INSERT INTO vault_entries VALUES ('corrupt', 'invalid', '', '')",
            [],
        )
        .unwrap();
        let before: String = conn
            .query_row(
                "SELECT encrypted_data FROM vault_entries WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(rekey_entries(&mut conn, &next_key, &[9; 32], &[11; 16]).is_err());
        let after: String = conn
            .query_row(
                "SELECT encrypted_data FROM vault_entries WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(config(&conn).unwrap().unwrap(), (salt, verifier));
        assert_eq!(
            read_entry(&conn, &next_key, &id).unwrap().password,
            "secret"
        );
    }

    #[test]
    fn missing_configuration_does_not_allow_overwriting_existing_vault() {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        assert!(config(&conn).unwrap().is_none());
        save_entry(
            &conn,
            &[3; 32],
            VaultEntry {
                title: "Existing account".into(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(config(&conn).unwrap_err(), "vault.invalidData");
    }

    #[test]
    fn storage_move_preserves_ciphertext_and_rejects_an_existing_vault() {
        let source = Connection::open_in_memory().unwrap();
        let mut destination = Connection::open_in_memory().unwrap();
        init_schema(&source).unwrap();
        init_schema(&destination).unwrap();
        let key = [17; 32];
        let verifier = crypto::encrypt(&key, crypto::VERIFIER_ID, crypto::VERIFIER).unwrap();
        source
            .execute(
                "INSERT INTO vault_config VALUES (1, 1, ?1, ?2)",
                params![STANDARD.encode([5; 16]), verifier],
            )
            .unwrap();
        let id = save_entry(
            &source,
            &key,
            VaultEntry {
                title: "Migration account".into(),
                password: "migration-secret".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let original: String = source
            .query_row(
                "SELECT encrypted_data FROM vault_entries WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        copy_encrypted_storage(&source, &mut destination).unwrap();
        let moved: String = destination
            .query_row(
                "SELECT encrypted_data FROM vault_entries WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(moved, original);
        assert_eq!(
            read_entry(&destination, &key, &id).unwrap().password,
            "migration-secret"
        );
        assert_eq!(config(&source).unwrap(), config(&destination).unwrap());
        assert_eq!(
            copy_encrypted_storage(&source, &mut destination).unwrap_err(),
            "vault.storageConflict"
        );
        assert_eq!(
            read_entry(&source, &key, &id).unwrap().password,
            "migration-secret"
        );
    }

    #[test]
    fn failed_storage_move_rolls_back_configuration_and_records() {
        let source = Connection::open_in_memory().unwrap();
        let mut destination = Connection::open_in_memory().unwrap();
        init_schema(&source).unwrap();
        init_schema(&destination).unwrap();
        let key = [19; 32];
        source
            .execute(
                "INSERT INTO vault_config VALUES (1, 1, ?1, ?2)",
                params![
                    STANDARD.encode([7; 16]),
                    crypto::encrypt(&key, crypto::VERIFIER_ID, crypto::VERIFIER).unwrap()
                ],
            )
            .unwrap();
        save_entry(
            &source,
            &key,
            VaultEntry {
                title: "Existing".into(),
                ..Default::default()
            },
        )
        .unwrap();
        destination.execute_batch("CREATE TRIGGER fail_vault_insert BEFORE INSERT ON vault_entries BEGIN SELECT RAISE(ABORT, 'test failure'); END;").unwrap();
        assert!(copy_encrypted_storage(&source, &mut destination).is_err());
        assert!(config(&destination).unwrap().is_none());
        assert!(config(&source).unwrap().is_some());
    }
}
