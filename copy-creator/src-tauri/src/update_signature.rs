//! Shared by the running client and the release verification executable.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub const MAX_UPDATE_BYTES: u64 = 512 * 1024 * 1024;
const PUBLIC_KEY: &str = include_str!("../updater.pub");

fn decode_text(value: &str) -> Result<String, String> {
    if value.len() > 16 * 1024 {
        return Err("updates.signatureInvalid".into());
    }
    String::from_utf8(
        STANDARD
            .decode(value.trim())
            .map_err(|_| "updates.signatureInvalid")?,
    )
    .map_err(|_| "updates.signatureInvalid".into())
}
pub fn decode_signature(value: &str) -> Result<Signature, String> {
    if value.trim().is_empty() {
        return Err("updates.signatureMissing".into());
    }
    Signature::decode(&decode_text(value)?).map_err(|_| "updates.signatureInvalid".into())
}

pub fn verify_file(
    path: &Path,
    signature: &str,
    size: Option<u64>,
) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Deny writes/deletion through verification and process creation.
        options.share_mode(1);
    }
    let mut file = options.open(path).map_err(|_| "updates.fileError")?;
    let length = file.metadata().map_err(|_| "updates.fileError")?.len();
    if length == 0 || length > MAX_UPDATE_BYTES {
        return Err("updates.packageTooLarge".into());
    }
    if size.is_some_and(|size| size != length) {
        return Err("updates.sizeMismatch".into());
    }
    let key =
        PublicKey::decode(&decode_text(PUBLIC_KEY)?).map_err(|_| "updates.signatureInvalid")?;
    let signature = decode_signature(signature)?;
    let mut verifier = key
        .verify_stream(&signature)
        .map_err(|_| "updates.signatureInvalid")?;
    let mut buffer = [0u8; 64 * 1024];
    let mut read = 0u64;
    loop {
        let count = file.read(&mut buffer).map_err(|_| "updates.fileError")?;
        if count == 0 {
            break;
        }
        read += count as u64;
        if read > MAX_UPDATE_BYTES {
            return Err("updates.packageTooLarge".into());
        }
        verifier.update(&buffer[..count]);
    }
    verifier
        .finalize()
        .map_err(|_| "updates.signatureInvalid")?;
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "updates.fileError")?;
    Ok(file)
}
