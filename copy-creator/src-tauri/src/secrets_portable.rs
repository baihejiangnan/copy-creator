//! The OS store holds random data keys; SQLite holds only authenticated ciphertext.
//! Keys are immutable UUID entries. A public marker selects the current write key.
//! Missing keys are never replaced: old ciphertext must remain recoverable.
use fs2::FileExt;
use std::{
    fs::{self, OpenOptions},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

const PREFIX: &str = "oskey:v1:";
const ERROR: &str = "secrets.unavailable";

trait KeyStore: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<Zeroizing<[u8; 32]>>, String>;
    fn set(&self, id: &str, key: &[u8; 32]) -> Result<(), String>;
    fn remove(&self, id: &str);
}

struct Context<S> {
    identifier: String,
    directory: PathBuf,
    store: S,
    serial: Mutex<()>,
}
impl<S: KeyStore> Context<S> {
    fn aad(&self, id: &str) -> String {
        format!("copy-creator/local-secret/v1/{}/{id}", self.identifier)
    }

    fn protect(&self, value: &str) -> Result<String, String> {
        let _serial = self.serial.lock().map_err(|_| ERROR)?;
        fs::create_dir_all(&self.directory).map_err(|_| ERROR)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options
            .open(self.directory.join("local-secret.lock"))
            .map_err(|_| ERROR)?;
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match lock.try_lock_exclusive() {
                Ok(()) => break,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10))
                }
                Err(_) => return Err(ERROR.into()),
            }
        }
        // OS file lock releases on drop, including all early returns.
        let marker = self.directory.join("local-secret-key-id");
        let read_marker = || {
            use std::io::Read;
            let mut id = String::new();
            fs::File::open(&marker)?.take(37).read_to_string(&mut id)?;
            Ok::<_, std::io::Error>(id)
        };
        let (id, key) = match read_marker() {
            Ok(id) => {
                validate_id(&id)?;
                let key = self.store.get(&id)?.ok_or(ERROR)?;
                (id, key)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let id = uuid::Uuid::new_v4().to_string();
                let key =
                    Zeroizing::new(crate::vault_crypto::random_bytes::<32>().map_err(|_| ERROR)?);
                self.store.set(&id, &key)?;
                // Read back before publishing the ID. Failed/denied stores never
                // produce a ciphertext whose key exists only in process memory.
                if self.store.get(&id).ok().flatten().as_deref() != Some(&*key) {
                    self.store.remove(&id);
                    return Err(ERROR.into());
                }
                let publish = (|| {
                    use std::io::Write;
                    let mut file =
                        tempfile::NamedTempFile::new_in(&self.directory).map_err(|_| ERROR)?;
                    file.write_all(id.as_bytes()).map_err(|_| ERROR)?;
                    file.as_file().sync_all().map_err(|_| ERROR)?;
                    file.persist_noclobber(&marker).map_err(|_| ERROR)?;
                    Ok::<(), &str>(())
                })();
                if publish.is_err() {
                    self.store.remove(&id);
                    return Err(ERROR.into());
                }
                (id, key)
            }
            Err(_) => return Err(ERROR.into()),
        };
        let cipher =
            crate::vault_crypto::encrypt_bound(&key, self.aad(&id).as_bytes(), value.as_bytes())
                .map_err(|_| ERROR)?;
        Ok(format!("{PREFIX}{id}:{cipher}"))
    }

    fn reveal(&self, value: &str) -> Result<String, String> {
        let (id, cipher) = value
            .strip_prefix(PREFIX)
            .and_then(|rest| rest.split_once(':'))
            .ok_or(ERROR)?;
        validate_id(id)?;
        let _serial = self.serial.lock().map_err(|_| ERROR)?;
        let key = self.store.get(id)?.ok_or(ERROR)?;
        let plain = crate::vault_crypto::decrypt_bound(&key, self.aad(id).as_bytes(), cipher)
            .map_err(|_| ERROR)?;
        std::str::from_utf8(&plain)
            .map(str::to_owned)
            .map_err(|_| ERROR.to_string())
    }
}

fn validate_id(id: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.to_string() == id) {
        Ok(())
    } else {
        Err(ERROR.into())
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
struct NativeStore {
    service: String,
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
impl NativeStore {
    fn entry(&self, id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, id).map_err(|_| ERROR.into())
    }
}
#[cfg(any(target_os = "macos", target_os = "linux"))]
impl KeyStore for NativeStore {
    fn get(&self, id: &str) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
        let bytes = match self.entry(id)?.get_secret() {
            Ok(bytes) => Zeroizing::new(bytes),
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(_) => return Err(ERROR.into()),
        };
        let key: [u8; 32] = bytes.as_slice().try_into().map_err(|_| ERROR)?;
        Ok(Some(Zeroizing::new(key)))
    }
    fn set(&self, id: &str, key: &[u8; 32]) -> Result<(), String> {
        self.entry(id)?.set_secret(key).map_err(|_| ERROR.into())
    }
    fn remove(&self, id: &str) {
        if let Ok(entry) = self.entry(id) {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(all(not(test), any(target_os = "macos", target_os = "linux")))]
static CONTEXT: std::sync::OnceLock<Context<NativeStore>> = std::sync::OnceLock::new();

#[cfg(all(not(test), any(target_os = "macos", target_os = "linux")))]
pub(super) fn initialize(identifier: &str, directory: PathBuf) -> Result<(), String> {
    CONTEXT
        .set(Context {
            identifier: identifier.into(),
            directory,
            store: NativeStore {
                service: format!("{identifier}.local-secrets.v1"),
            },
            serial: Mutex::new(()),
        })
        .map_err(|_| ERROR.into())
}
#[cfg(all(not(test), any(target_os = "macos", target_os = "linux")))]
pub(super) fn protect(value: &str) -> Result<String, String> {
    CONTEXT.get().ok_or(ERROR)?.protect(value)
}
#[cfg(all(not(test), any(target_os = "macos", target_os = "linux")))]
pub(super) fn reveal(value: &str) -> Result<String, String> {
    CONTEXT.get().ok_or(ERROR)?.reveal(value)
}

// Unit tests must never read/write a user's real Keychain or Secret Service.
#[cfg(test)]
#[derive(Default)]
struct MemoryStore(Mutex<std::collections::HashMap<String, Zeroizing<[u8; 32]>>>);
#[cfg(test)]
impl KeyStore for MemoryStore {
    fn get(&self, id: &str) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
        Ok(self.0.lock().unwrap().get(id).cloned())
    }
    fn set(&self, id: &str, key: &[u8; 32]) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(id.into(), Zeroizing::new(*key));
        Ok(())
    }
    fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
}
#[cfg(all(test, not(target_os = "windows")))]
fn test_context() -> &'static Context<MemoryStore> {
    static CONTEXT: std::sync::OnceLock<(tempfile::TempDir, Context<MemoryStore>)> =
        std::sync::OnceLock::new();
    &CONTEXT
        .get_or_init(|| {
            let directory = tempfile::tempdir().unwrap();
            let context = Context {
                identifier: "test.synthetic.secrets".into(),
                directory: directory.path().into(),
                store: MemoryStore::default(),
                serial: Mutex::new(()),
            };
            (directory, context)
        })
        .1
}
#[cfg(all(test, not(target_os = "windows")))]
pub(super) fn initialize(_: &str, _: PathBuf) -> Result<(), String> {
    Ok(())
}
#[cfg(all(test, not(target_os = "windows")))]
pub(super) fn protect(value: &str) -> Result<String, String> {
    test_context().protect(value)
}
#[cfg(all(test, not(target_os = "windows")))]
pub(super) fn reveal(value: &str) -> Result<String, String> {
    test_context().reveal(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(directory: &std::path::Path) -> Context<MemoryStore> {
        Context {
            identifier: "test.synthetic.secrets".into(),
            directory: directory.into(),
            store: MemoryStore::default(),
            serial: Mutex::new(()),
        }
    }
    #[test]
    fn encrypted_roundtrip_randomness_tamper_and_identity_binding() {
        let directory = tempfile::tempdir().unwrap();
        let mut ctx = fixture(directory.path());
        let first = ctx.protect("synthetic-key").unwrap();
        assert_ne!(first, ctx.protect("synthetic-key").unwrap());
        assert!(!first.contains("synthetic-key"));
        assert_eq!(ctx.reveal(&first).unwrap(), "synthetic-key");
        let mut corrupt = first.clone();
        corrupt.push('!');
        assert_eq!(ctx.reveal(&corrupt).unwrap_err(), ERROR);
        ctx.identifier = "test.other.instance".into();
        assert!(ctx.reveal(&first).is_err());
    }
    #[test]
    fn missing_key_never_replaces_old_key_or_changes_marker() {
        let directory = tempfile::tempdir().unwrap();
        let ctx = fixture(directory.path());
        let first = ctx.protect("synthetic-key").unwrap();
        let marker = directory.path().join("local-secret-key-id");
        let id = fs::read_to_string(&marker).unwrap();
        ctx.store.remove(&id);
        assert!(ctx.reveal(&first).is_err());
        assert!(ctx.protect("new-value").is_err());
        assert_eq!(fs::read_to_string(marker).unwrap(), id);
        assert!(ctx.store.0.lock().unwrap().is_empty());
    }
    #[test]
    fn unavailable_store_does_not_publish_marker_or_plaintext() {
        struct Denied;
        impl KeyStore for Denied {
            fn get(&self, _: &str) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
                Err(ERROR.into())
            }
            fn set(&self, _: &str, _: &[u8; 32]) -> Result<(), String> {
                Err(ERROR.into())
            }
            fn remove(&self, _: &str) {}
        }
        let directory = tempfile::tempdir().unwrap();
        let ctx = Context {
            identifier: "test.denied".into(),
            directory: directory.path().into(),
            store: Denied,
            serial: Mutex::new(()),
        };
        assert_eq!(ctx.protect("synthetic-secret").unwrap_err(), ERROR);
        assert!(!directory.path().join("local-secret-key-id").exists());
        let value = format!("{PREFIX}{}:v1:invalid", uuid::Uuid::new_v4());
        assert_eq!(ctx.reveal(&value).unwrap_err(), ERROR);
    }
}
