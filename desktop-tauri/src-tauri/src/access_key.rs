use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Serialize};

pub const TAURI_ACCESS_KEY_FILE_NAME: &str = "tauri-preview-access-key.json";
pub const ELECTRON_ACCESS_KEY_FILE_NAME: &str = "desktop-pet-access-key.json";
pub const ACCESS_KEY_STORE_VERSION: u32 = 1;
const MAX_ACCESS_KEY_LENGTH: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAccessKeyFile {
    version: u32,
    ciphertext: String,
}

pub trait AccessKeyCodec: Send + Sync {
    fn is_available(&self) -> bool;
    fn encrypt(&self, plain: &str) -> Result<String, String>;
    fn decrypt(&self, blob: &str) -> Result<String, String>;
}

/// Never claims disk encryption. Used when OS crypto is unavailable and in tests.
pub struct MemoryAccessKeyCodec;

impl AccessKeyCodec for MemoryAccessKeyCodec {
    fn is_available(&self) -> bool {
        false
    }

    fn encrypt(&self, plain: &str) -> Result<String, String> {
        Ok(plain.to_string())
    }

    fn decrypt(&self, blob: &str) -> Result<String, String> {
        Ok(blob.to_string())
    }
}

pub struct DpapiAccessKeyCodec;

impl AccessKeyCodec for DpapiAccessKeyCodec {
    fn is_available(&self) -> bool {
        cfg!(windows)
    }

    fn encrypt(&self, plain: &str) -> Result<String, String> {
        protect(plain)
    }

    fn decrypt(&self, blob: &str) -> Result<String, String> {
        unprotect(blob)
    }
}

pub fn access_key_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TAURI_ACCESS_KEY_FILE_NAME)
}

pub fn normalize_access_key_input(value: Option<&str>) -> Option<String> {
    let key = value?.trim();
    if key.is_empty() || key.len() > MAX_ACCESS_KEY_LENGTH {
        return None;
    }
    Some(key.to_string())
}

pub fn load_desktop_access_key(
    data_dir: &Path,
    codec: &dyn AccessKeyCodec,
) -> Option<String> {
    if !codec.is_available() {
        return None;
    }
    let path = access_key_file_path(data_dir);
    let text = fs::read_to_string(path).ok()?;
    let record: StoredAccessKeyFile = serde_json::from_str(&text).ok()?;
    if record.version != ACCESS_KEY_STORE_VERSION {
        return None;
    }
    let ciphertext = record.ciphertext.trim();
    if ciphertext.is_empty() {
        return None;
    }
    let plain = codec.decrypt(ciphertext).ok()?;
    normalize_access_key_input(Some(&plain))
}

pub fn save_desktop_access_key(
    data_dir: &Path,
    access_key: &str,
    codec: &dyn AccessKeyCodec,
) -> Result<bool, String> {
    let Some(key) = normalize_access_key_input(Some(access_key)) else {
        clear_desktop_access_key(data_dir);
        return Ok(false);
    };
    if !codec.is_available() {
        return Ok(false);
    }
    let ciphertext = codec.encrypt(&key)?;
    if ciphertext.is_empty() || ciphertext.contains(&key) {
        return Err("access key encryption produced an unsafe payload".to_string());
    }
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let payload = StoredAccessKeyFile {
        version: ACCESS_KEY_STORE_VERSION,
        ciphertext,
    };
    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?
    );
    if serialized.contains(&key) {
        return Err("access key ciphertext file leaked plaintext".to_string());
    }
    fs::write(access_key_file_path(data_dir), serialized).map_err(|error| error.to_string())?;
    Ok(true)
}

pub fn clear_desktop_access_key(data_dir: &Path) {
    let path = access_key_file_path(data_dir);
    let _ = fs::remove_file(path);
}

pub fn default_codec() -> Box<dyn AccessKeyCodec> {
    let codec = DpapiAccessKeyCodec;
    if codec.is_available() {
        Box::new(codec)
    } else {
        Box::new(MemoryAccessKeyCodec)
    }
}

#[cfg(windows)]
fn protect(plain: &str) -> Result<String, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let mut bytes = plain.as_bytes().to_vec();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&input, None, None, None, None, 0x1, &mut output)
            .map_err(|error| error.to_string())?;
        if output.pbData.is_null() || output.cbData == 0 {
            return Err("dpapi produced empty ciphertext".to_string());
        }
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let encoded = STANDARD.encode(slice);
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(encoded)
    }
}

#[cfg(windows)]
fn unprotect(blob: &str) -> Result<String, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let mut bytes = STANDARD
        .decode(blob.trim())
        .map_err(|error| error.to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_mut_ptr(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, 0x1, &mut output)
            .map_err(|error| error.to_string())?;
        if output.pbData.is_null() {
            return Err("dpapi decrypt returned empty".to_string());
        }
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let plain = String::from_utf8(slice.to_vec()).map_err(|error| error.to_string())?;
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(plain)
    }
}

#[cfg(not(windows))]
fn protect(_plain: &str) -> Result<String, String> {
    Err("dpapi unavailable".to_string())
}

#[cfg(not(windows))]
fn unprotect(_blob: &str) -> Result<String, String> {
    Err("dpapi unavailable".to_string())
}
