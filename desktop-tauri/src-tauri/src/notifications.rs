use serde_json::{json, Value};

use crate::activity_view::{
    select_transition_effects, select_transition_effects_with_runtime, DesktopPetSettings,
    TransitionPolicyResult, TransitionRuntimeState,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopNotificationCandidate {
    pub transition_id: String,
    pub activity_id: String,
    pub title: String,
    pub project_name: String,
    pub presentation: String,
    pub deep_link: String,
    pub body: String,
}

pub fn notification_body_for(presentation: &str) -> &'static str {
    match presentation {
        "needs_input" => "任务需要输入",
        "blocked" => "任务受阻",
        "ready" => "任务已完成",
        _ => "",
    }
}

pub fn select_notification_candidates(
    settings: &DesktopPetSettings,
    snapshot: &Value,
    reset_baseline: bool,
    app_in_background: bool,
    now: i64,
) -> (Vec<DesktopNotificationCandidate>, TransitionPolicyResult) {
    let effects =
        select_transition_effects(settings, snapshot, reset_baseline, app_in_background, now);
    build_notification_candidates(snapshot, reset_baseline, effects)
}

pub fn select_notification_candidates_with_runtime(
    settings: &DesktopPetSettings,
    snapshot: &Value,
    reset_baseline: bool,
    app_in_background: bool,
    now: i64,
    runtime: &mut TransitionRuntimeState,
) -> (Vec<DesktopNotificationCandidate>, TransitionPolicyResult) {
    let effects = select_transition_effects_with_runtime(
        settings,
        snapshot,
        reset_baseline,
        app_in_background,
        now,
        runtime,
    );
    build_notification_candidates(snapshot, reset_baseline, effects)
}

fn build_notification_candidates(
    snapshot: &Value,
    reset_baseline: bool,
    effects: TransitionPolicyResult,
) -> (Vec<DesktopNotificationCandidate>, TransitionPolicyResult) {
    if reset_baseline {
        return (Vec::new(), effects);
    }
    let mut candidates = Vec::new();
    for (index, id) in effects.notify_transition_ids.iter().enumerate() {
        let presentation = effects
            .notify_presentations
            .get(index)
            .map(String::as_str)
            .unwrap_or("");
        if presentation.is_empty() {
            continue;
        }
        let activity = find_activity_by_transition(snapshot, id);
        let title = activity
            .and_then(|row| row.get("title").and_then(Value::as_str))
            .or_else(|| {
                find_transition(snapshot, id)
                    .and_then(|row| row.get("taskKey").and_then(Value::as_str))
            })
            .unwrap_or("任务")
            .to_string();
        let project_name = activity
            .and_then(|row| row.get("projectName").and_then(Value::as_str))
            .or_else(|| {
                find_transition(snapshot, id)
                    .and_then(|row| row.get("projectKey").and_then(Value::as_str))
            })
            .unwrap_or("")
            .to_string();
        let deep_link = activity
            .and_then(|row| row.get("deepLink").and_then(Value::as_str))
            .unwrap_or("")
            .to_string();
        let activity_id = activity
            .and_then(|row| row.get("activityId").and_then(Value::as_str))
            .or_else(|| {
                find_transition(snapshot, id)
                    .and_then(|row| row.get("activityId").and_then(Value::as_str))
            })
            .unwrap_or("")
            .to_string();
        candidates.push(DesktopNotificationCandidate {
            transition_id: id.clone(),
            activity_id,
            title,
            project_name,
            presentation: presentation.to_string(),
            deep_link,
            body: notification_body_for(presentation).to_string(),
        });
    }
    (candidates, effects)
}

pub fn show_candidates(origin: &str, candidates: &[DesktopNotificationCandidate]) {
    for candidate in candidates {
        let body = if candidate.project_name.is_empty() {
            candidate.body.clone()
        } else {
            format!("{} · {}", candidate.project_name, candidate.body)
        };
        let deep_link = candidate.deep_link.clone();
        let origin = origin.to_string();
        let _ = crate::native::show_notification(&candidate.title, &body, move || {
            if !deep_link.is_empty() {
                let _ = crate::deep_links::open_validated_deep_link(&origin, &deep_link);
            }
        });
    }
}

fn find_transition<'a>(snapshot: &'a Value, transition_id: &str) -> Option<&'a Value> {
    snapshot
        .get("recentTransitions")
        .and_then(Value::as_array)?
        .iter()
        .find(|item| item.get("transitionId").and_then(Value::as_str) == Some(transition_id))
}

fn find_activity_by_transition<'a>(snapshot: &'a Value, transition_id: &str) -> Option<&'a Value> {
    let projects = snapshot.get("projects")?.as_array()?;
    for project in projects {
        if let Some(activities) = project.get("activities").and_then(Value::as_array) {
            if let Some(activity) = activities.iter().find(|row| {
                row.get("lastTransitionId").and_then(Value::as_str) == Some(transition_id)
            }) {
                return Some(activity);
            }
        }
    }
    None
}

pub fn candidate_debug_json(candidate: &DesktopNotificationCandidate) -> Value {
    json!({
        "transitionId": candidate.transition_id,
        "activityId": candidate.activity_id,
        "presentation": candidate.presentation,
        "deepLink": candidate.deep_link,
        "body": candidate.body,
    })
}
