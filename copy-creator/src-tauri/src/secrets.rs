use base64::Engine;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
};

const PREFIX: &str = "dpapi:v1:";

pub fn is_protected(value: &str) -> bool {
    value.starts_with(PREFIX)
}

pub fn protect(value: &str) -> Result<String, String> {
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: value.len().try_into().map_err(|_| "secret too large")?,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &mut input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("protect secret: {e}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        LocalFree(HLOCAL(output.pbData as *mut _));
        Ok(format!("{PREFIX}{encoded}"))
    }
}

pub fn reveal(value: &str) -> Result<String, String> {
    let Some(encoded) = value.strip_prefix(PREFIX) else {
        return Ok(value.to_string()); // Legacy data, migrated on startup.
    };
    let mut encrypted = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("invalid protected secret: {e}"))?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted.len().try_into().map_err(|_| "secret too large")?,
        pbData: encrypted.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
            .map_err(|e| format!("reveal secret: {e}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let result = String::from_utf8(bytes.to_vec()).map_err(|e| e.to_string());
        LocalFree(HLOCAL(output.pbData as *mut _));
        result
    }
}

pub fn is_setting_secret(key: &str) -> bool {
    matches!(key, "ai_api_key" | "google_api_key" | "baidu_secret")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_value_round_trips_without_plaintext() {
        let original = "sk-example-test-secret-123456789";
        let protected = protect(original).unwrap();
        assert!(is_protected(&protected));
        assert!(!protected.contains(original));
        assert_eq!(reveal(&protected).unwrap(), original);
    }
}
