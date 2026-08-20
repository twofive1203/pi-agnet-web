use serde_json::{json, Value};
use snail_pi_pet_tauri_preview_lib::activity_view::{
    assert_renderer_view_safe, build_activity_view, default_desktop_settings, overlay_settings,
    project_view_summary, select_transition_effects, select_transition_effects_with_runtime,
    BuildViewInput, TransitionRuntimeState,
};
use snail_pi_pet_tauri_preview_lib::connection_state::DesktopConnectionState;

fn read_fixture(name: &str) -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures/desktop-pet-host")
        .join(name);
    let raw = std::fs::read_to_string(&path).expect("read fixture");
    assert!(
        !raw.contains("\"token\":")
            && !raw.contains("\"accessKey\":")
            && !raw.contains("\"firstMessage\":"),
        "{} must not embed secrets",
        name
    );
    serde_json::from_str(&raw).expect("parse fixture")
}

fn connection_from(value: &Value) -> DesktopConnectionState {
    serde_json::from_value(value.clone()).expect("connection")
}

#[test]
fn activity_view_fixtures_match_electron_summary() {
    let fixtures = read_fixture("activity-view-cases.json");
    for case in fixtures["cases"].as_array().expect("cases") {
        let settings = overlay_settings(
            default_desktop_settings(),
            case.get("settings").unwrap_or(&json!({})),
        );
        let connection = connection_from(&case["connection"]);
        let snapshot = case.get("snapshot").filter(|value| !value.is_null());
        let view = build_activity_view(BuildViewInput {
            snapshot,
            connection: &connection,
            settings: &settings,
            now: case["now"].as_i64().unwrap_or(0),
            reduced_motion: false,
            selected_activity_id: None,
            stale: case.get("stale").and_then(Value::as_bool).unwrap_or(false),
            has_access_key: case
                .get("hasAccessKey")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            tray_anchor: Some("top-left"),
            reset: case.get("reset").and_then(Value::as_bool).unwrap_or(false),
        });
        assert_renderer_view_safe(&view).expect("safe view");
        assert_eq!(
            project_view_summary(&view),
            case["expected"],
            "view {}",
            case["id"]
        );
    }
}

#[test]
fn sound_cooldown_survives_consecutive_snapshots() {
    let fixtures = read_fixture("transition-cases.json");
    for sequence in fixtures["sequences"].as_array().expect("sequences") {
        let mut settings = overlay_settings(default_desktop_settings(), &sequence["settings"]);
        let mut runtime = TransitionRuntimeState::default();
        for step in sequence["steps"].as_array().expect("steps") {
            let effects = select_transition_effects_with_runtime(
                &settings,
                &step["snapshot"],
                false,
                step["appInBackground"].as_bool().unwrap_or(false),
                step["now"].as_i64().unwrap_or(0),
                &mut runtime,
            );
            assert_eq!(
                json!({
                    "notifyTransitionIds": effects.notify_transition_ids.clone(),
                    "soundCues": effects.sound_cues.clone(),
                }),
                step["expected"],
                "sequence {}",
                sequence["id"]
            );
            settings.notified_transition_ids = effects.notified_transition_ids;
            settings.sounded_transition_ids = effects.sounded_transition_ids;
        }
        assert_eq!(
            json!(settings.notified_transition_ids),
            sequence["expectedNotifiedTransitionIds"]
        );
        assert_eq!(
            json!(settings.sounded_transition_ids),
            sequence["expectedSoundedTransitionIds"]
        );
    }
}

#[test]
fn renderer_safety_cases_reject_secrets_and_absolute_urls() {
    let fixtures = read_fixture("activity-view-cases.json");
    for case in fixtures["safetyCases"].as_array().expect("safety") {
        let mut payload = case["payload"].clone();
        if let Some(key) = case.get("injectKey").and_then(Value::as_str) {
            payload
                .as_object_mut()
                .unwrap()
                .insert(key.to_string(), json!("leak"));
        }
        let result = assert_renderer_view_safe(&payload);
        if case["expectThrow"].as_bool().unwrap_or(false) {
            assert!(result.is_err(), "safety {}", case["id"]);
        } else {
            assert!(result.is_ok(), "safety {}: {:?}", case["id"], result);
        }
    }
}

#[test]
fn transition_fixtures_share_baseline_and_dedupe_semantics() {
    let fixtures = read_fixture("transition-cases.json");
    for case in fixtures["cases"].as_array().expect("cases") {
        let settings = overlay_settings(default_desktop_settings(), &case["settings"]);
        let actual = select_transition_effects(
            &settings,
            &case["snapshot"],
            case["resetBaseline"].as_bool().unwrap_or(false),
            case["appInBackground"].as_bool().unwrap_or(false),
            case["now"].as_i64().unwrap_or(0),
        );
        assert_eq!(
            json!({
                "notifyPresentations": actual.notify_presentations,
                "notifyTransitionIds": actual.notify_transition_ids,
                "soundCues": actual.sound_cues,
                "notifiedTransitionIds": actual.notified_transition_ids,
                "soundedTransitionIds": actual.sounded_transition_ids,
            }),
            case["expected"],
            "transition {}",
            case["id"]
        );
    }
}
