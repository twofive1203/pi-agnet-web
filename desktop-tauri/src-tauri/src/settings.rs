use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::activity_view::{
    default_desktop_settings, DesktopPetSettings, NotificationSettings, SoundSettings, WindowPosition,
};
use crate::{TAURI_PREVIEW_IDENTIFIER, TAURI_SETTINGS_FILE_NAME};

pub const ELECTRON_SETTINGS_FILE_NAME: &str = "desktop-pet-settings.json";
pub const DESKTOP_SETTINGS_VERSION: u32 = 1;
pub const MAX_TRANSITION_LRU: usize = 500;
const DEFAULT_PORT: u16 = 62666;
const DEFAULT_PET_ID: &str = "snail-default";
const DEFAULT_PET_KEY: &str = "snail:snail-default";
const BUILTIN_PET_IDS: [&str; 3] = ["snail-default", "snail-classic", "snail-sprite"];
const PET_SCALES: [&str; 3] = ["small", "medium", "large"];
const BUBBLE_THEMES: [&str; 6] = ["cream", "peach", "night", "ember", "plum", "moss"];
const FORBIDDEN_SETTINGS_KEYS: [&str; 14] = [
    "token",
    "observerToken",
    "accessKey",
    "password",
    "pid",
    "servicePid",
    "childPid",
    "cwd",
    "cwds",
    "prompt",
    "firstMessage",
    "command",
    "output",
    "startCommand",
];

pub fn settings_file_path(data_dir: &Path) -> PathBuf {
    data_dir.join(TAURI_SETTINGS_FILE_NAME)
}

pub fn electron_settings_file_path(electron_user_data: &Path) -> PathBuf {
    electron_user_data.join(ELECTRON_SETTINGS_FILE_NAME)
}

pub fn load_desktop_settings(data_dir: &Path) -> DesktopPetSettings {
    let path = settings_file_path(data_dir);
    match fs::read_to_string(&path) {
        Ok(text) => parse_desktop_settings_json(&text),
        Err(_) => default_desktop_settings(),
    }
}

pub fn save_desktop_settings(data_dir: &Path, settings: &DesktopPetSettings) -> Result<(), String> {
    let normalized = normalize_desktop_settings(&serde_json::to_value(settings).unwrap_or(json!({})));
    assert_desktop_settings_safe(&normalized)?;
    fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let serialized = format!(
        "{}\n",
        serde_json::to_string_pretty(&normalized).map_err(|error| error.to_string())?
    );
    fs::write(settings_file_path(data_dir), serialized).map_err(|error| error.to_string())
}

pub fn parse_desktop_settings_json(text: &str) -> DesktopPetSettings {
    match serde_json::from_str::<Value>(text) {
        Ok(value) => normalize_desktop_settings(&value),
        Err(_) => default_desktop_settings(),
    }
}

pub fn apply_settings_patch(current: DesktopPetSettings, patch: &Value) -> DesktopPetSettings {
    let mut merged = serde_json::to_value(&current).unwrap_or_else(|_| json!({}));
    if let (Some(target), Some(source)) = (merged.as_object_mut(), patch.as_object()) {
        for (key, value) in source {
            if key == "notification" || key == "sound" {
                if let (Some(existing), Some(incoming)) = (
                    target.get_mut(key).and_then(Value::as_object_mut),
                    value.as_object(),
                ) {
                    for (nested_key, nested_value) in incoming {
                        existing.insert(nested_key.clone(), nested_value.clone());
                    }
                    continue;
                }
            }
            target.insert(key.clone(), value.clone());
        }
    }
    normalize_desktop_settings(&merged)
}

/// Read-only mapper for a future Electron import. Never writes files.
pub fn map_electron_settings_preview(raw: &Value) -> DesktopPetSettings {
    normalize_desktop_settings(raw)
}

pub fn normalize_desktop_settings(input: &Value) -> DesktopPetSettings {
    let raw = input.as_object();
    let port = clamp_port(raw.and_then(|object| object.get("port")));
    let selected_pet_key = resolve_pet_key(
        raw.and_then(|object| object.get("selectedPetKey")),
        raw.and_then(|object| object.get("selectedPetId")),
    );
    let selected_pet_id = pet_id_from_key(&selected_pet_key);
    let notification_raw = raw
        .and_then(|object| object.get("notification"))
        .and_then(Value::as_object);
    let sound_raw = raw
        .and_then(|object| object.get("sound"))
        .and_then(Value::as_object);
    DesktopPetSettings {
        version: DESKTOP_SETTINGS_VERSION,
        port,
        selected_pet_id,
        selected_pet_key,
        pet_scale: normalize_pet_scale(raw.and_then(|object| object.get("petScale"))),
        bubble_theme: normalize_bubble_theme(raw.and_then(|object| object.get("bubbleTheme"))),
        always_on_top: raw
            .and_then(|object| object.get("alwaysOnTop"))
            .and_then(Value::as_bool)
            != Some(false),
        click_through: raw
            .and_then(|object| object.get("clickThrough"))
            .and_then(Value::as_bool)
            == Some(true),
        launch_at_login: raw
            .and_then(|object| object.get("launchAtLogin"))
            .and_then(Value::as_bool)
            == Some(true),
        activity_tray_open: raw
            .and_then(|object| object.get("activityTrayOpen"))
            .and_then(Value::as_bool)
            == Some(true),
        show_context_meter: raw
            .and_then(|object| object.get("showContextMeter"))
            .and_then(Value::as_bool)
            != Some(false),
        right_click_aggregated_menu: raw
            .and_then(|object| object.get("rightClickAggregatedMenu"))
            .and_then(Value::as_bool)
            == Some(true),
        dnd_enabled: raw
            .and_then(|object| object.get("dndEnabled"))
            .and_then(Value::as_bool)
            == Some(true),
        window_position: normalize_window_position(raw.and_then(|object| object.get("windowPosition"))),
        notification: NotificationSettings {
            needs_input: notification_raw
                .and_then(|object| object.get("needsInput"))
                .and_then(Value::as_bool)
                != Some(false),
            blocked: notification_raw
                .and_then(|object| object.get("blocked"))
                .and_then(Value::as_bool)
                != Some(false),
            completion: normalize_completion(
                notification_raw.and_then(|object| object.get("completion")),
            ),
        },
        sound: SoundSettings {
            master_enabled: sound_raw
                .and_then(|object| object.get("masterEnabled"))
                .and_then(Value::as_bool)
                == Some(true),
            needs_input: sound_raw
                .and_then(|object| object.get("needsInput"))
                .and_then(Value::as_bool)
                != Some(false),
            completion: sound_raw
                .and_then(|object| object.get("completion"))
                .and_then(Value::as_bool)
                != Some(false),
        },
        acknowledged_transition_ids: normalize_id_list(
            raw.and_then(|object| object.get("acknowledgedTransitionIds")),
        ),
        notified_transition_ids: normalize_id_list(
            raw.and_then(|object| object.get("notifiedTransitionIds")),
        ),
        sounded_transition_ids: normalize_id_list(
            raw.and_then(|object| object.get("soundedTransitionIds")),
        ),
    }
}

pub fn assert_desktop_settings_safe(settings: &DesktopPetSettings) -> Result<(), String> {
    let json = serde_json::to_string(settings).map_err(|error| error.to_string())?;
    for key in FORBIDDEN_SETTINGS_KEYS {
        if key == "startCommand" {
            continue;
        }
        let pattern = format!("\"{key}\":");
        if json.contains(&pattern) {
            return Err(format!("forbidden settings key: {key}"));
        }
    }
    if json.contains(TAURI_PREVIEW_IDENTIFIER) && json.contains("accessKey") {
        return Err("forbidden settings key: accessKey".to_string());
    }
    Ok(())
}

fn clamp_port(value: Option<&Value>) -> u16 {
    let number = match value {
        Some(Value::Number(number)) => number.as_u64().or_else(|| number.as_i64().map(|n| n as u64)),
        Some(Value::String(text)) => text.parse::<u64>().ok(),
        _ => None,
    };
    match number {
        Some(port) if (1..=65535).contains(&port) => port as u16,
        _ => DEFAULT_PORT,
    }
}

pub(crate) fn is_pet_key(value: &str) -> bool {
    let Some((format, rest)) = value.split_once(':') else {
        return false;
    };
    (format == "snail" || format == "codex") && is_custom_pet_id(rest)
}

pub(crate) fn is_custom_pet_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if value.len() > 64 || !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    value
        .chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-')
}

fn resolve_pet_key(selected_pet_key: Option<&Value>, selected_pet_id: Option<&Value>) -> String {
    if let Some(Value::String(key)) = selected_pet_key {
        if is_pet_key(key) {
            return key.clone();
        }
    }
    if let Some(Value::String(id)) = selected_pet_id {
        if is_pet_key(id) {
            return id.clone();
        }
        if BUILTIN_PET_IDS.contains(&id.as_str()) || is_custom_pet_id(id) {
            return format!("snail:{id}");
        }
    }
    DEFAULT_PET_KEY.to_string()
}

fn pet_id_from_key(key: &str) -> String {
    key.split_once(':')
        .map(|(_, id)| id.to_string())
        .unwrap_or_else(|| DEFAULT_PET_ID.to_string())
}

fn normalize_pet_scale(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(scale)) if PET_SCALES.contains(&scale.as_str()) => scale.clone(),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(1.0) => "small".to_string(),
            Some(1.2) => "medium".to_string(),
            Some(1.5) => "large".to_string(),
            Some(n) if (n - 0.85).abs() < f64::EPSILON => "small".to_string(),
            _ => "medium".to_string(),
        },
        Some(Value::String(text)) => match text.parse::<f64>() {
            Ok(1.0) => "small".to_string(),
            Ok(1.2) => "medium".to_string(),
            Ok(1.5) => "large".to_string(),
            Ok(n) if (n - 0.85).abs() < f64::EPSILON => "small".to_string(),
            _ => "medium".to_string(),
        },
        _ => "medium".to_string(),
    }
}

fn normalize_bubble_theme(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(theme)) if BUBBLE_THEMES.contains(&theme.as_str()) => theme.clone(),
        _ => "cream".to_string(),
    }
}

fn normalize_completion(value: Option<&Value>) -> String {
    match value.and_then(Value::as_str) {
        Some("never" | "background-only" | "always") => value.and_then(Value::as_str).unwrap().to_string(),
        _ => "background-only".to_string(),
    }
}

fn normalize_window_position(value: Option<&Value>) -> Option<WindowPosition> {
    let object = value.and_then(Value::as_object)?;
    let x = object.get("x").and_then(Value::as_f64)?;
    let y = object.get("y").and_then(Value::as_f64)?;
    if !x.is_finite() || !y.is_finite() {
        return None;
    }
    Some(WindowPosition {
        x: x.round() as i32,
        y: y.round() as i32,
    })
}

fn normalize_id_list(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for item in items {
        let Some(id) = item.as_str().map(str::trim).filter(|id| !id.is_empty() && id.len() <= 200) else {
            continue;
        };
        if !seen.insert(id.to_string()) {
            continue;
        }
        out.push(id.to_string());
        if out.len() >= MAX_TRANSITION_LRU {
            break;
        }
    }
    out
}
