use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::access_key::{
    access_key_file_path, decrypt_access_key_ciphertext, encrypt_access_key_ciphertext,
    load_desktop_access_key, normalize_access_key_input, AccessKeyCodec,
};
use crate::connection_state::DESKTOP_DEFAULT_PORT;

pub const SERVER_PROFILES_FILE_NAME: &str = "tauri-preview-server-profiles.json";
pub const SERVER_PROFILES_VERSION: u32 = 1;
pub const LOCAL_PROFILE_ID: &str = "local";
pub const LOCAL_PROFILE_NAME: &str = "本机";
pub const MAX_SERVER_PROFILES: usize = 20;
pub const MAX_PROFILE_NAME_LEN: usize = 80;
pub const MAX_ORIGIN_LEN: usize = 256;
pub const MAX_CIPHERTEXT_LEN: usize = 4096;
pub const MAX_STORE_BYTES: usize = 128 * 1024;

static PROFILE_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileError {
    InvalidAddress,
    UserinfoForbidden,
    PathForbidden,
    QueryForbidden,
    FragmentForbidden,
    InvalidPort,
    UnknownScheme,
    InsecureHttpNotAllowed,
    DuplicateOrigin,
    TooManyProfiles,
    NameTooLong,
    OriginTooLong,
    NotFound,
    CannotDeleteActive,
    CannotDeleteLast,
    InvalidKey,
    StoreTooLarge,
    PersistFailed,
}

impl ProfileError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidAddress => "invalid_address",
            Self::UserinfoForbidden => "userinfo_forbidden",
            Self::PathForbidden => "path_forbidden",
            Self::QueryForbidden => "query_forbidden",
            Self::FragmentForbidden => "fragment_forbidden",
            Self::InvalidPort => "invalid_port",
            Self::UnknownScheme => "unknown_scheme",
            Self::InsecureHttpNotAllowed => "insecure_http_not_allowed",
            Self::DuplicateOrigin => "duplicate_origin",
            Self::TooManyProfiles => "too_many_profiles",
            Self::NameTooLong => "name_too_long",
            Self::OriginTooLong => "origin_too_long",
            Self::NotFound => "not_found",
            Self::CannotDeleteActive => "cannot_delete_active",
            Self::CannotDeleteLast => "cannot_delete_last",
            Self::InvalidKey => "invalid_key",
            Self::StoreTooLarge => "store_too_large",
            Self::PersistFailed => "persist_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccessKeyCommand {
    Preserve,
    Replace(String),
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveProfileIntent {
    pub id: Option<String>,
    pub name: Option<String>,
    pub address: String,
    pub allow_insecure_http: bool,
    pub access_key: AccessKeyCommand,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeProfile {
    pub id: String,
    pub name: Option<String>,
    pub origin: String,
    pub allow_insecure_http: bool,
    pub access_key: Option<String>,
    pub key_persisted: bool,
}

impl RuntimeProfile {
    pub fn is_insecure(&self) -> bool {
        self.origin.starts_with("http://") && !is_loopback_origin(&self.origin)
    }

    pub fn port(&self) -> u16 {
        origin_port(&self.origin).unwrap_or(DESKTOP_DEFAULT_PORT)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeProfileStore {
    pub active_server_id: String,
    pub profiles: Vec<RuntimeProfile>,
}

impl RuntimeProfileStore {
    pub fn active(&self) -> Option<&RuntimeProfile> {
        self.profiles
            .iter()
            .find(|profile| profile.id == self.active_server_id)
            .or_else(|| self.profiles.first())
    }

    pub fn active_mut(&mut self) -> Option<&mut RuntimeProfile> {
        let id = self.active_server_id.clone();
        if let Some(index) = self.profiles.iter().position(|profile| profile.id == id) {
            return self.profiles.get_mut(index);
        }
        self.profiles.first_mut()
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerProfileProjection {
    pub id: String,
    pub name: Option<String>,
    pub origin: String,
    pub allow_insecure_http: bool,
    pub insecure: bool,
    pub has_access_key: bool,
    pub key_persisted: bool,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProfileFile {
    version: u32,
    active_server_id: String,
    profiles: Vec<StoredProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProfile {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    origin: String,
    #[serde(default)]
    allow_insecure_http: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    access_key_ciphertext: Option<String>,
}

pub fn server_profiles_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SERVER_PROFILES_FILE_NAME)
}

pub fn generate_profile_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let seq = PROFILE_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    format!("srv_{nanos:016x}{pid:08x}{seq:04x}")
}

pub fn parse_access_key_command(value: &Value) -> Result<AccessKeyCommand, ProfileError> {
    let action = value
        .get("accessKeyAction")
        .and_then(Value::as_str)
        .unwrap_or("preserve")
        .trim();
    match action {
        "preserve" | "" => Ok(AccessKeyCommand::Preserve),
        "clear" => Ok(AccessKeyCommand::Clear),
        "replace" => {
            let key = value
                .get("accessKey")
                .and_then(Value::as_str)
                .and_then(|raw| normalize_access_key_input(Some(raw)))
                .ok_or(ProfileError::InvalidKey)?;
            Ok(AccessKeyCommand::Replace(key))
        }
        _ => Err(ProfileError::InvalidKey),
    }
}

pub fn parse_save_intent(value: &Value) -> Result<SaveProfileIntent, ProfileError> {
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToString::to_string);
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToString::to_string);
    if name.as_ref().is_some_and(|value| value.chars().count() > MAX_PROFILE_NAME_LEN) {
        return Err(ProfileError::NameTooLong);
    }
    let address = value
        .get("address")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|address| !address.is_empty())
        .ok_or(ProfileError::InvalidAddress)?
        .to_string();
    let allow_insecure_http = value
        .get("allowInsecureHttp")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(SaveProfileIntent {
        id,
        name,
        address,
        allow_insecure_http,
        access_key: parse_access_key_command(value)?,
    })
}

pub fn normalize_server_origin(
    raw: &str,
    allow_insecure_http: bool,
) -> Result<String, ProfileError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains([' ', '\t', '\r', '\n', '"', '\\']) {
        return Err(ProfileError::InvalidAddress);
    }
    if trimmed.contains('@') {
        return Err(ProfileError::UserinfoForbidden);
    }
    if trimmed.contains('#') {
        return Err(ProfileError::FragmentForbidden);
    }
    if trimmed.contains('?') {
        return Err(ProfileError::QueryForbidden);
    }

    let (scheme, rest) = if let Some(rest) = trimmed.strip_prefix("https://") {
        ("https", rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        ("http", rest)
    } else if let Some(idx) = trimmed.find("://") {
        let scheme = &trimmed[..idx];
        if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
            return Err(ProfileError::UnknownScheme);
        }
        return Err(ProfileError::UnknownScheme);
    } else {
        ("https", trimmed)
    };

    if rest.is_empty() {
        return Err(ProfileError::InvalidAddress);
    }
    if rest.contains('@') {
        return Err(ProfileError::UserinfoForbidden);
    }
    if rest.contains('#') {
        return Err(ProfileError::FragmentForbidden);
    }
    if rest.contains('?') {
        return Err(ProfileError::QueryForbidden);
    }
    if rest.contains('/') {
        return Err(ProfileError::PathForbidden);
    }

    let (host, port) = split_host_port(rest)?;
    let origin = format!("{scheme}://{host}:{port}");
    if origin.len() > MAX_ORIGIN_LEN {
        return Err(ProfileError::OriginTooLong);
    }
    if scheme == "http" && !is_loopback_host(&host) && !allow_insecure_http {
        return Err(ProfileError::InsecureHttpNotAllowed);
    }
    Ok(origin)
}

pub fn is_loopback_origin(origin: &str) -> bool {
    origin_host(origin).is_some_and(|host| is_loopback_host(&host))
}

pub fn is_loopback_host(host: &str) -> bool {
    let bare = strip_brackets(host).to_ascii_lowercase();
    if bare == "localhost" || bare == "::1" || bare == "0:0:0:0:0:0:0:1" {
        return true;
    }
    is_ipv4_loopback(&bare)
}

pub fn origin_host(origin: &str) -> Option<String> {
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))?;
    let (host, _) = split_host_port(rest).ok()?;
    Some(host)
}

pub fn origin_port(origin: &str) -> Option<u16> {
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| origin.strip_prefix("http://"))?;
    split_host_port(rest).ok().map(|(_, port)| port)
}

pub fn is_origin_scoped_url(url: &str, origin: &str) -> bool {
    let origin = origin.trim().trim_end_matches('/');
    url == origin || url.starts_with(&format!("{origin}/"))
}

pub fn project_profiles(store: &RuntimeProfileStore) -> Vec<ServerProfileProjection> {
    store
        .profiles
        .iter()
        .map(|profile| ServerProfileProjection {
            id: profile.id.clone(),
            name: profile.name.clone(),
            origin: profile.origin.clone(),
            allow_insecure_http: profile.allow_insecure_http,
            insecure: profile.is_insecure(),
            has_access_key: profile.access_key.is_some(),
            key_persisted: profile.key_persisted,
            is_active: profile.id == store.active_server_id,
        })
        .collect()
}

pub fn profiles_projection_json(store: &RuntimeProfileStore) -> Value {
    let profiles = project_profiles(store);
    json!({
        "ok": true,
        "activeServerId": store.active_server_id,
        "profiles": profiles,
    })
}

pub fn assert_projection_safe(value: &Value) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|error| error.to_string())?;
    for key in [
        "accessKey",
        "ciphertext",
        "accessKeyCiphertext",
        "token",
        "observerToken",
        "password",
    ] {
        let pattern = format!("\"{key}\":");
        if json.contains(&pattern) {
            return Err(format!("profile projection leaked {key}"));
        }
    }
    Ok(())
}

pub fn load_or_migrate_profile_store(
    data_dir: &Path,
    settings_port: u16,
    codec: &dyn AccessKeyCodec,
) -> RuntimeProfileStore {
    match load_profile_store(data_dir, codec) {
        Ok(Some(store)) if !store.profiles.is_empty() => store,
        _ => migrate_legacy_local_profile(data_dir, settings_port, codec),
    }
}

pub fn load_profile_store(
    data_dir: &Path,
    codec: &dyn AccessKeyCodec,
) -> Result<Option<RuntimeProfileStore>, ProfileError> {
    let path = server_profiles_file_path(data_dir);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(_) => return Ok(None),
    };
    if text.len() > MAX_STORE_BYTES {
        return Err(ProfileError::StoreTooLarge);
    }
    let stored: StoredProfileFile =
        serde_json::from_str(&text).map_err(|_| ProfileError::PersistFailed)?;
    if stored.version != SERVER_PROFILES_VERSION || stored.profiles.is_empty() {
        return Ok(None);
    }
    Ok(Some(hydrate_store(stored, codec)))
}

pub fn save_profile_store(
    data_dir: &Path,
    store: &RuntimeProfileStore,
    codec: &dyn AccessKeyCodec,
) -> Result<RuntimeProfileStore, ProfileError> {
    if store.profiles.is_empty() || store.profiles.len() > MAX_SERVER_PROFILES {
        return Err(ProfileError::TooManyProfiles);
    }
    let mut secrets = Vec::new();
    let mut stored_profiles = Vec::new();
    for profile in &store.profiles {
        if let Some(key) = &profile.access_key {
            secrets.push(key.clone());
        }
        let ciphertext = match (&profile.access_key, profile.key_persisted || codec.is_available()) {
            (Some(key), true) if codec.is_available() => {
                let blob = encrypt_access_key_ciphertext(key, codec)
                    .map_err(|_| ProfileError::PersistFailed)?;
                if blob.len() > MAX_CIPHERTEXT_LEN {
                    return Err(ProfileError::StoreTooLarge);
                }
                Some(blob)
            }
            _ => None,
        };
        stored_profiles.push(StoredProfile {
            id: profile.id.clone(),
            name: profile.name.clone(),
            origin: profile.origin.clone(),
            allow_insecure_http: profile.allow_insecure_http && profile.is_insecure(),
            access_key_ciphertext: ciphertext,
        });
    }
    let stored = StoredProfileFile {
        version: SERVER_PROFILES_VERSION,
        active_server_id: store.active_server_id.clone(),
        profiles: stored_profiles,
    };
    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(&stored).map_err(|_| ProfileError::PersistFailed)?
    );
    if serialized.len() > MAX_STORE_BYTES {
        return Err(ProfileError::StoreTooLarge);
    }
    for secret in &secrets {
        if serialized.contains(secret) {
            return Err(ProfileError::PersistFailed);
        }
    }
    if serialized.contains("\"accessKey\":") {
        return Err(ProfileError::PersistFailed);
    }
    atomic_write(&server_profiles_file_path(data_dir), serialized.as_bytes())?;
    load_profile_store(data_dir, codec)?
        .ok_or(ProfileError::PersistFailed)
        .map(|mut reloaded| {
            merge_memory_keys(&mut reloaded, store);
            reloaded
        })
}

pub fn save_server_profile(
    store: &RuntimeProfileStore,
    intent: SaveProfileIntent,
    codec: &dyn AccessKeyCodec,
) -> Result<RuntimeProfileStore, ProfileError> {
    let origin = normalize_server_origin(&intent.address, intent.allow_insecure_http)?;
    let name = normalize_name(intent.name)?;
    let allow_insecure_http = origin.starts_with("http://") && !is_loopback_origin(&origin);
    let mut next = store.clone();
    if let Some(id) = intent.id.as_deref() {
        let index = next
            .profiles
            .iter()
            .position(|profile| profile.id == id)
            .ok_or(ProfileError::NotFound)?;
        if next
            .profiles
            .iter()
            .enumerate()
            .any(|(other, profile)| other != index && profile.origin == origin)
        {
            return Err(ProfileError::DuplicateOrigin);
        }
        let profile = &mut next.profiles[index];
        profile.name = name;
        profile.origin = origin;
        profile.allow_insecure_http = allow_insecure_http;
        apply_key_command(profile, intent.access_key, codec)?;
    } else {
        if next.profiles.len() >= MAX_SERVER_PROFILES {
            return Err(ProfileError::TooManyProfiles);
        }
        if next.profiles.iter().any(|profile| profile.origin == origin) {
            return Err(ProfileError::DuplicateOrigin);
        }
        let mut profile = RuntimeProfile {
            id: generate_profile_id(),
            name,
            origin,
            allow_insecure_http,
            access_key: None,
            key_persisted: false,
        };
        apply_key_command(&mut profile, intent.access_key, codec)?;
        next.profiles.push(profile);
    }
    Ok(next)
}

pub fn delete_server_profile(
    store: &RuntimeProfileStore,
    id: &str,
) -> Result<RuntimeProfileStore, ProfileError> {
    if store.profiles.len() <= 1 {
        return Err(ProfileError::CannotDeleteLast);
    }
    if store.active_server_id == id {
        return Err(ProfileError::CannotDeleteActive);
    }
    if !store.profiles.iter().any(|profile| profile.id == id) {
        return Err(ProfileError::NotFound);
    }
    let mut next = store.clone();
    next.profiles.retain(|profile| profile.id != id);
    Ok(next)
}

pub fn switch_active_profile(
    store: &RuntimeProfileStore,
    id: &str,
) -> Result<RuntimeProfileStore, ProfileError> {
    if !store.profiles.iter().any(|profile| profile.id == id) {
        return Err(ProfileError::NotFound);
    }
    let mut next = store.clone();
    next.active_server_id = id.to_string();
    Ok(next)
}

pub fn connection_fields_changed(previous: &RuntimeProfile, next: &RuntimeProfile) -> bool {
    previous.origin != next.origin
        || previous.allow_insecure_http != next.allow_insecure_http
        || previous.access_key != next.access_key
}

fn apply_key_command(
    profile: &mut RuntimeProfile,
    command: AccessKeyCommand,
    codec: &dyn AccessKeyCodec,
) -> Result<(), ProfileError> {
    match command {
        AccessKeyCommand::Preserve => Ok(()),
        AccessKeyCommand::Clear => {
            profile.access_key = None;
            profile.key_persisted = false;
            Ok(())
        }
        AccessKeyCommand::Replace(key) => {
            let Some(normalized) = normalize_access_key_input(Some(&key)) else {
                return Err(ProfileError::InvalidKey);
            };
            profile.access_key = Some(normalized);
            profile.key_persisted = codec.is_available();
            Ok(())
        }
    }
}

fn normalize_name(name: Option<String>) -> Result<Option<String>, ProfileError> {
    let Some(name) = name else {
        return Ok(None);
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > MAX_PROFILE_NAME_LEN {
        return Err(ProfileError::NameTooLong);
    }
    Ok(Some(trimmed.to_string()))
}

fn hydrate_store(stored: StoredProfileFile, codec: &dyn AccessKeyCodec) -> RuntimeProfileStore {
    let profiles = stored
        .profiles
        .into_iter()
        .filter(|profile| is_stable_profile_id(&profile.id))
        .filter_map(|profile| {
            let origin = normalize_server_origin(
                &profile.origin,
                profile.allow_insecure_http || is_loopback_origin(&profile.origin),
            )
            .ok()?;
            let allow_insecure_http =
                origin.starts_with("http://") && !is_loopback_origin(&origin);
            let access_key = profile
                .access_key_ciphertext
                .as_deref()
                .and_then(|blob| decrypt_access_key_ciphertext(blob, codec));
            Some(RuntimeProfile {
                id: profile.id,
                name: profile.name.and_then(|name| normalize_name(Some(name)).ok().flatten()),
                origin,
                allow_insecure_http,
                key_persisted: access_key.is_some(),
                access_key,
            })
        })
        .take(MAX_SERVER_PROFILES)
        .collect::<Vec<_>>();
    let active_server_id = if profiles.iter().any(|profile| profile.id == stored.active_server_id) {
        stored.active_server_id
    } else {
        profiles
            .first()
            .map(|profile| profile.id.clone())
            .unwrap_or_else(|| LOCAL_PROFILE_ID.to_string())
    };
    RuntimeProfileStore {
        active_server_id,
        profiles,
    }
}

fn merge_memory_keys(reloaded: &mut RuntimeProfileStore, previous: &RuntimeProfileStore) {
    for profile in &mut reloaded.profiles {
        if profile.access_key.is_some() {
            continue;
        }
        if let Some(previous) = previous
            .profiles
            .iter()
            .find(|item| item.id == profile.id && item.access_key.is_some())
        {
            profile.access_key = previous.access_key.clone();
            profile.key_persisted = false;
        }
    }
}

fn migrate_legacy_local_profile(
    data_dir: &Path,
    settings_port: u16,
    codec: &dyn AccessKeyCodec,
) -> RuntimeProfileStore {
    let port = if settings_port == 0 {
        DESKTOP_DEFAULT_PORT
    } else {
        settings_port
    };
    let origin = format!("http://127.0.0.1:{port}");
    let access_key = load_desktop_access_key(data_dir, codec);
    let mut store = RuntimeProfileStore {
        active_server_id: LOCAL_PROFILE_ID.to_string(),
        profiles: vec![RuntimeProfile {
            id: LOCAL_PROFILE_ID.to_string(),
            name: Some(LOCAL_PROFILE_NAME.to_string()),
            origin,
            allow_insecure_http: false,
            access_key: access_key.clone(),
            key_persisted: false,
        }],
    };
    match save_profile_store(data_dir, &store, codec) {
        Ok(persisted) => {
            let local = persisted
                .profiles
                .iter()
                .find(|profile| profile.id == LOCAL_PROFILE_ID);
            let legacy_path = access_key_file_path(data_dir);
            if local.is_some() && codec.is_available() {
                let persisted_key = local.is_some_and(|profile| profile.key_persisted);
                if persisted_key || access_key.is_none() {
                    let _ = fs::remove_file(legacy_path);
                }
            }
            persisted
        }
        Err(_) => {
            store.profiles[0].key_persisted = false;
            store
        }
    }
}

fn is_stable_profile_id(id: &str) -> bool {
    if id == LOCAL_PROFILE_ID {
        return true;
    }
    let Some(rest) = id.strip_prefix("srv_") else {
        return false;
    };
    (8..=48).contains(&rest.len()) && rest.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ProfileError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| ProfileError::PersistFailed)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|_| ProfileError::PersistFailed)?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(_) => {
            let _ = fs::remove_file(&tmp);
            Err(ProfileError::PersistFailed)
        }
    }
}

fn split_host_port(authority: &str) -> Result<(String, u16), ProfileError> {
    if authority.is_empty() {
        return Err(ProfileError::InvalidAddress);
    }
    if authority.starts_with('[') {
        let end = authority.find(']').ok_or(ProfileError::InvalidAddress)?;
        let host = &authority[..=end];
        let ipv6 = strip_brackets(host);
        if !is_ipv6(&ipv6) {
            return Err(ProfileError::InvalidAddress);
        }
        let port = if authority.len() == end + 1 {
            DESKTOP_DEFAULT_PORT
        } else if authority.as_bytes().get(end + 1) == Some(&b':') {
            parse_port(&authority[end + 2..])?
        } else {
            return Err(ProfileError::InvalidAddress);
        };
        return Ok((format!("[{}]", ipv6.to_ascii_lowercase()), port));
    }
    if authority.matches(':').count() > 1 {
        if !is_ipv6(authority) {
            return Err(ProfileError::InvalidAddress);
        }
        return Ok((
            format!("[{}]", authority.to_ascii_lowercase()),
            DESKTOP_DEFAULT_PORT,
        ));
    }
    if let Some((host, port)) = authority.rsplit_once(':') {
        if host.is_empty() {
            return Err(ProfileError::InvalidAddress);
        }
        return Ok((normalize_host(host)?, parse_port(port)?));
    }
    Ok((normalize_host(authority)?, DESKTOP_DEFAULT_PORT))
}

fn parse_port(raw: &str) -> Result<u16, ProfileError> {
    let port: u16 = raw.parse().map_err(|_| ProfileError::InvalidPort)?;
    if port == 0 {
        return Err(ProfileError::InvalidPort);
    }
    Ok(port)
}

fn normalize_host(host: &str) -> Result<String, ProfileError> {
    let host = host.trim().trim_matches('.').to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 {
        return Err(ProfileError::InvalidAddress);
    }
    if is_ipv4(&host) {
        return Ok(host);
    }
    if !host
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
    {
        return Err(ProfileError::InvalidAddress);
    }
    if host.starts_with('-') || host.ends_with('-') || host.contains("..") {
        return Err(ProfileError::InvalidAddress);
    }
    Ok(host)
}

fn strip_brackets(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
}

fn is_ipv4(host: &str) -> bool {
    let mut parts = host.split('.');
    let mut count = 0;
    for part in parts.by_ref() {
        count += 1;
        if count > 4 {
            return false;
        }
        if part.is_empty() || part.len() > 3 {
            return false;
        }
        if part.len() > 1 && part.starts_with('0') {
            return false;
        }
        if part.parse::<u8>().is_err() {
            return false;
        }
    }
    count == 4
}

fn is_ipv4_loopback(host: &str) -> bool {
    let mut parts = host.split('.');
    let Some(first) = parts.next().and_then(|part| part.parse::<u8>().ok()) else {
        return false;
    };
    first == 127 && is_ipv4(host)
}

fn is_ipv6(host: &str) -> bool {
    let bare = host.to_ascii_lowercase();
    if bare.is_empty() || bare.contains('.') || bare.matches("::").count() > 1 {
        return false;
    }
    let sides: Vec<&str> = bare.split("::").collect();
    let head: Vec<&str> = if sides[0].is_empty() {
        Vec::new()
    } else {
        sides[0].split(':').collect()
    };
    let tail: Vec<&str> = if sides.len() == 2 {
        if sides[1].is_empty() {
            Vec::new()
        } else {
            sides[1].split(':').collect()
        }
    } else {
        Vec::new()
    };
    let total = head.len() + tail.len();
    if sides.len() == 1 {
        if total != 8 {
            return false;
        }
    } else if total > 7 {
        return false;
    }
    head.into_iter()
        .chain(tail)
        .all(|part| (1..=4).contains(&part.len()) && part.chars().all(|ch| ch.is_ascii_hexdigit()))
}
