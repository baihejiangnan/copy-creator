//! Versioned, encrypted identity/entry payloads. No plaintext relationship index.
use super::*;
use std::collections::{HashMap, HashSet};

impl VaultEntry {
    pub(super) fn supported(&self) -> Result<(), String> {
        if self.payload_version.is_some_and(|version| version != 2) {
            return Err("vault.invalidData".into());
        }
        if self.payload_version.is_none()
            && (!self.kind.is_empty()
                || !self.template.is_empty()
                || !self.identity_ids.is_empty()
                || !self.summary_field_id.is_empty()
                || !self.login_method.is_empty()
                || !self.login_note.is_empty())
        {
            return Err("vault.invalidData".into());
        }
        Ok(())
    }

    /// A read-only adapter. Existing ciphertext, record IDs and timestamps stay intact.
    pub(super) fn unified(&self) -> Self {
        if self.payload_version == Some(2) {
            return self.clone();
        }
        let mut entry = self.clone();
        entry.payload_version = Some(2);
        entry.kind = "entry".into();
        entry.template = "login".into();
        entry.identity_ids.clear();
        let mut fields = Vec::new();
        let mut ids: HashSet<String> = self.fields.iter().map(|field| field.id.clone()).collect();
        let mut add =
            |key: &str, label: &str, value: &str, kind: &str, sensitive: bool, purpose: &str| {
                let mut id = format!("legacy:{key}");
                while !ids.insert(id.clone()) {
                    id.push(':');
                }
                fields.push(VaultField {
                    id,
                    label: label.into(),
                    value: value.into(),
                    sensitive,
                    field_type: kind.into(),
                    purpose: purpose.into(),
                });
            };
        for (key, label, value, kind, sensitive) in [
            ("website", "Website", &self.website, "url", false),
            ("username", "Username", &self.username, "text", false),
            ("email", "Email", &self.email, "text", false),
            ("phone", "Phone", &self.phone, "text", false),
            ("password", "Password", &self.password, "secret", true),
        ] {
            if !value.is_empty() {
                add(key, label, value, kind, sensitive, &format!("legacy_base:{key}"));
            }
        }
        for method in &self.verification {
            add(
                &format!("verification:{}", method.id),
                &method.label,
                &method.value,
                "multiline",
                !matches!(
                    method.kind.as_str(),
                    "email" | "sms" | "passkey" | "authenticator"
                ),
                &method.kind,
            );
            // Verification explanations may contain recovery information as well.
            if !method.note.is_empty() {
                add(
                    &format!("verification-note:{}", method.id),
                    &method.label,
                    &method.note,
                    "multiline",
                    true,
                    &format!("{}_note", method.kind),
                );
            }
        }
        if !self.notes.is_empty() {
            add("notes", "Notes", &self.notes, "multiline", false, "");
        }
        let position = [
            &self.website,
            &self.username,
            &self.email,
            &self.phone,
            &self.password,
        ]
        .iter()
        .filter(|value| !value.is_empty())
        .count();
        fields.splice(
            position..position,
            self.fields.iter().cloned().map(|mut field| {
                if field.field_type.is_empty() {
                    field.field_type = "multiline".into();
                }
                field
            }),
        );
        entry.fields = fields;
        entry.website.clear();
        entry.username.clear();
        entry.email.clear();
        entry.phone.clear();
        entry.password.clear();
        entry.notes.clear();
        entry.verification.clear();
        entry
    }

    pub(super) fn validate_v2(&mut self) -> Result<(), String> {
        self.supported()?;
        self.title = self.title.trim().to_string();
        if self.title.is_empty() || self.title.chars().count() > 120 {
            return Err("vault.titleRequired".into());
        }
        if !matches!(self.kind.as_str(), "entry" | "identity")
            || self.template.len() > 80
            || !self.verification.is_empty()
            || [
                &self.website,
                &self.username,
                &self.email,
                &self.phone,
                &self.password,
                &self.notes,
            ]
            .iter()
            .any(|text| !text.is_empty())
        {
            return Err("vault.invalidData".into());
        }
        if self.fields.len() > 256
            || self.tags.len() > 20
            || self.identity_ids.len() > 128
            || self.tags.iter().any(|tag| tag.chars().count() > 40)
            || self.login_note.chars().count() > 200
        {
            return Err("vault.tooMuchData".into());
        }
        if self.kind == "identity" && !self.identity_ids.is_empty() {
            return Err("vault.invalidIdentity".into());
        }
        if !matches!(
            self.login_method.as_str(),
            "" | "password" | "email_code" | "sms_code" | "sso" | "other"
        ) {
            return Err("vault.invalidData".into());
        }
        let mut ids = HashSet::new();
        for field in &mut self.fields {
            field.label = field.label.trim().to_string();
            if field.id.is_empty() {
                field.id = uuid::Uuid::new_v4().to_string();
            }
            if field.id.len() > 256
                || !ids.insert(field.id.clone())
                || field.label.is_empty()
                || field.label.chars().count() > 80
                || field.value.len() > 16384
                || field.purpose.len() > 80
                || !matches!(
                    field.field_type.as_str(),
                    "text" | "secret" | "url" | "multiline"
                )
            {
                return Err("vault.invalidField".into());
            }
            if field.field_type == "url" && !field.value.is_empty() {
                let value = if field.value.contains("://") {
                    field.value.clone()
                } else {
                    format!("https://{}", field.value)
                };
                let url = reqwest::Url::parse(&value).map_err(|_| "vault.invalidWebsite")?;
                if !matches!(url.scheme(), "http" | "https")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || value.len() > 2048
                {
                    return Err("vault.invalidWebsite".into());
                }
                field.value = url.to_string();
            }
        }
        ids.clear();
        if self.identity_ids.iter().any(|id| {
            uuid::Uuid::parse_str(id).is_err() || !ids.insert(id.clone()) || id == &self.id
        }) {
            return Err("vault.invalidIdentity".into());
        }
        if !self
            .fields
            .iter()
            .any(|field| field.id == self.summary_field_id && !field.sensitive)
        {
            self.summary_field_id.clear();
        }
        self.tags = self
            .tags
            .iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty())
            .collect();
        Ok(())
    }

    pub(super) fn v2_summary(&self) -> VaultSummary {
        let entry = self.unified();
        let value = entry
            .fields
            .iter()
            .find(|field| {
                field.id == entry.summary_field_id && !field.sensitive && !field.value.is_empty()
            })
            .or_else(|| {
                entry
                    .fields
                    .iter()
                    .find(|field| !field.sensitive && !field.value.is_empty())
            });
        VaultSummary {
            id: entry.id,
            title: entry.title,
            website: self.website.clone(),
            username: self.username.clone(),
            email: self.email.clone(),
            tags: entry.tags,
            has_password: entry
                .fields
                .iter()
                .any(|field| field.sensitive && !field.value.is_empty()),
            verification_count: self.verification.len(),
            updated_at: entry.updated_at,
            summary: value
                .map(|field| {
                    field
                        .value
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(100)
                        .collect()
                })
                .unwrap_or_default(),
            kind: entry.kind,
            template: entry.template,
            identity_ids: entry.identity_ids,
            related_count: 0,
        }
    }
}

#[derive(Serialize)]
pub struct VaultPage {
    pub entries: Vec<VaultSummary>,
    pub total: usize,
    pub identity_total: usize,
    pub detail_total: usize,
    pub independent_total: usize,
}

pub(super) fn query_entries(
    conn: &Connection,
    key: &[u8; 32],
    search: &str,
    kind: &str,
    identity: &str,
    offset: usize,
) -> Result<VaultPage, String> {
    if search.len() > 1024 || !matches!(kind, "identity" | "entry" | "") || offset > 100_000 {
        return Err("vault.tooMuchData".into());
    }
    let mut page = VaultPage {
        entries: Vec::new(),
        total: 0,
        identity_total: 0,
        detail_total: 0,
        independent_total: 0,
    };
    let mut stmt = conn
        .prepare("SELECT id FROM vault_entries ORDER BY updated_at DESC, id")
        .map_err(|_| "vault.databaseFailed")?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| "vault.databaseFailed")?;
    for id in ids {
        let entry = read_entry(conn, key, &id.map_err(|_| "vault.databaseFailed")?)?.unified();
        if entry.kind == "identity" {
            page.identity_total += 1;
        } else {
            page.detail_total += 1;
            if entry.identity_ids.is_empty() {
                page.independent_total += 1;
            }
        }
        if (!kind.is_empty() && entry.kind != kind)
            || (!identity.is_empty()
                && if identity == "independent" {
                    !entry.identity_ids.is_empty()
                } else {
                    !entry.identity_ids.iter().any(|id| id == identity)
                })
            || !entry.matches(search)
        {
            continue;
        }
        if page.total >= offset && page.entries.len() < 50 {
            page.entries.push(entry.summary());
        }
        page.total += 1;
    }
    if kind == "identity" && !page.entries.is_empty() {
        let mut counts: HashMap<String, usize> = page
            .entries
            .iter()
            .map(|entry| (entry.id.clone(), 0))
            .collect();
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| "vault.databaseFailed")?;
        for id in ids {
            let entry = read_entry(conn, key, &id.map_err(|_| "vault.databaseFailed")?)?;
            for id in &entry.identity_ids {
                if let Some(count) = counts.get_mut(id) {
                    *count += 1;
                }
            }
        }
        for entry in &mut page.entries {
            entry.related_count = counts[&entry.id];
        }
    }
    Ok(page)
}

pub(super) fn delete_entry(conn: &Connection, key: &[u8; 32], id: &str) -> Result<(), String> {
    let target = read_entry(conn, key, id)?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|_| "vault.databaseFailed")?;
    if target.kind == "identity" {
        let ids = {
            let mut stmt = tx
                .prepare("SELECT id FROM vault_entries WHERE id != ?1")
                .map_err(|_| "vault.databaseFailed")?;
            let rows = stmt
                .query_map([id], |row| row.get::<_, String>(0))
                .map_err(|_| "vault.databaseFailed")?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(|_| "vault.databaseFailed")?
        };
        for entry_id in ids {
            let mut entry = read_entry(&tx, key, &entry_id)?;
            if entry.identity_ids.iter().any(|link| link == id) {
                entry.identity_ids.retain(|link| link != id);
                write_entry(&tx, key, entry)?;
            }
        }
    }
    tx.execute("DELETE FROM vault_entries WHERE id = ?1", [id])
        .map_err(|_| "vault.databaseFailed")?;
    tx.commit().map_err(|_| "vault.databaseFailed".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO vault_config VALUES (1,1,?1,?2)",
            params![
                STANDARD.encode([7; 16]),
                crypto::encrypt(&[11; 32], crypto::VERIFIER_ID, crypto::VERIFIER).unwrap()
            ],
        )
        .unwrap();
        conn
    }
    fn entry(kind: &str) -> VaultEntry {
        VaultEntry {
            payload_version: Some(2),
            kind: kind.into(),
            title: kind.into(),
            template: "custom".into(),
            fields: vec![
                VaultField {
                    id: "address".into(),
                    label: "IP".into(),
                    value: " 2001:db8::24 ".into(),
                    field_type: "text".into(),
                    ..Default::default()
                },
                VaultField {
                    id: "secret".into(),
                    label: "Password".into(),
                    value: "DEMO-ONLY\n  preserve spaces ".into(),
                    sensitive: true,
                    field_type: "secret".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }
    #[test]
    fn v2_encryption_promotion_raw_values_and_conflict() {
        let conn = database();
        let key = [11; 32];
        let id = save_entry(&conn, &key, entry("entry")).unwrap();
        assert_eq!(snapshot_backup(&conn).unwrap().unwrap().version, 2);
        let original = read_entry(&conn, &key, &id).unwrap();
        assert_eq!(
            original.field_value("field:address").unwrap(),
            " 2001:db8::24 "
        );
        assert_eq!(
            original.field_value("field:secret").unwrap(),
            "DEMO-ONLY\n  preserve spaces "
        );
        assert!(!original.matches("DEMO-ONLY"));
        assert!(!original.summary().summary.contains("DEMO"));
        let cipher: String = conn
            .query_row("SELECT encrypted_data FROM vault_entries", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(!cipher.contains("2001:db8"));
        let mut changed = original.clone();
        changed.title = "updated".into();
        save_entry(&conn, &key, changed).unwrap();
        assert_eq!(
            save_entry(&conn, &key, original).unwrap_err(),
            "vault.conflict"
        );
    }
    #[test]
    fn stable_creation_identity_replays_without_duplicates_or_stale_overwrites() {
        let conn = database();
        let key = [11; 32];
        let mut draft = entry("entry");
        draft.id = uuid::Uuid::new_v4().to_string();
        let id = save_entry(&conn, &key, draft.clone()).unwrap();
        let first = read_entry(&conn, &key, &id).unwrap();
        assert_eq!(save_entry(&conn, &key, draft.clone()).unwrap(), id);
        assert_eq!(
            read_entry(&conn, &key, &id).unwrap().updated_at,
            first.updated_at
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM vault_entries", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        let mut changed = first;
        changed.title = "newer".into();
        save_entry(&conn, &key, changed).unwrap();
        assert_eq!(
            save_entry(&conn, &key, draft).unwrap_err(),
            "vault.conflict"
        );
        assert_eq!(read_entry(&conn, &key, &id).unwrap().title, "newer");
    }
    #[test]
    fn invalid_write_rolls_back_version_and_identity_links() {
        let conn = database();
        let mut value = entry("entry");
        value.identity_ids.push(uuid::Uuid::new_v4().to_string());
        assert!(save_entry(&conn, &[11; 32], value).is_err());
        assert_eq!(snapshot_backup(&conn).unwrap().unwrap().version, 1);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM vault_entries", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        conn.execute_batch("CREATE TRIGGER reject_write BEFORE INSERT ON vault_entries BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(save_entry(&conn, &[11; 32], entry("entry")).is_err());
        assert_eq!(snapshot_backup(&conn).unwrap().unwrap().version, 1);
    }
    #[test]
    fn identity_deletion_preserves_fields_and_other_identity() {
        let conn = database();
        let key = [11; 32];
        let first = save_entry(&conn, &key, entry("identity")).unwrap();
        let second = save_entry(&conn, &key, entry("identity")).unwrap();
        let mut service = entry("entry");
        service.identity_ids = vec![first.clone(), second.clone()];
        let id = save_entry(&conn, &key, service).unwrap();
        let before = read_entry(&conn, &key, &id).unwrap();
        delete_entry(&conn, &key, &first).unwrap();
        let after = read_entry(&conn, &key, &id).unwrap();
        assert_eq!(after.identity_ids, vec![second]);
        assert_eq!(after.fields[1].value, before.fields[1].value);
        delete_entry(&conn, &key, &after.identity_ids[0]).unwrap();
        assert!(read_entry(&conn, &key, &id)
            .unwrap()
            .identity_ids
            .is_empty());
    }
    #[test]
    fn identity_deletion_failure_is_atomic() {
        let conn = database();
        let key = [11; 32];
        let identity = save_entry(&conn, &key, entry("identity")).unwrap();
        let mut service = entry("entry");
        service.identity_ids = vec![identity.clone()];
        let id = save_entry(&conn, &key, service).unwrap();
        conn.execute_batch("CREATE TRIGGER reject_delete BEFORE DELETE ON vault_entries BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(delete_entry(&conn, &key, &identity).is_err());
        assert_eq!(
            read_entry(&conn, &key, &id).unwrap().identity_ids,
            vec![identity.clone()]
        );
        assert!(read_entry(&conn, &key, &identity).is_ok());
    }
    #[test]
    fn legacy_adapter_preserves_verification_notes_and_collisions() {
        let old = VaultEntry {
            title: "legacy".into(),
            username: "user".into(),
            password: "legacy-secret".into(),
            notes: "line1\n  line2".into(),
            fields: vec![VaultField {
                id: "legacy:username".into(),
                label: "Custom".into(),
                value: "keep".into(),
                ..Default::default()
            }],
            verification: vec![VerificationMethod {
                id: "recovery".into(),
                kind: "recovery_codes".into(),
                label: "Recovery".into(),
                value: "code".into(),
                note: "private note".into(),
            }],
            ..Default::default()
        };
        let converted = old.unified();
        assert_eq!(converted.fields.len(), 6);
        assert!(converted.identity_ids.is_empty());
        assert_eq!(
            converted
                .fields
                .iter()
                .map(|f| &f.id)
                .collect::<HashSet<_>>()
                .len(),
            6
        );
        assert_eq!(
            serde_json::to_string(&converted).unwrap(),
            serde_json::to_string(&old.unified()).unwrap()
        );
        for f in &converted.fields {
            assert_eq!(
                old.field_value(&format!("field:{}", f.id)).unwrap(),
                f.value
            );
        }
        assert!(!converted.matches("private note"));
        assert!(converted.fields.iter().any(|f| f.value == "line1\n  line2"));
        assert_eq!(
            converted
                .fields
                .iter()
                .find(|f| f.value == "private note")
                .unwrap()
                .purpose,
            "recovery_codes_note"
        );
        let mut blank = VaultEntry {
            title: "legacy empty verification".into(),
            verification: vec![VerificationMethod {
                id: "method".into(),
                kind: "authenticator".into(),
                label: "x".repeat(80),
                value: String::new(),
                note: "device note".into(),
            }],
            ..Default::default()
        }
        .unified();
        assert_eq!(blank.fields.len(), 2);
        assert_eq!(blank.fields[0].purpose, "authenticator");
        assert_eq!(blank.fields[1].label.chars().count(), 80);
        blank.validate().unwrap();
    }
    #[test]
    fn paging_filters_and_counts_are_bounded_and_secret_free() {
        let conn = database();
        let key = [11; 32];
        let identity = save_entry(&conn, &key, entry("identity")).unwrap();
        for _ in 0..53 {
            let mut service = entry("entry");
            service.identity_ids = vec![identity.clone()];
            save_entry(&conn, &key, service).unwrap();
        }
        save_entry(&conn, &key, entry("entry")).unwrap();
        let page = query_entries(&conn, &key, "", "entry", &identity, 0).unwrap();
        assert_eq!(page.total, 53);
        assert_eq!(page.entries.len(), 50);
        assert_eq!(
            query_entries(&conn, &key, "", "entry", &identity, 50)
                .unwrap()
                .entries
                .len(),
            3
        );
        let identities = query_entries(&conn, &key, "", "identity", "", 0).unwrap();
        assert_eq!(identities.entries[0].related_count, 53);
        assert_eq!(identities.independent_total, 1);
        assert_eq!(
            query_entries(&conn, &key, "DEMO-ONLY", "entry", "", 0)
                .unwrap()
                .total,
            0
        );
    }
    #[test]
    fn unknown_versions_hidden_legacy_values_and_invalid_links_rejected() {
        let mut value = entry("entry");
        value.payload_version = Some(3);
        assert!(value.validate().is_err());
        value.payload_version = Some(2);
        value.password = "hidden".into();
        assert!(value.validate().is_err());
        value.password.clear();
        value.kind = "identity".into();
        value.identity_ids = vec![uuid::Uuid::new_v4().to_string()];
        assert!(value.validate().is_err());
        let mut old = VaultEntry::default();
        old.kind = "identity".into();
        assert!(old.validate().is_err());
    }
    #[test]
    fn backup_move_rotation_and_conflict_preserve_version_and_relationships() {
        let mut conn = database();
        let key = [11; 32];
        let identity = save_entry(&conn, &key, entry("identity")).unwrap();
        let mut service = entry("entry");
        service.identity_ids = vec![identity];
        let id = save_entry(&conn, &key, service).unwrap();
        let backup = snapshot_backup(&conn).unwrap().unwrap();
        let plan = prepare_backup_import(None, Some(&backup), "", "").unwrap();
        let destination = Connection::open_in_memory().unwrap();
        init_schema(&destination).unwrap();
        let tx = destination.unchecked_transaction().unwrap();
        apply_backup_import(&tx, &plan).unwrap();
        tx.commit().unwrap();
        assert_eq!(
            read_entry(&destination, &key, &id)
                .unwrap()
                .identity_ids
                .len(),
            1
        );
        assert_eq!(snapshot_backup(&destination).unwrap().unwrap().version, 2);
        let mut moved = Connection::open_in_memory().unwrap();
        init_schema(&moved).unwrap();
        copy_encrypted_storage(&destination, &mut moved).unwrap();
        assert_eq!(snapshot_backup(&moved).unwrap().unwrap().version, 2);
        rekey_entries(&mut conn, &key, &[12; 32], &[8; 16]).unwrap();
        assert_eq!(
            read_entry(&conn, &[12; 32], &id)
                .unwrap()
                .identity_ids
                .len(),
            1
        );
        assert_eq!(snapshot_backup(&conn).unwrap().unwrap().version, 2);
    }
    #[test]
    fn different_master_v2_merge_is_repeatable_and_conflicting_ids_are_atomic() {
        let source = database();
        let key = [11; 32];
        let identity = save_entry(&source, &key, entry("identity")).unwrap();
        let mut service = entry("entry");
        service.identity_ids = vec![identity];
        let id = save_entry(&source, &key, service).unwrap();
        // Use real KDF/verifiers for the cross-master merge path.
        let password = "Synthetic source master";
        let salt = [7; 16];
        let derived = crypto::derive_key(password, &salt).unwrap();
        let mut source = source;
        rekey_entries(&mut source, &key, &derived, &salt).unwrap();
        let backup = snapshot_backup(&source).unwrap().unwrap();
        assert_eq!(backup.version, 2);
        let current_password = "Synthetic target master";
        let current_salt = [8; 16];
        let current_key = crypto::derive_key(current_password, &current_salt).unwrap();
        let destination = database();
        destination
            .execute(
                "UPDATE vault_config SET salt=?1,verifier=?2",
                params![
                    STANDARD.encode(current_salt),
                    crypto::encrypt(&current_key, crypto::VERIFIER_ID, crypto::VERIFIER).unwrap()
                ],
            )
            .unwrap();
        let current = config(&destination).unwrap();
        for expected in [(2, 0), (0, 2)] {
            let plan =
                prepare_backup_import(current.clone(), Some(&backup), current_password, password)
                    .unwrap();
            let tx = destination.unchecked_transaction().unwrap();
            assert_eq!(apply_backup_import(&tx, &plan).unwrap(), expected);
            tx.commit().unwrap();
        }
        let mut changed = read_entry(&destination, &current_key, &id).unwrap();
        changed.title = "locally changed".into();
        save_entry(&destination, &current_key, changed).unwrap();
        let plan =
            prepare_backup_import(current, Some(&backup), current_password, password).unwrap();
        let tx = destination.unchecked_transaction().unwrap();
        assert_eq!(
            apply_backup_import(&tx, &plan).unwrap_err(),
            "backup.vaultIdConflict"
        );
        drop(tx);
        assert_eq!(
            read_entry(&destination, &current_key, &id).unwrap().title,
            "locally changed"
        );
    }
}
