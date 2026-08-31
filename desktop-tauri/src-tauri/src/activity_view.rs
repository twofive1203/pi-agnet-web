use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::connection_state::{
    can_copy_start_command, DesktopConnectionState, DesktopConnectionStatus, DESKTOP_START_COMMAND,
};

const PRESENTATION_PRIORITY: &[&str] = &[
    "service_not_running",
    "disconnected",
    "needs_input",
    "blocked",
    "ready",
    "retrying",
    "running",
    "idle",
];

const MAX_TRANSITION_LRU: usize = 500;
const SOUND_COOLDOWN_MS: i64 = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetSettings {
    pub version: u32,
    pub port: u16,
    pub selected_pet_id: String,
    pub selected_pet_key: String,
    pub pet_scale: String,
    pub bubble_theme: String,
    pub always_on_top: bool,
    pub click_through: bool,
    pub launch_at_login: bool,
    pub activity_tray_open: bool,
    pub show_context_meter: bool,
    pub right_click_aggregated_menu: bool,
    pub dnd_enabled: bool,
    pub window_position: Option<WindowPosition>,
    pub notification: NotificationSettings,
    pub sound: SoundSettings,
    pub acknowledged_transition_ids: Vec<String>,
    pub notified_transition_ids: Vec<String>,
    pub sounded_transition_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub needs_input: bool,
    pub blocked: bool,
    pub completion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SoundSettings {
    pub master_enabled: bool,
    pub needs_input: bool,
    pub completion: bool,
}

pub fn default_desktop_settings() -> DesktopPetSettings {
    DesktopPetSettings {
        version: 1,
        port: 62666,
        selected_pet_id: "snail-default".to_string(),
        selected_pet_key: "snail:snail-default".to_string(),
        pet_scale: "medium".to_string(),
        bubble_theme: "cream".to_string(),
        always_on_top: true,
        click_through: false,
        launch_at_login: false,
        activity_tray_open: false,
        show_context_meter: true,
        right_click_aggregated_menu: false,
        dnd_enabled: false,
        window_position: None,
        notification: NotificationSettings {
            needs_input: true,
            blocked: true,
            completion: "background-only".to_string(),
        },
        sound: SoundSettings {
            master_enabled: false,
            needs_input: true,
            completion: true,
        },
        acknowledged_transition_ids: Vec::new(),
        notified_transition_ids: Vec::new(),
        sounded_transition_ids: Vec::new(),
    }
}

pub fn overlay_settings(base: DesktopPetSettings, patch: &Value) -> DesktopPetSettings {
    let mut merged = serde_json::to_value(&base).unwrap_or_else(|_| json!({}));
    if let (Some(target), Some(source)) = (merged.as_object_mut(), patch.as_object()) {
        for (key, value) in source {
            if key == "notification" || key == "sound" {
                if let (Some(existing), Some(incoming)) =
                    (target.get_mut(key).and_then(Value::as_object_mut), value.as_object())
                {
                    for (nested_key, nested_value) in incoming {
                        existing.insert(nested_key.clone(), nested_value.clone());
                    }
                    continue;
                }
            }
            target.insert(key.clone(), value.clone());
        }
    }
    serde_json::from_value(merged).unwrap_or(base)
}

pub fn push_transition_lru(ids: &[String], next_id: &str) -> Vec<String> {
    let id = next_id.trim();
    if id.is_empty() {
        return ids.to_vec();
    }
    let mut next = ids
        .iter()
        .filter(|existing| existing.as_str() != id)
        .cloned()
        .collect::<Vec<_>>();
    next.push(id.to_string());
    if next.len() > MAX_TRANSITION_LRU {
        next[next.len() - MAX_TRANSITION_LRU..].to_vec()
    } else {
        next
    }
}

fn presentation_rank(state: &str) -> usize {
    PRESENTATION_PRIORITY
        .iter()
        .position(|item| *item == state)
        .unwrap_or(PRESENTATION_PRIORITY.len())
}

fn is_transition_acknowledged(ids: &[String], transition_id: &str) -> bool {
    !transition_id.is_empty() && ids.iter().any(|id| id == transition_id)
}

pub fn derive_activity_presentation(activity: &Value, acknowledged: &[String]) -> String {
    let attention = activity
        .get("attention")
        .and_then(Value::as_str)
        .unwrap_or("none");
    if attention == "needs_input" {
        return "needs_input".to_string();
    }
    if attention == "blocked" {
        return "blocked".to_string();
    }
    let last_transition = activity
        .get("lastTransitionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let unread = !is_transition_acknowledged(acknowledged, last_transition);
    let execution = activity
        .get("executionState")
        .and_then(Value::as_str)
        .unwrap_or("running");
    let outcome = activity.get("outcome").and_then(Value::as_str);
    if execution == "settled" {
        if matches!(outcome, Some("failed" | "interrupted" | "ambiguous")) {
            return if unread { "blocked" } else { "idle" }.to_string();
        }
        if matches!(outcome, Some("succeeded" | "cancelled")) || attention == "review_ready" {
            return if unread { "ready" } else { "idle" }.to_string();
        }
        return "idle".to_string();
    }
    if execution == "retrying" {
        return "retrying".to_string();
    }
    if execution == "queued" || execution == "running" {
        return "running".to_string();
    }
    "idle".to_string()
}

pub fn map_connection_to_observer(status: DesktopConnectionStatus) -> &'static str {
    match status {
        DesktopConnectionStatus::Probing => "probing",
        DesktopConnectionStatus::Connected => "connected",
        DesktopConnectionStatus::Reconnecting => "reconnecting",
        DesktopConnectionStatus::ServiceNotRunning => "service_not_running",
        DesktopConnectionStatus::Incompatible => "incompatible",
    }
}

pub fn derive_desktop_presentation(
    connection: DesktopConnectionStatus,
    activities: &[Value],
    acknowledged: &[String],
) -> String {
    match connection {
        DesktopConnectionStatus::ServiceNotRunning => return "service_not_running".to_string(),
        DesktopConnectionStatus::Reconnecting
        | DesktopConnectionStatus::Probing
        | DesktopConnectionStatus::Incompatible => return "disconnected".to_string(),
        DesktopConnectionStatus::Connected => {}
    }
    let mut best = "idle".to_string();
    for activity in activities {
        let presentation = derive_activity_presentation(activity, acknowledged);
        if presentation_rank(&presentation) < presentation_rank(&best) {
            best = presentation;
        }
    }
    best
}

fn parse_millis(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_str).and_then(parse_rfc3339_ms)
}

fn parse_rfc3339_ms(raw: &str) -> Option<i64> {
    let trimmed = raw.trim().trim_end_matches('Z');
    let (date, time) = trimmed.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;
    let (clock, fraction) = time.split_once('.').unwrap_or((time, "0"));
    let mut clock_parts = clock.split(':');
    let hour: i64 = clock_parts.next()?.parse().ok()?;
    let minute: i64 = clock_parts.next()?.parse().ok()?;
    let second: i64 = clock_parts.next()?.parse().ok()?;
    let millis: i64 = fraction.chars().take(3).collect::<String>().parse().unwrap_or(0);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    Some((((days * 24 + hour) * 60 + minute) * 60 + second) * 1000 + millis)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let mut y = year;
    let mut m = month;
    if m <= 2 {
        y -= 1;
        m += 9;
    } else {
        m -= 3;
    }
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

fn compute_elapsed_ms(activity: &Value, now: i64) -> Option<i64> {
    let start = parse_millis(activity.get("startedAt"))?;
    let end = parse_millis(activity.get("endedAt")).unwrap_or(now);
    Some((end - start).max(0))
}

fn project_activity_row(activity: &Value, acknowledged: &[String], now: i64) -> Value {
    let presentation = derive_activity_presentation(activity, acknowledged);
    let unread = matches!(presentation.as_str(), "needs_input" | "blocked" | "ready");
    let mut row = activity.clone();
    if let Some(object) = row.as_object_mut() {
        object.insert("presentation".to_string(), json!(presentation));
        object.insert("unread".to_string(), json!(unread));
        object.insert("elapsedMs".to_string(), json!(compute_elapsed_ms(activity, now)));
        if let Some(children) = object.get("children").and_then(Value::as_array).cloned() {
            let projected = children
                .into_iter()
                .map(|child| {
                    json!({
                        "childId": child.get("childId"),
                        "title": child.get("title"),
                        "executionState": child.get("executionState"),
                        "outcome": child.get("outcome"),
                        "attention": child.get("attention"),
                        "phase": child.get("phase"),
                        "updatedAt": child.get("updatedAt"),
                    })
                })
                .collect::<Vec<_>>();
            object.insert("children".to_string(), json!(projected));
        }
        object.remove("stateVersion");
    }
    row
}

fn compare_activity_rows(left: &Value, right: &Value) -> std::cmp::Ordering {
    let left_rank = presentation_rank(left.get("presentation").and_then(Value::as_str).unwrap_or("idle"));
    let right_rank = presentation_rank(right.get("presentation").and_then(Value::as_str).unwrap_or("idle"));
    left_rank.cmp(&right_rank).then_with(|| {
        let left_time = parse_millis(left.get("updatedAt")).or_else(|| parse_millis(left.get("startedAt"))).unwrap_or(0);
        let right_time = parse_millis(right.get("updatedAt")).or_else(|| parse_millis(right.get("startedAt"))).unwrap_or(0);
        right_time.cmp(&left_time)
    })
}

pub fn build_activity_view(input: BuildViewInput<'_>) -> Value {
    let acknowledged = &input.settings.acknowledged_transition_ids;
    let stale = input.stale
        || input.connection.status == DesktopConnectionStatus::Reconnecting
        || (input.connection.status != DesktopConnectionStatus::Connected && input.snapshot.is_some());

    let mut projects = Vec::new();
    let mut all_activities = Vec::new();
    let mut diagnostics = Vec::new();
    let mut aggregate = input
        .snapshot
        .and_then(|snapshot| snapshot.get("aggregate").cloned());

    if let Some(snapshot) = input.snapshot {
        if let Some(raw_projects) = snapshot.get("projects").and_then(Value::as_array) {
            for project in raw_projects {
                let mut activities = project
                    .get("activities")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|activity| {
                        all_activities.push(activity.clone());
                        project_activity_row(&activity, acknowledged, input.now)
                    })
                    .collect::<Vec<_>>();
                activities.sort_by(compare_activity_rows);
                let unread = activities
                    .iter()
                    .filter(|row| row.get("unread") == Some(&Value::Bool(true)))
                    .count();
                let counts = project.get("counts").cloned().unwrap_or_else(|| {
                    json!({ "active": 0, "needsInput": 0, "blocked": 0, "ready": 0 })
                });
                let mut counts_object = counts;
                if let Some(object) = counts_object.as_object_mut() {
                    object.insert("unread".to_string(), json!(unread));
                }
                projects.push(json!({
                    "projectKey": project.get("projectKey"),
                    "displayName": project.get("displayName"),
                    "counts": counts_object,
                    "activities": activities,
                }));
            }
        }
        if let Some(items) = snapshot.get("diagnostics").and_then(Value::as_array) {
            diagnostics = items.clone();
        }
        if aggregate.is_none() {
            aggregate = Some(json!({
                "activeProjects": 0,
                "activeActivities": 0,
                "needsInput": 0,
                "blocked": 0,
                "ready": 0,
                "running": 0
            }));
        }
    }

    projects.sort_by(|left, right| {
        let left_best = left
            .get("activities")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("presentation"))
            .and_then(Value::as_str)
            .unwrap_or("idle");
        let right_best = right
            .get("activities")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("presentation"))
            .and_then(Value::as_str)
            .unwrap_or("idle");
        presentation_rank(left_best)
            .cmp(&presentation_rank(right_best))
            .then_with(|| {
                let left_name = left.get("displayName").and_then(Value::as_str).unwrap_or("");
                let right_name = right.get("displayName").and_then(Value::as_str).unwrap_or("");
                left_name.cmp(right_name)
            })
    });

    let presentation = derive_desktop_presentation(input.connection.status, &all_activities, acknowledged);
    let mut attention_count = 0;
    let mut active_count = 0;
    let mut selected_exists = false;
    for project in &projects {
        if let Some(activities) = project.get("activities").and_then(Value::as_array) {
            for row in activities {
                let row_presentation = row.get("presentation").and_then(Value::as_str).unwrap_or("");
                if row_presentation == "needs_input" || row_presentation == "blocked" {
                    attention_count += 1;
                }
                if matches!(row_presentation, "running" | "retrying" | "needs_input") {
                    active_count += 1;
                }
                if input.selected_activity_id.as_deref()
                    == row.get("activityId").and_then(Value::as_str)
                {
                    selected_exists = true;
                }
            }
        }
    }

    let reason_snake = input.connection.reason_code.map(reason_code_wire);
    let needs_access_key = matches!(
        reason_snake.as_deref(),
        Some("auth_required" | "auth_invalid")
    );
    let reset = input.reset
        || input
            .snapshot
            .and_then(|snapshot| snapshot.get("reset"))
            == Some(&Value::Bool(true));

    let mut view = json!({
        "presentation": presentation,
        "connectionStatus": input.connection.status,
        "connectionReasonCode": reason_snake,
        "origin": input.connection.origin,
        "port": input.connection.port,
        "startCommand": if crate::server_profiles::is_loopback_origin(&input.connection.origin) {
            DESKTOP_START_COMMAND
        } else {
            ""
        },
        "canCopyStartCommand": can_copy_start_command(input.connection),
        "hasAccessKey": input.has_access_key,
        "needsAccessKey": needs_access_key,
        "stale": stale,
        "trayOpen": input.settings.activity_tray_open,
        "trayAnchor": input.tray_anchor.unwrap_or("top-left"),
        "selectedActivityId": if selected_exists { input.selected_activity_id.clone() } else { None },
        "selectedPetId": input.settings.selected_pet_id,
        "selectedPetKey": input.settings.selected_pet_key,
        "petScale": input.settings.pet_scale,
        "bubbleTheme": input.settings.bubble_theme,
        "alwaysOnTop": input.settings.always_on_top,
        "clickThrough": input.settings.click_through,
        "launchAtLogin": input.settings.launch_at_login,
        "showContextMeter": input.settings.show_context_meter,
        "rightClickAggregatedMenu": input.settings.right_click_aggregated_menu,
        "dndEnabled": input.settings.dnd_enabled,
        "notification": input.settings.notification,
        "sound": input.settings.sound,
        "reducedMotion": input.reduced_motion,
        "reset": reset,
        "revision": input.snapshot.and_then(|snapshot| snapshot.get("revision").cloned()).unwrap_or(Value::Null),
        "instanceId": input.snapshot.and_then(|snapshot| snapshot.get("instanceId").cloned())
            .or_else(|| input.connection.instance_id.clone().map(Value::String)),
        "generatedAt": input.snapshot.and_then(|snapshot| snapshot.get("generatedAt").cloned()).unwrap_or(Value::Null),
        "aggregate": aggregate.unwrap_or(Value::Null),
        "projects": projects,
        "diagnostics": diagnostics,
        "attentionCount": attention_count,
        "activeCount": active_count,
        "customPetsRoot": Value::Null,
        "quickSessionAvailable": input.connection.status == DesktopConnectionStatus::Connected
            && input.connection.quick_session_available,
    });
    view["activeServer"] = json!({
        "id": input.active_server_id,
        "name": input.active_server_name,
        "origin": input.connection.origin,
        "insecure": input.connection.origin.starts_with("http://")
            && !crate::server_profiles::is_loopback_origin(&input.connection.origin),
        "generation": input.active_server_generation,
    });
    view
}

pub struct BuildViewInput<'a> {
    pub snapshot: Option<&'a Value>,
    pub connection: &'a DesktopConnectionState,
    pub settings: &'a DesktopPetSettings,
    pub now: i64,
    pub reduced_motion: bool,
    pub selected_activity_id: Option<String>,
    pub stale: bool,
    pub has_access_key: bool,
    pub tray_anchor: Option<&'a str>,
    pub reset: bool,
    pub active_server_id: Option<&'a str>,
    pub active_server_name: Option<&'a str>,
    pub active_server_generation: u64,
}

fn reason_code_wire(code: crate::connection_state::DesktopConnectionReasonCode) -> String {
    serde_json::to_value(code)
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

pub fn project_view_summary(view: &Value) -> Value {
    let activity_rows = view
        .get("projects")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .flat_map(|project| {
            let project_key = project
                .get("projectKey")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            project
                .get("activities")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(move |row| {
                    json!({
                        "activityId": row.get("activityId"),
                        "presentation": row.get("presentation"),
                        "unread": row.get("unread"),
                        "projectKey": project_key,
                    })
                })
        })
        .collect::<Vec<_>>();
    json!({
        "presentation": view.get("presentation"),
        "connectionStatus": view.get("connectionStatus"),
        "connectionReasonCode": view.get("connectionReasonCode"),
        "origin": view.get("origin"),
        "port": view.get("port"),
        "startCommand": view.get("startCommand"),
        "canCopyStartCommand": view.get("canCopyStartCommand"),
        "hasAccessKey": view.get("hasAccessKey"),
        "needsAccessKey": view.get("needsAccessKey"),
        "stale": view.get("stale"),
        "trayOpen": view.get("trayOpen"),
        "selectedActivityId": view.get("selectedActivityId"),
        "selectedPetKey": view.get("selectedPetKey"),
        "reset": view.get("reset"),
        "instanceId": view.get("instanceId"),
        "projectKeys": view.get("projects").and_then(Value::as_array).map(|projects| {
            projects.iter().map(|project| project.get("projectKey").cloned().unwrap_or(Value::Null)).collect::<Vec<_>>()
        }),
        "activityRows": activity_rows,
        "attentionCount": view.get("attentionCount"),
        "activeCount": view.get("activeCount"),
        "quickSessionAvailable": view.get("quickSessionAvailable"),
        "diagnosticCodes": view.get("diagnostics").and_then(Value::as_array).map(|items| {
            items.iter().filter_map(|item| item.get("code").cloned()).collect::<Vec<_>>()
        }),
    })
}

pub fn assert_renderer_view_safe(view: &Value) -> Result<(), String> {
    let json = serde_json::to_string(view).map_err(|error| error.to_string())?;
    for key in [
        "token",
        "observerToken",
        "accessKey",
        "password",
        "pid",
        "servicePid",
        "cwd",
        "firstMessage",
        "prompt",
        "command",
        "output",
        "child_process",
    ] {
        let pattern = format!("\"{key}\":");
        if json.contains(&pattern) {
            return Err(format!("renderer view leaked key: {key}"));
        }
    }
    let allowed_origin = view
        .get("origin")
        .and_then(Value::as_str)
        .or_else(|| {
            view.get("activeServer")
                .and_then(|server| server.get("origin"))
                .and_then(Value::as_str)
        });
    for url in extract_urls(view) {
        if is_allowed_view_url(&url, allowed_origin) {
            continue;
        }
        return Err(format!(
            "renderer view must not contain disallowed absolute URL: {url}"
        ));
    }
    Ok(())
}

fn is_inert_renderer_text_key(key: &str) -> bool {
    matches!(key, "title" | "displayName" | "projectName" | "name")
}

fn collect_urls(value: &Value, field_name: Option<&str>, urls: &mut Vec<String>) {
    // These fields are rendered only as text. A first-message title may quote
    // a registry/docs URL without creating a navigation surface.
    if value.is_string() && field_name.is_some_and(is_inert_renderer_text_key) {
        return;
    }
    match value {
        Value::String(text) => urls.extend(extract_urls_from_text(text).map(ToString::to_string)),
        Value::Array(items) => {
            for item in items {
                collect_urls(item, None, urls);
            }
        }
        Value::Object(object) => {
            for (key, item) in object {
                collect_urls(item, Some(key), urls);
            }
        }
        _ => {}
    }
}

fn extract_urls(value: &Value) -> Vec<String> {
    let mut urls = Vec::new();
    collect_urls(value, None, &mut urls);
    urls
}

fn extract_urls_from_text(mut rest: &str) -> impl Iterator<Item = &str> {
    std::iter::from_fn(move || {
        let index = [rest.find("http://"), rest.find("https://")]
            .into_iter()
            .flatten()
            .min()?;
        let candidate = &rest[index..];
        let end = candidate
            .find(|ch: char| ch == '"' || ch.is_whitespace())
            .unwrap_or(candidate.len());
        let url = &candidate[..end];
        rest = &candidate[end..];
        Some(url)
    })
}

fn is_allowed_view_url(url: &str, allowed_origin: Option<&str>) -> bool {
    let cleaned = url.trim_end_matches(|ch: char| ch == '"' || ch == ',' || ch == '}');
    if cleaned.contains('@') {
        return false;
    }
    if cleaned.starts_with("http://127.0.0.1") || cleaned.starts_with("https://127.0.0.1") {
        return allowed_origin.map(|origin| {
            origin.starts_with("http://127.0.0.1") || origin.starts_with("https://127.0.0.1")
        }).unwrap_or(true);
    }
    let Some(origin) = allowed_origin else {
        return false;
    };
    crate::server_profiles::is_origin_scoped_url(cleaned, origin)
}

fn should_suppress_dnd(dnd_enabled: bool, presentation: &str) -> bool {
    dnd_enabled
        && matches!(
            presentation,
            "needs_input" | "blocked" | "ready" | "running" | "retrying"
        )
}

fn is_notifiable(presentation: &str) -> bool {
    matches!(presentation, "needs_input" | "blocked" | "ready")
}

fn sound_cue_for(presentation: &str) -> Option<&'static str> {
    match presentation {
        "needs_input" => Some("attention"),
        "ready" => Some("completion"),
        _ => None,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TransitionRuntimeState {
    pub last_sound_played_at: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionPolicyResult {
    pub notify_presentations: Vec<String>,
    pub notify_transition_ids: Vec<String>,
    pub sound_cues: Vec<String>,
    pub notified_transition_ids: Vec<String>,
    pub sounded_transition_ids: Vec<String>,
}

pub fn select_transition_effects(
    settings: &DesktopPetSettings,
    snapshot: &Value,
    reset_baseline: bool,
    app_in_background: bool,
    now: i64,
) -> TransitionPolicyResult {
    select_transition_effects_with_runtime(
        settings,
        snapshot,
        reset_baseline,
        app_in_background,
        now,
        &mut TransitionRuntimeState::default(),
    )
}

pub fn select_transition_effects_with_runtime(
    settings: &DesktopPetSettings,
    snapshot: &Value,
    reset_baseline: bool,
    app_in_background: bool,
    now: i64,
    runtime: &mut TransitionRuntimeState,
) -> TransitionPolicyResult {
    let transitions = snapshot
        .get("recentTransitions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut notified = settings.notified_transition_ids.clone();
    let mut sounded = settings.sounded_transition_ids.clone();
    let mut notify_presentations = Vec::new();
    let mut notify_transition_ids = Vec::new();
    let mut sound_cues = Vec::new();

    let consume = |ids: &mut Vec<String>, id: &str| {
        if id.is_empty() || ids.iter().any(|existing| existing == id) {
            return;
        }
        *ids = push_transition_lru(ids, id);
    };

    if reset_baseline {
        for transition in &transitions {
            if let Some(id) = transition.get("transitionId").and_then(Value::as_str) {
                consume(&mut notified, id.trim());
                consume(&mut sounded, id.trim());
            }
        }
        if let Some(projects) = snapshot.get("projects").and_then(Value::as_array) {
            for project in projects {
                if let Some(activities) = project.get("activities").and_then(Value::as_array) {
                    for activity in activities {
                        if let Some(id) = activity.get("lastTransitionId").and_then(Value::as_str) {
                            consume(&mut notified, id.trim());
                            consume(&mut sounded, id.trim());
                        }
                    }
                }
            }
        }
        return TransitionPolicyResult {
            notify_presentations,
            notify_transition_ids,
            sound_cues,
            notified_transition_ids: notified,
            sounded_transition_ids: sounded,
        };
    }

    for transition in &transitions {
        let id = transition
            .get("transitionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let presentation = transition
            .get("presentation")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !id.is_empty() && is_notifiable(presentation) && !notified.iter().any(|item| item == &id)
        {
            if should_suppress_dnd(settings.dnd_enabled, presentation)
                || !presentation_allowed(presentation, settings, app_in_background)
            {
                consume(&mut notified, &id);
            } else {
                notify_presentations.push(presentation.to_string());
                notify_transition_ids.push(id.clone());
                consume(&mut notified, &id);
            }
        }

        if let Some(kind) = sound_cue_for(presentation) {
            if id.is_empty() || sounded.iter().any(|item| item == &id) {
                continue;
            }
            let settings_suppressed = !settings.sound.master_enabled
                || if kind == "attention" {
                    !settings.sound.needs_input
                } else {
                    !settings.sound.completion
                };
            let cooldown_suppressed = runtime
                .last_sound_played_at
                .get(kind)
                .is_some_and(|played| *played + SOUND_COOLDOWN_MS > now);
            if should_suppress_dnd(settings.dnd_enabled, presentation)
                || settings_suppressed
                || cooldown_suppressed
            {
                consume(&mut sounded, &id);
                continue;
            }
            runtime.last_sound_played_at.insert(kind.to_string(), now);
            consume(&mut sounded, &id);
            sound_cues.push(kind.to_string());
        }
    }

    TransitionPolicyResult {
        notify_presentations,
        notify_transition_ids,
        sound_cues,
        notified_transition_ids: notified,
        sounded_transition_ids: sounded,
    }
}

fn presentation_allowed(
    presentation: &str,
    settings: &DesktopPetSettings,
    app_in_background: bool,
) -> bool {
    match presentation {
        "needs_input" => settings.notification.needs_input,
        "blocked" => settings.notification.blocked,
        "ready" => match settings.notification.completion.as_str() {
            "never" => false,
            "always" => true,
            _ => app_in_background,
        },
        _ => false,
    }
}

pub fn mark_activity_read(settings: &DesktopPetSettings, last_transition_id: &str) -> DesktopPetSettings {
    let mut next = settings.clone();
    next.acknowledged_transition_ids =
        push_transition_lru(&settings.acknowledged_transition_ids, last_transition_id);
    next
}

pub fn mark_all_terminal_read(settings: &DesktopPetSettings, view: &Value) -> DesktopPetSettings {
    let mut next = settings.acknowledged_transition_ids.clone();
    if let Some(projects) = view.get("projects").and_then(Value::as_array) {
        for project in projects {
            if let Some(activities) = project.get("activities").and_then(Value::as_array) {
                for row in activities {
                    let presentation = row.get("presentation").and_then(Value::as_str).unwrap_or("");
                    let attention = row.get("attention").and_then(Value::as_str).unwrap_or("");
                    if (presentation == "ready" || presentation == "blocked")
                        && attention != "needs_input"
                    {
                        if let Some(id) = row.get("lastTransitionId").and_then(Value::as_str) {
                            next = push_transition_lru(&next, id);
                        }
                    }
                }
            }
        }
    }
    let mut settings = settings.clone();
    settings.acknowledged_transition_ids = next;
    settings
}

pub fn find_last_transition_id(view: &Value, activity_id: &str) -> Option<String> {
    let projects = view.get("projects")?.as_array()?;
    for project in projects {
        let activities = project.get("activities")?.as_array()?;
        for row in activities {
            if row.get("activityId").and_then(Value::as_str) == Some(activity_id) {
                return row
                    .get("lastTransitionId")
                    .and_then(Value::as_str)
                    .map(ToString::to_string);
            }
        }
    }
    None
}
