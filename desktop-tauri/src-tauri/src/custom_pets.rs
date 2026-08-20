use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::{json, Value};

use crate::activity_view::assert_renderer_view_safe;
use crate::settings::{is_custom_pet_id, is_pet_key};

pub const CUSTOM_PET_MAX_COUNT: usize = 16;
pub const CODEX_PET_MAX_COUNT: usize = 24;
pub const SNAIL_MAX_MANIFEST_BYTES: u64 = 16 * 1024;
pub const SNAIL_MAX_FILE_BYTES: u64 = 256 * 1024;
pub const CODEX_MAX_MANIFEST_BYTES: u64 = 16 * 1024;
pub const CODEX_MAX_FILE_BYTES: u64 = 6 * 1024 * 1024;
pub const MAX_PATH_LENGTH: usize = 80;
const BUILTIN_PET_IDS: [&str; 3] = ["snail-default", "snail-classic", "snail-sprite"];
const REQUIRED_STATES: [&str; 8] = [
    "idle",
    "running",
    "retrying",
    "needs_input",
    "ready",
    "blocked",
    "disconnected",
    "service_not_running",
];
const FORBIDDEN_CAPABILITY_KEYS: [&str; 13] = [
    "command",
    "commands",
    "url",
    "href",
    "skill",
    "skills",
    "tools",
    "execute",
    "prompt",
    "cwd",
    "token",
    "observerToken",
    "accessKey",
];
const CUSTOM_PETS_ENV_DIR: &str = "SNAIL_PET_CUSTOM_PETS_DIR";
const CODEX_HOME_ENV: &str = "CODEX_HOME";

#[derive(Debug, Clone)]
pub struct PetAssetLocator {
    pub pet_key: String,
    pub format: String,
    pub folder_path: PathBuf,
    pub sheet_path: PathBuf,
    pub mime: String,
    pub size: u64,
    pub mtime_ms: i64,
    pub expected_width: u32,
    pub expected_height: u32,
}

#[derive(Debug, Clone)]
pub struct PetCatalogState {
    pub revision: u32,
    pub entries: Vec<Value>,
    pub locators: BTreeMap<String, PetAssetLocator>,
    pub diagnostics: Vec<Value>,
}

impl PetCatalogState {
    pub fn empty() -> Self {
        Self {
            revision: 0,
            entries: Vec::new(),
            locators: BTreeMap::new(),
            diagnostics: Vec::new(),
        }
    }
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn resolve_snail_root() -> PathBuf {
    if let Ok(value) = std::env::var(CUSTOM_PETS_ENV_DIR) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed.trim_end_matches(['/', '\\']));
        }
    }
    if let Ok(value) = std::env::var("PI_CODING_AGENT_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed.trim_end_matches(['/', '\\'])).join("desktop-pets");
        }
    }
    home_dir().join(".pi").join("agent").join("desktop-pets")
}

pub fn resolve_codex_root() -> PathBuf {
    let home = if let Ok(value) = std::env::var(CODEX_HOME_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            PathBuf::from(trimmed.trim_end_matches(['/', '\\']))
        } else {
            home_dir().join(".codex")
        }
    } else {
        home_dir().join(".codex")
    };
    home.join("pets")
}

pub fn scan_pet_catalog(snail_root: &Path, codex_root: &Path) -> PetCatalogState {
    let mut state = PetCatalogState::empty();
    state.revision = 1;
    scan_snail_root(&mut state, snail_root);
    scan_codex_root(&mut state, snail_root, "snail-custom");
    scan_codex_root(&mut state, codex_root, "codex-home");
    state.entries.sort_by(|left, right| {
        let left_format = left.get("format").and_then(Value::as_str).unwrap_or("");
        let right_format = right.get("format").and_then(Value::as_str).unwrap_or("");
        left_format.cmp(right_format).then_with(|| {
            let left_id = left.get("id").and_then(Value::as_str).unwrap_or("");
            let right_id = right.get("id").and_then(Value::as_str).unwrap_or("");
            left_id.cmp(right_id)
        })
    });
    if state.diagnostics.len() > CUSTOM_PET_MAX_COUNT + CODEX_PET_MAX_COUNT + 8 {
        state
            .diagnostics
            .truncate(CUSTOM_PET_MAX_COUNT + CODEX_PET_MAX_COUNT + 8);
    }
    state
}

pub fn renderer_catalog_payload(state: &PetCatalogState) -> Result<Value, String> {
    let payload = json!({
        "revision": state.revision,
        "pets": state.entries,
        "diagnostics": state.diagnostics,
    });
    assert_catalog_safe(&payload)?;
    Ok(payload)
}

pub fn read_pet_asset(state: &PetCatalogState, pet_key: &str) -> Value {
    if !is_pet_key(pet_key) {
        return json!({ "ok": false, "reason": "invalid_key" });
    }
    if pet_key.starts_with("snail:") && BUILTIN_PET_IDS.iter().any(|id| *id == &pet_key[6..]) {
        return json!({ "ok": false, "reason": "not_found" });
    }
    let Some(locator) = state.locators.get(pet_key) else {
        return json!({ "ok": false, "reason": "not_found" });
    };
    let max_bytes = if locator.format == "codex" {
        CODEX_MAX_FILE_BYTES
    } else {
        SNAIL_MAX_FILE_BYTES
    };
    let Ok(meta) = fs::metadata(&locator.sheet_path) else {
        return json!({ "ok": false, "reason": "changed" });
    };
    let size = meta.len();
    let mtime_ms = mtime_millis(&meta);
    if size != locator.size || mtime_ms != locator.mtime_ms {
        return json!({ "ok": false, "reason": "changed" });
    }
    if size == 0 || size > max_bytes {
        return json!({ "ok": false, "reason": "size" });
    }
    let Ok(bytes) = fs::read(&locator.sheet_path) else {
        return json!({ "ok": false, "reason": "read_failed" });
    };
    if bytes.len() as u64 != size {
        return json!({ "ok": false, "reason": "changed" });
    }
    let payload = json!({
        "ok": true,
        "petKey": locator.pet_key,
        "mime": locator.mime,
        "bytesBase64": STANDARD.encode(bytes),
        "fingerprint": format!("{}:{}", locator.size, locator.mtime_ms),
        "expectedWidth": locator.expected_width,
        "expectedHeight": locator.expected_height,
    });
    if assert_catalog_safe(&payload).is_err() {
        return json!({ "ok": false, "reason": "unsafe_content" });
    }
    payload
}

fn scan_snail_root(state: &mut PetCatalogState, root: &Path) {
    if !root.exists() {
        return;
    }
    let Ok(root_real) = canonicalize_dir(root) else {
        push_diagnostic(state, None, "snail-custom", "root_unreadable");
        return;
    };
    let Ok(entries) = fs::read_dir(&root_real) else {
        push_diagnostic(state, None, "snail-custom", "root_unreadable");
        return;
    };
    let mut names = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    let mut accepted = 0usize;
    for name in names {
        let folder = root_real.join(&name);
        if folder.join("manifest.json").exists() {
            if accepted >= CUSTOM_PET_MAX_COUNT {
                push_diagnostic(state, Some(&name), "snail-custom", "too_many_pets");
                continue;
            }
            match inspect_snail_folder(&root_real, &name) {
                Ok((entry, locator)) => {
                    state.entries.push(entry);
                    state.locators.insert(locator.pet_key.clone(), locator);
                    accepted += 1;
                }
                Err(reason) => push_diagnostic(state, Some(&name), "snail-custom", &reason),
            }
        } else if !folder.join("pet.json").exists() {
            push_diagnostic(
                state,
                Some(&name),
                "snail-custom",
                if is_custom_pet_id(&name) {
                    "manifest_missing"
                } else {
                    "bad_id"
                },
            );
        }
    }
}

fn scan_codex_root(state: &mut PetCatalogState, root: &Path, source: &str) {
    if !root.exists() {
        return;
    }
    let Ok(root_real) = canonicalize_dir(root) else {
        if source == "codex-home" {
            push_diagnostic(state, None, source, "root_unreadable");
        }
        return;
    };
    let Ok(entries) = fs::read_dir(&root_real) else {
        push_diagnostic(state, None, source, "root_unreadable");
        return;
    };
    let mut names = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    let mut accepted = state
        .entries
        .iter()
        .filter(|entry| entry.get("format").and_then(Value::as_str) == Some("codex"))
        .count();
    let mut seen_ids = state
        .entries
        .iter()
        .filter_map(|entry| {
            if entry.get("format").and_then(Value::as_str) == Some("codex") {
                entry.get("id").and_then(Value::as_str).map(ToString::to_string)
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    for name in names {
        if !root_real.join(&name).join("pet.json").exists() {
            continue;
        }
        if accepted >= CODEX_PET_MAX_COUNT {
            push_diagnostic(state, Some(&name), source, "too_many_pets");
            continue;
        }
        match inspect_codex_folder(&root_real, &name, source) {
            Ok((entry, locator)) => {
                let id = entry.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                if seen_ids.iter().any(|existing| existing == &id) {
                    push_diagnostic(state, Some(&id), source, "duplicate_codex_id");
                    continue;
                }
                seen_ids.push(id);
                state.entries.push(entry);
                state.locators.insert(locator.pet_key.clone(), locator);
                accepted += 1;
            }
            Err(reason) => push_diagnostic(state, Some(&name), source, &reason),
        }
    }
}

fn inspect_snail_folder(root_real: &Path, name: &str) -> Result<(Value, PetAssetLocator), String> {
    if !is_custom_pet_id(name) {
        return Err("bad_id".to_string());
    }
    if BUILTIN_PET_IDS.contains(&name) {
        return Err("builtin_id_collision".to_string());
    }
    let folder = root_real.join(name);
    let folder_real = canonicalize_dir(&folder)?;
    if !is_strict_child(root_real, &folder_real) {
        return Err("symlink_escape".to_string());
    }
    let manifest_path = folder_real.join("manifest.json");
    let manifest_bytes = file_size(&manifest_path)?;
    if manifest_bytes == 0 || manifest_bytes > SNAIL_MAX_MANIFEST_BYTES {
        return Err("manifest_size".to_string());
    }
    let raw: Value = serde_json::from_str(&fs::read_to_string(&manifest_path).map_err(|_| "manifest_json".to_string())?)
        .map_err(|_| "manifest_json".to_string())?;
    let sheet = validate_snail_manifest(&raw, name)?;
    let sheet_path = folder_real.join(&sheet.src);
    let sheet_real = canonicalize_file(&sheet_path)?;
    if !is_strict_child(&folder_real, &sheet_real) {
        return Err("symlink_escape".to_string());
    }
    let mime = sheet_mime(&sheet.src).ok_or_else(|| "sheet_type".to_string())?;
    let size = file_size(&sheet_real)?;
    if size == 0 || size > SNAIL_MAX_FILE_BYTES {
        return Err("sheet_size".to_string());
    }
    let pet_key = format!("snail:{name}");
    let entry = json!({
        "petKey": pet_key,
        "format": "snail",
        "source": "snail-custom",
        "id": name,
        "name": raw.get("name").and_then(Value::as_str).unwrap_or(name),
        "description": Value::Null,
        "cssToken": format!("snail-{name}"),
        "spriteVersion": Value::Null,
        "capabilities": {
            "look": false,
            "directionalRun": false,
            "waving": false,
        },
        "snailManifest": raw,
    });
    if unsafe_display(&entry) {
        return Err("unsafe_content".to_string());
    }
    Ok((
        entry,
        PetAssetLocator {
            pet_key,
            format: "snail".to_string(),
            folder_path: folder_real,
            sheet_path: sheet_real,
            mime: mime.to_string(),
            size,
            mtime_ms: mtime_millis(&fs::metadata(&sheet_path).map_err(|_| "sheet_read".to_string())?),
            expected_width: sheet.expected_width,
            expected_height: sheet.expected_height,
        },
    ))
}

struct SheetSpec {
    src: String,
    expected_width: u32,
    expected_height: u32,
}

fn validate_snail_manifest(raw: &Value, expected_id: &str) -> Result<SheetSpec, String> {
    let object = raw.as_object().ok_or_else(|| "not_object".to_string())?;
    for key in object.keys() {
        if !matches!(key.as_str(), "id" | "name" | "version" | "renderMode" | "states" | "sheet") {
            return Err(format!("unknown_field:{key}"));
        }
    }
    if let Some(key) = first_forbidden_key(raw) {
        return Err(format!("capability:{key}"));
    }
    if object.get("id").and_then(Value::as_str) != Some(expected_id) || !is_custom_pet_id(expected_id) {
        return Err("id".to_string());
    }
    let name = object.get("name").and_then(Value::as_str).unwrap_or("");
    if name.is_empty() || name.len() > 32 {
        return Err("name".to_string());
    }
    if object.get("version").and_then(Value::as_u64) != Some(2) {
        return Err("version".to_string());
    }
    if object.get("renderMode").and_then(Value::as_str) != Some("spritesheet") {
        return Err("custom_render_mode".to_string());
    }
    let states = object
        .get("states")
        .and_then(Value::as_object)
        .ok_or_else(|| "states".to_string())?;
    let sheet = object
        .get("sheet")
        .and_then(Value::as_object)
        .ok_or_else(|| "sheet_missing".to_string())?;
    for key in sheet.keys() {
        if !matches!(key.as_str(), "src" | "frameWidth" | "frameHeight" | "columns" | "rows") {
            return Err(format!("sheet_unknown_field:{key}"));
        }
    }
    let src = sheet.get("src").and_then(Value::as_str).unwrap_or("");
    if !is_safe_pet_asset_path(src) || !(src.ends_with(".png") || src.ends_with(".webp") || src.ends_with(".PNG") || src.ends_with(".WEBP")) {
        return Err("sheet_src".to_string());
    }
    let frame_width = positive_u32(sheet.get("frameWidth"), 2048).ok_or_else(|| "sheet_frameWidth_invalid".to_string())?;
    let frame_height = positive_u32(sheet.get("frameHeight"), 2048).ok_or_else(|| "sheet_frameHeight_invalid".to_string())?;
    let columns = positive_u32(sheet.get("columns"), 16).ok_or_else(|| "sheet_columns_invalid".to_string())?;
    let rows = positive_u32(sheet.get("rows"), 16).ok_or_else(|| "sheet_rows_invalid".to_string())?;
    if frame_width.saturating_mul(columns) > 2048 {
        return Err("sheet_width".to_string());
    }
    if frame_height.saturating_mul(rows) > 2048 {
        return Err("sheet_height".to_string());
    }
    let capacity = columns.saturating_mul(rows);
    for state in REQUIRED_STATES {
        let frame = states.get(state).ok_or_else(|| format!("missing_state:{state}"))?;
        validate_frame(state, frame, columns, capacity)?;
    }
    Ok(SheetSpec {
        src: src.to_string(),
        expected_width: frame_width.saturating_mul(columns),
        expected_height: frame_height.saturating_mul(rows),
    })
}

fn validate_frame(state: &str, raw: &Value, columns: u32, capacity: u32) -> Result<(), String> {
    let object = raw.as_object().ok_or_else(|| format!("{state}_frame_missing"))?;
    for key in object.keys() {
        if !matches!(
            key.as_str(),
            "frame" | "staticFrame" | "label" | "glyph" | "firstFrame" | "frameCount" | "durationMs" | "staticFrameIndex"
        ) {
            return Err(format!("{state}_unknown_field"));
        }
    }
    let frame = object.get("frame").and_then(Value::as_str).unwrap_or("");
    if !is_safe_pet_asset_path(frame) {
        return Err(format!("{state}_frame_path"));
    }
    let static_frame = object.get("staticFrame").and_then(Value::as_str).unwrap_or("");
    if !is_safe_pet_asset_path(static_frame) {
        return Err(format!("{state}_static_frame_path"));
    }
    let label = object.get("label").and_then(Value::as_str).unwrap_or("");
    if label.is_empty() || label.len() > 16 {
        return Err(format!("{state}_label"));
    }
    let glyph = object.get("glyph").and_then(Value::as_str).unwrap_or("");
    if glyph.is_empty() || glyph.chars().count() > 4 {
        return Err(format!("{state}_glyph"));
    }
    let first_frame = object
        .get("firstFrame")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{state}_sprite_timing_missing"))? as u32;
    let frame_count = object
        .get("frameCount")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{state}_sprite_timing_missing"))? as u32;
    let duration = object
        .get("durationMs")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{state}_sprite_timing_missing"))?;
    let static_index = object
        .get("staticFrameIndex")
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{state}_sprite_timing_missing"))? as u32;
    if !(50..=5000).contains(&duration) {
        return Err(format!("{state}_duration"));
    }
    if frame_count == 0 || frame_count > 16 {
        return Err(format!("{state}_frameCount_invalid"));
    }
    if first_frame + frame_count > capacity {
        return Err(format!("{state}_frame_range"));
    }
    if first_frame / columns != (first_frame + frame_count - 1) / columns {
        return Err(format!("{state}_frame_wraps_row"));
    }
    if static_index >= frame_count {
        return Err(format!("{state}_static_index"));
    }
    Ok(())
}

fn inspect_codex_folder(root_real: &Path, name: &str, source: &str) -> Result<(Value, PetAssetLocator), String> {
    if !is_custom_pet_id(name) {
        return Err("bad_id".to_string());
    }
    let folder = root_real.join(name);
    let folder_real = canonicalize_dir(&folder)?;
    if !is_strict_child(root_real, &folder_real) {
        return Err("symlink_escape".to_string());
    }
    let manifest_path = folder_real.join("pet.json");
    let manifest_bytes = file_size(&manifest_path)?;
    if manifest_bytes == 0 || manifest_bytes > CODEX_MAX_MANIFEST_BYTES {
        return Err("manifest_size".to_string());
    }
    let raw: Value = serde_json::from_str(&fs::read_to_string(&manifest_path).map_err(|_| "manifest_json".to_string())?)
        .map_err(|_| "manifest_json".to_string())?;
    let object = raw.as_object().ok_or_else(|| "not_object".to_string())?;
    let id = object.get("id").and_then(Value::as_str).unwrap_or("");
    if id != name || !is_custom_pet_id(id) {
        return Err("id".to_string());
    }
    let version = match object.get("spriteVersionNumber") {
        None => 1u64,
        Some(Value::Number(n)) if n.as_u64() == Some(1) => 1,
        Some(Value::Number(n)) if n.as_u64() == Some(2) => 2,
        _ => return Err("sprite_version".to_string()),
    };
    let spritesheet_path = object
        .get("spritesheetPath")
        .and_then(Value::as_str)
        .unwrap_or("");
    if spritesheet_path.is_empty() {
        return Err("spritesheet_missing".to_string());
    }
    if !is_safe_pet_asset_path(spritesheet_path)
        || !(spritesheet_path.to_ascii_lowercase().ends_with(".png")
            || spritesheet_path.to_ascii_lowercase().ends_with(".webp"))
    {
        return Err("spritesheet_path".to_string());
    }
    let display_name = match object.get("displayName") {
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 64 => value.clone(),
        None => id.to_string(),
        _ => return Err("displayName".to_string()),
    };
    let description = match object.get("description") {
        Some(Value::String(value)) if value.len() <= 200 => Some(value.clone()),
        None => None,
        _ => return Err("description".to_string()),
    };
    if unsafe_text(&display_name) || description.as_deref().is_some_and(unsafe_text) || unsafe_text(id) {
        return Err("unsafe_content".to_string());
    }
    let sheet_path = folder_real.join(spritesheet_path);
    if !sheet_path.exists() {
        return Err("sheet_missing".to_string());
    }
    let sheet_real = canonicalize_file(&sheet_path)?;
    if !is_strict_child(&folder_real, &sheet_real) {
        return Err("symlink_escape".to_string());
    }
    let mime = sheet_mime(spritesheet_path).ok_or_else(|| "sheet_type".to_string())?;
    let size = file_size(&sheet_real)?;
    if size == 0 || size > CODEX_MAX_FILE_BYTES {
        return Err("sheet_size".to_string());
    }
    let (expected_width, expected_height) = if version == 2 {
        (1536, 2288)
    } else {
        (1536, 1872)
    };
    let pet_key = format!("codex:{id}");
    let entry = json!({
        "petKey": pet_key,
        "format": "codex",
        "source": source,
        "id": id,
        "name": display_name,
        "description": description,
        "cssToken": format!("codex-{id}"),
        "spriteVersion": version,
        "capabilities": {
            "look": true,
            "directionalRun": true,
            "waving": true,
        },
        "snailManifest": Value::Null,
    });
    Ok((
        entry,
        PetAssetLocator {
            pet_key,
            format: "codex".to_string(),
            folder_path: folder_real,
            sheet_path: sheet_real.clone(),
            mime: mime.to_string(),
            size,
            mtime_ms: mtime_millis(&fs::metadata(&sheet_real).map_err(|_| "sheet_read".to_string())?),
            expected_width,
            expected_height,
        },
    ))
}

fn is_safe_pet_asset_path(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_PATH_LENGTH {
        return false;
    }
    if value.contains('\\') || value.contains("..") {
        return false;
    }
    if value.starts_with('/') || value.starts_with('~') {
        return false;
    }
    if value.contains(':') {
        return false;
    }
    value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '/'))
}

fn sheet_mime(src: &str) -> Option<&'static str> {
    let lower = src.to_ascii_lowercase();
    if lower.ends_with(".png") {
        Some("image/png")
    } else if lower.ends_with(".webp") {
        Some("image/webp")
    } else {
        None
    }
}

fn first_forbidden_key(value: &Value) -> Option<String> {
    match value {
        Value::Object(object) => {
            for (key, nested) in object {
                if FORBIDDEN_CAPABILITY_KEYS.contains(&key.as_str()) {
                    return Some(key.clone());
                }
                if let Some(found) = first_forbidden_key(nested) {
                    return Some(found);
                }
            }
            None
        }
        Value::Array(items) => items.iter().find_map(first_forbidden_key),
        _ => None,
    }
}

fn unsafe_display(value: &Value) -> bool {
    serde_json::to_string(value)
        .ok()
        .is_some_and(|json| json.to_ascii_lowercase().contains("http://") || json.to_ascii_lowercase().contains("https://"))
}

fn unsafe_text(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("http://") || lower.contains("https://")
}

fn canonicalize_dir(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|_| "symlink_escape".to_string())
}

fn canonicalize_file(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|_| "symlink_escape".to_string())
}

pub fn normalize_compare_path(value: &Path) -> String {
    value.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}

pub fn is_contained_path(root: &Path, candidate: &Path) -> bool {
    let root_norm = normalize_compare_path(root);
    let candidate_norm = normalize_compare_path(candidate);
    candidate_norm == root_norm || candidate_norm.starts_with(&format!("{root_norm}/"))
}

pub fn is_strict_child(root: &Path, candidate: &Path) -> bool {
    is_contained_path(root, candidate) && normalize_compare_path(root) != normalize_compare_path(candidate)
}

fn file_size(path: &Path) -> Result<u64, String> {
    fs::metadata(path)
        .map(|meta| meta.len())
        .map_err(|_| "sheet_missing".to_string())
}

fn mtime_millis(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn positive_u32(value: Option<&Value>, max: u32) -> Option<u32> {
    let number = value.and_then(Value::as_u64)?;
    if number == 0 || number > u64::from(max) {
        return None;
    }
    Some(number as u32)
}

fn push_diagnostic(state: &mut PetCatalogState, pet_id: Option<&str>, source: &str, reason: &str) {
    state.diagnostics.push(json!({
        "petId": pet_id,
        "petKey": Value::Null,
        "source": source,
        "reason": reason,
    }));
}

fn assert_catalog_safe(payload: &Value) -> Result<(), String> {
    assert_renderer_view_safe(payload)?;
    let json = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    for key in ["folderPath", "sheetPath", "path", "accessKey"] {
        if json.contains(&format!("\"{key}\":")) {
            return Err(format!("catalog leaked {key}"));
        }
    }
    Ok(())
}
