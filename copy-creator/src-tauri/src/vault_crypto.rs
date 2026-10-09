use aes_gcm::{
    aead::{Aead, AeadInPlace, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::OsRng, TryRngCore};
use serde::Deserialize;
use zeroize::Zeroizing;

pub const VERIFIER_ID: &str = "master-verifier";
pub const VERIFIER: &[u8] = b"Copy Creator website vault v1";

pub fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0; N];
    OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "vault.randomFailed")?;
    Ok(bytes)
}

pub fn validate_master(password: &str) -> Result<(), String> {
    if password.trim().is_empty() {
        return Err("vault.masterLength".into());
    }
    Ok(())
}

pub fn derive_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    if salt.len() != 16 {
        return Err("vault.invalidData".into());
    }
    let params = Params::new(65536, 3, 1, Some(32)).map_err(|_| "vault.cryptoFailed")?;
    let mut key = Zeroizing::new([0; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|_| "vault.cryptoFailed")?;
    Ok(key)
}

fn aad(id: &str) -> Vec<u8> {
    format!("copy-creator/website-vault/v1/{id}").into_bytes()
}

pub fn encrypt(key: &[u8; 32], id: &str, plaintext: &[u8]) -> Result<String, String> {
    encrypt_bound(key, &aad(id), plaintext)
}

pub(crate) fn encrypt_bound(
    key: &[u8; 32],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<String, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "vault.cryptoFailed")?;
    let nonce = random_bytes::<12>()?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "vault.cryptoFailed")?;
    let mut envelope = nonce.to_vec();
    envelope.extend(ciphertext);
    Ok(format!("v1:{}", STANDARD.encode(envelope)))
}
/// Backup owns the bounded plaintext buffer, so encrypt it without another
/// payload-sized plaintext/ciphertext/envelope copy.
pub(crate) fn encrypt_bound_owned(key: &[u8;32], aad: &[u8], mut bytes: Zeroizing<Vec<u8>>) -> Result<String,String> {
    let cipher=Aes256Gcm::new_from_slice(key).map_err(|_| "vault.cryptoFailed")?;
    let nonce=random_bytes::<12>()?;
    bytes.try_reserve_exact(28).map_err(|_| "backup.fileTooLarge")?;
    cipher.encrypt_in_place(Nonce::from_slice(&nonce),aad,&mut *bytes).map_err(|_| "vault.cryptoFailed")?;
    bytes.splice(..0,nonce);
    let capacity=3+4*bytes.len().div_ceil(3);
    let mut encoded=String::with_capacity(capacity); encoded.push_str("v1:");
    STANDARD.encode_string(&*bytes,&mut encoded); Ok(encoded)
}

pub fn decrypt(key: &[u8; 32], id: &str, envelope: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    decrypt_bound(key, &aad(id), envelope)
}

pub(crate) fn decrypt_bound(
    key: &[u8; 32],
    aad: &[u8],
    envelope: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let encoded = envelope.strip_prefix("v1:").ok_or("vault.invalidData")?;
    let mut bytes = Zeroizing::new(STANDARD.decode(encoded).map_err(|_| "vault.invalidData")?);
    if bytes.len() < 28 {
        return Err("vault.invalidData".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "vault.cryptoFailed")?;
    let nonce: [u8;12]=bytes[..12].try_into().map_err(|_| "vault.invalidData")?;
    bytes.drain(..12);
    cipher.decrypt_in_place(Nonce::from_slice(&nonce),aad,&mut *bytes).map_err(|_| "vault.invalidData")?;
    Ok(bytes)
}

#[derive(Clone, Deserialize)]
pub struct PasswordOptions {
    pub length: usize,
    pub uppercase: bool,
    pub lowercase: bool,
    pub digits: bool,
    pub symbols: bool,
    pub exclude_ambiguous: bool,
}

fn random_index(len: usize) -> Result<usize, String> {
    // Rejection sampling avoids modulo bias for both characters and shuffling.
    let ceiling = u32::MAX - (u32::MAX % len as u32);
    loop {
        let n = OsRng.try_next_u32().map_err(|_| "vault.randomFailed")?;
        if n < ceiling {
            return Ok(n as usize % len);
        }
    }
}

pub fn generate(options: &PasswordOptions) -> Result<String, String> {
    if !(12..=128).contains(&options.length) {
        return Err("vault.passwordLength".into());
    }
    let mut groups: Vec<Vec<u8>> = Vec::new();
    for (enabled, alphabet) in [
        (options.uppercase, "ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        (options.lowercase, "abcdefghijklmnopqrstuvwxyz"),
        (options.digits, "0123456789"),
        (options.symbols, "!@#$%^&*()-_=+[]{};:,.?~"),
    ] {
        if enabled {
            groups.push(
                alphabet
                    .bytes()
                    .filter(|c| !options.exclude_ambiguous || !b"Il1O0o".contains(c))
                    .collect(),
            );
        }
    }
    if groups.is_empty() {
        return Err("vault.selectCharacters".into());
    }
    let pool: Vec<u8> = groups.iter().flatten().copied().collect();
    let mut password = Zeroizing::new(Vec::with_capacity(options.length));
    for group in &groups {
        password.push(group[random_index(group.len())?]);
    }
    while password.len() < options.length {
        password.push(pool[random_index(pool.len())?]);
    }
    for i in (1..password.len()).rev() {
        password.swap(i, random_index(i + 1)?);
    }
    String::from_utf8(password.to_vec()).map_err(|_| "vault.cryptoFailed".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ciphertext_is_randomized_and_bound_to_the_record() {
        let key = [42; 32];
        let first = encrypt(&key, "site-1", b"private password").unwrap();
        let second = encrypt(&key, "site-1", b"private password").unwrap();
        assert_ne!(first, second);
        assert!(!first.contains("private password"));
        assert_eq!(
            decrypt(&key, "site-1", &first).unwrap().as_slice(),
            b"private password"
        );
        assert!(decrypt(&key, "site-2", &first).is_err());
        assert!(decrypt(&[43; 32], "site-1", &first).is_err());
        let mut bytes = STANDARD.decode(first.strip_prefix("v1:").unwrap()).unwrap();
        bytes[13] ^= 1;
        assert!(decrypt(&key, "site-1", &format!("v1:{}", STANDARD.encode(bytes))).is_err());
    }

    #[test]
    fn master_key_requires_the_correct_password_and_salt() {
        let salt = [19; 16];
        let key = derive_key("a long master passphrase", &salt).unwrap();
        let verifier = encrypt(&key, VERIFIER_ID, VERIFIER).unwrap();
        let wrong = derive_key("a different passphrase", &salt).unwrap();
        assert!(decrypt(&wrong, VERIFIER_ID, &verifier).is_err());
        assert_eq!(
            decrypt(&key, VERIFIER_ID, &verifier).unwrap().as_slice(),
            VERIFIER
        );
        assert!(derive_key("password", &[0; 15]).is_err());
        assert!(validate_master("short").is_ok());
    }

    #[test]
    fn master_password_length_is_user_defined_and_blank_is_rejected() {
        for password in ["1", "123456", "short", "任意长度", " leading and trailing "] {
            assert!(validate_master(password).is_ok());
        }
        for password in ["", " ", "\t\r\n", "\u{3000}"] {
            assert!(validate_master(password).is_err());
        }
        let salt = [23; 16];
        let six_character_key = derive_key("123456", &salt).unwrap();
        let verifier = encrypt(&six_character_key, VERIFIER_ID, VERIFIER).unwrap();
        let repeated_key = derive_key("123456", &salt).unwrap();
        assert_eq!(decrypt(&repeated_key, VERIFIER_ID, &verifier).unwrap().as_slice(), VERIFIER);
        let wrong_key = derive_key("654321", &salt).unwrap();
        assert!(decrypt(&wrong_key, VERIFIER_ID, &verifier).is_err());

        let long_password = "长".repeat(2048);
        assert!(validate_master(&long_password).is_ok());
        let long_key = derive_key(&long_password, &salt).unwrap();
        let long_verifier = encrypt(&long_key, VERIFIER_ID, VERIFIER).unwrap();
        assert_eq!(decrypt(&long_key, VERIFIER_ID, &long_verifier).unwrap().as_slice(), VERIFIER);
    }

    #[test]
    fn generated_passwords_include_every_selected_group() {
        let options = PasswordOptions {
            length: 24,
            uppercase: true,
            lowercase: true,
            digits: true,
            symbols: true,
            exclude_ambiguous: true,
        };
        let mut generated = std::collections::HashSet::new();
        for _ in 0..100 {
            let password = generate(&options).unwrap();
            assert_eq!(password.len(), 24);
            assert!(password.bytes().any(|c| c.is_ascii_uppercase()));
            assert!(password.bytes().any(|c| c.is_ascii_lowercase()));
            assert!(password.bytes().any(|c| c.is_ascii_digit()));
            assert!(password.bytes().any(|c| !c.is_ascii_alphanumeric()));
            assert!(!password.bytes().any(|c| b"Il1O0o".contains(&c)));
            assert!(generated.insert(password));
        }
        assert!(generate(&PasswordOptions {
            length: 11,
            ..options.clone()
        })
        .is_err());
        assert!(generate(&PasswordOptions {
            uppercase: false,
            lowercase: false,
            digits: false,
            symbols: false,
            ..options
        })
        .is_err());
    }
}
