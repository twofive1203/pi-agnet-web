use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use snail_pi_pet_tauri_preview_lib::access_key::{
    access_key_file_path, clear_desktop_access_key, load_desktop_access_key, save_desktop_access_key,
    AccessKeyCodec, MemoryAccessKeyCodec, ELECTRON_ACCESS_KEY_FILE_NAME, TAURI_ACCESS_KEY_FILE_NAME,
};
use snail_pi_pet_tauri_preview_lib::custom_pets::{
    is_strict_child, read_pet_asset, renderer_catalog_payload, scan_pet_catalog, resolve_codex_root,
    resolve_snail_root,
};
use snail_pi_pet_tauri_preview_lib::settings::{
    electron_settings_file_path, load_desktop_settings, map_electron_settings_preview,
    save_desktop_settings, settings_file_path, ELECTRON_SETTINGS_FILE_NAME,
};
use snail_pi_pet_tauri_preview_lib::{TAURI_PREVIEW_IDENTIFIER, TAURI_SETTINGS_FILE_NAME};

struct TestCodec;

impl AccessKeyCodec for TestCodec {
    fn is_available(&self) -> bool {
        true
    }

    fn encrypt(&self, plain: &str) -> Result<String, String> {
        Ok(format!("v1:{}", plain.chars().rev().collect::<String>()))
    }

    fn decrypt(&self, blob: &str) -> Result<String, String> {
        let rest = blob.strip_prefix("v1:").ok_or_else(|| "corrupt".to_string())?;
        Ok(rest.chars().rev().collect())
    }
}

fn temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "snail-pi-tauri-preview-{label}-{nanos}-{}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn settings_round_trip_is_isolated_from_electron() {
    let preview_dir = temp_dir("preview-settings");
    let electron_dir = temp_dir("electron-settings");
    let electron_path = electron_settings_file_path(&electron_dir);
    fs::write(&electron_path, "{\"port\": 11111, \"selectedPetId\": \"snail-classic\"}\n")
        .expect("seed electron");
    let electron_before = fs::metadata(&electron_path).expect("electron meta").modified().ok();

    let mut settings = load_desktop_settings(&preview_dir);
    settings.port = 22222;
    settings.dnd_enabled = true;
    settings.acknowledged_transition_ids = (0..600).map(|index| format!("t{index}")).collect();
    save_desktop_settings(&preview_dir, &settings).expect("save preview");

    let loaded = load_desktop_settings(&preview_dir);
    assert_eq!(loaded.port, 22222);
    assert!(loaded.dnd_enabled);
    assert_eq!(loaded.acknowledged_transition_ids.len(), 500);
    assert_eq!(
        settings_file_path(&preview_dir).file_name().unwrap(),
        TAURI_SETTINGS_FILE_NAME
    );
    assert_ne!(TAURI_SETTINGS_FILE_NAME, ELECTRON_SETTINGS_FILE_NAME);
    assert!(!preview_dir.join(ELECTRON_SETTINGS_FILE_NAME).exists());

    let electron_after = fs::read_to_string(&electron_path).expect("electron unchanged");
    assert!(electron_after.contains("11111"));
    assert_eq!(
        electron_before,
        fs::metadata(&electron_path).expect("electron meta after").modified().ok()
    );
}

#[test]
fn missing_and_invalid_settings_normalize_like_electron() {
    let dir = temp_dir("normalize");
    fs::write(
        settings_file_path(&dir),
        r#"{
            "version": 0,
            "port": 99999,
            "petScale": "huge",
            "bubbleTheme": "neon",
            "notification": { "completion": "sometimes" },
            "acknowledgedTransitionIds": ["ok", 1, "", "ok"]
        }"#,
    )
    .expect("write invalid");
    let settings = load_desktop_settings(&dir);
    assert_eq!(settings.port, 62666);
    assert_eq!(settings.pet_scale, "medium");
    assert_eq!(settings.bubble_theme, "cream");
    assert_eq!(settings.notification.completion, "background-only");
    assert_eq!(settings.acknowledged_transition_ids, vec!["ok"]);
    assert_eq!(settings.selected_pet_key, "snail:snail-default");
}

#[test]
fn electron_settings_mapper_is_read_only() {
    let raw = json!({
        "selectedPetId": "snail-classic",
        "petScale": 1.5,
        "launchAtLogin": true,
        "notification": { "needsInput": false, "completion": "always" }
    });
    let mapped = map_electron_settings_preview(&raw);
    assert_eq!(mapped.selected_pet_key, "snail:snail-classic");
    assert_eq!(mapped.pet_scale, "large");
    assert!(mapped.launch_at_login);
    assert!(!mapped.notification.needs_input);
    assert_eq!(mapped.notification.completion, "always");
}

#[test]
fn access_key_never_writes_plaintext_and_memory_codec_does_not_persist() {
    let dir = temp_dir("access-key");
    let memory = MemoryAccessKeyCodec;
    assert!(!save_desktop_access_key(&dir, "super-secret-key", &memory).expect("memory save"));
    assert!(!access_key_file_path(&dir).exists());
    assert!(load_desktop_access_key(&dir, &memory).is_none());

    let codec = TestCodec;
    assert!(save_desktop_access_key(&dir, "super-secret-key", &codec).expect("encrypt save"));
    let stored = fs::read_to_string(access_key_file_path(&dir)).expect("read ciphertext");
    assert!(!stored.contains("super-secret-key"));
    assert!(stored.contains("ciphertext"));
    assert_eq!(
        load_desktop_access_key(&dir, &codec).as_deref(),
        Some("super-secret-key")
    );

    fs::write(access_key_file_path(&dir), "{\"version\":1,\"ciphertext\":\"nope\"}\n").unwrap();
    assert!(load_desktop_access_key(&dir, &codec).is_none());
    clear_desktop_access_key(&dir);
    assert!(!access_key_file_path(&dir).exists());
    assert_ne!(TAURI_ACCESS_KEY_FILE_NAME, ELECTRON_ACCESS_KEY_FILE_NAME);
    assert!(!dir.join(ELECTRON_ACCESS_KEY_FILE_NAME).exists());
}

fn write_snail_pack(root: &Path, id: &str, src: &str) {
    let folder = root.join(id);
    fs::create_dir_all(&folder).unwrap();
    let mut states = serde_json::Map::new();
    for (index, state) in [
        "idle",
        "running",
        "retrying",
        "needs_input",
        "ready",
        "blocked",
        "disconnected",
        "service_not_running",
    ]
    .into_iter()
    .enumerate()
    {
        states.insert(
            state.to_string(),
            json!({
                "frame": "sheet.png",
                "staticFrame": "sheet.png",
                "label": "st",
                "glyph": "x",
                "firstFrame": index,
                "frameCount": 1,
                "durationMs": 120,
                "staticFrameIndex": 0
            }),
        );
    }
    let manifest = json!({
        "id": id,
        "name": id,
        "version": 2,
        "renderMode": "spritesheet",
        "states": states,
        "sheet": {
            "src": src,
            "frameWidth": 16,
            "frameHeight": 16,
            "columns": 8,
            "rows": 2
        }
    });
    fs::write(folder.join("manifest.json"), serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    fs::write(folder.join("sheet.png"), vec![0u8; 64]).unwrap();
}

#[test]
fn custom_pet_catalog_is_path_free_and_rejects_escapes() {
    let root = temp_dir("pets");
    write_snail_pack(&root, "custom-snail", "sheet.png");
    write_snail_pack(&root, "Bad Id", "sheet.png");
    let escaped = root.join("escape-pet");
    fs::create_dir_all(&escaped).unwrap();
    fs::write(
        escaped.join("manifest.json"),
        r#"{"id":"escape-pet","name":"escape","version":2,"renderMode":"spritesheet","states":{},"sheet":{"src":"../secret.png","frameWidth":16,"frameHeight":16,"columns":1,"rows":1}}"#,
    )
    .unwrap();

    let outside = temp_dir("codex-pets");
    fs::create_dir_all(outside.join("codex-one")).unwrap();
    fs::write(
        outside.join("codex-one").join("pet.json"),
        r#"{"id":"codex-one","displayName":"Codex One","spritesheetPath":"spritesheet.webp","spriteVersionNumber":1}"#,
    )
    .unwrap();
    fs::write(outside.join("codex-one").join("spritesheet.webp"), vec![1u8; 32]).unwrap();

    let catalog = scan_pet_catalog(&root, &outside);
    let payload = renderer_catalog_payload(&catalog).expect("payload");
    let json = payload.to_string();
    assert!(!json.contains(root.to_string_lossy().as_ref()));
    assert!(!json.contains(outside.to_string_lossy().as_ref()));
    assert!(!json.contains("folderPath"));
    assert!(!json.contains("sheetPath"));
    assert!(!json.contains("accessKey"));
    assert_eq!(
        payload["pets"].as_array().unwrap().len(),
        2,
        "pets={:?} diagnostics={:?}",
        payload["pets"],
        payload["diagnostics"]
    );
    assert!(payload["diagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["reason"] == "bad_id" || item["reason"] == "sheet_src"));

    let pet_key = payload["pets"][0]["petKey"].as_str().unwrap().to_string();
    let asset = read_pet_asset(&catalog, &pet_key);
    assert_eq!(asset["ok"], true);
    assert!(asset.get("path").is_none());
    assert!(asset.get("sheetPath").is_none());
    assert!(asset["bytesBase64"].as_str().unwrap().len() > 4);

    assert!(!is_strict_child(&root, &root));
    assert!(is_strict_child(&root, &root.join("custom-snail")));
}

#[test]
fn preview_identity_does_not_share_electron_secret_paths() {
    assert!(TAURI_PREVIEW_IDENTIFIER.ends_with("tauri-preview"));
    assert_ne!(TAURI_SETTINGS_FILE_NAME, ELECTRON_SETTINGS_FILE_NAME);
    let snail = resolve_snail_root();
    let codex = resolve_codex_root();
    assert!(snail.ends_with("desktop-pets") || std::env::var("SNAIL_PET_CUSTOM_PETS_DIR").is_ok());
    assert!(codex.ends_with("pets") || std::env::var("CODEX_HOME").is_ok());
}
