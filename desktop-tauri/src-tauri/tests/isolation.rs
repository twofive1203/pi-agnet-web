use std::{fs, path::PathBuf};

use serde_json::Value;
use snail_pi_pet_tauri_preview_lib::access_key::TAURI_ACCESS_KEY_FILE_NAME;
use snail_pi_pet_tauri_preview_lib::{
    TAURI_PREVIEW_EXECUTABLE, TAURI_PREVIEW_IDENTIFIER, TAURI_SETTINGS_FILE_NAME,
};

const ELECTRON_IDENTIFIER: &str = "com.twofive.snail-pi-pet";
const ELECTRON_EXECUTABLE: &str = "snail-pi-pet";
const ELECTRON_SETTINGS_FILE: &str = "desktop-pet-settings.json";

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn preview_identity_and_writable_state_are_isolated_from_electron() {
    assert_ne!(TAURI_PREVIEW_IDENTIFIER, ELECTRON_IDENTIFIER);
    assert_ne!(TAURI_PREVIEW_EXECUTABLE, ELECTRON_EXECUTABLE);
    assert_ne!(TAURI_SETTINGS_FILE_NAME, ELECTRON_SETTINGS_FILE);
    assert_ne!(TAURI_ACCESS_KEY_FILE_NAME, "desktop-pet-access-key.json");
    assert!(TAURI_PREVIEW_IDENTIFIER.ends_with("tauri-preview"));
    assert!(TAURI_PREVIEW_EXECUTABLE.ends_with("tauri-preview"));

    let config: Value = serde_json::from_str(
        &fs::read_to_string(manifest_dir().join("tauri.conf.json")).expect("read tauri config"),
    )
    .expect("parse tauri config");
    assert_eq!(config["identifier"], TAURI_PREVIEW_IDENTIFIER);
    assert_ne!(config["productName"], "SnailPiPet");
    assert_eq!(config["build"]["frontendDist"], "../dist");
    assert_eq!(
        config["bundle"]["windows"]["webviewInstallMode"]["type"],
        "embedBootstrapper"
    );
}

#[test]
fn capability_has_no_privileged_plugin_wildcards() {
    let capability: Value = serde_json::from_str(
        &fs::read_to_string(manifest_dir().join("capabilities/default.json"))
            .expect("read capability"),
    )
    .expect("parse capability");
    assert_eq!(capability["windows"], serde_json::json!(["pet"]));
    let permissions = capability["permissions"]
        .as_array()
        .expect("permissions array")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    for forbidden in ["shell", "process", "fs:", "http:", "opener", "*"] {
        assert!(
            !permissions.contains(forbidden),
            "forbidden permission: {forbidden}"
        );
    }
}
