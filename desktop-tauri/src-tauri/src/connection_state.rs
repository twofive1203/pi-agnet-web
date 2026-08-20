use serde::{Deserialize, Serialize};

pub const DESKTOP_DEFAULT_PORT: u16 = 62666;
pub const DESKTOP_DEFAULT_HOST: &str = "127.0.0.1";
pub const DESKTOP_START_COMMAND: &str = "spi --no-open";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopConnectionStatus {
    Probing,
    Connected,
    Reconnecting,
    ServiceNotRunning,
    Incompatible,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopConnectionReasonCode {
    ConnectionRefused,
    NetworkError,
    HealthInvalid,
    HealthHttpError,
    ProtocolHttpError,
    ProtocolInvalid,
    ProtocolMismatch,
    ProductMismatch,
    ServerMode,
    AuthRequired,
    AuthInvalid,
    TokenRejected,
    InstanceChanged,
    StreamError,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConnectionState {
    pub status: DesktopConnectionStatus,
    pub origin: String,
    pub port: u16,
    pub start_command: String,
    pub instance_id: Option<String>,
    pub reason_code: Option<DesktopConnectionReasonCode>,
    pub detail: Option<String>,
    pub attempt: u32,
    pub reset_notification_baseline: bool,
    pub quick_session_available: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DesktopConnectionEvent {
    StartProbe,
    Retry,
    ConnectionRefused,
    NetworkError {
        #[serde(default)]
        detail: Option<String>,
    },
    Incompatible {
        #[serde(rename = "reasonCode")]
        reason_code: DesktopConnectionReasonCode,
        #[serde(default)]
        detail: Option<String>,
    },
    Connected {
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "resetBaseline")]
        #[serde(default)]
        reset_baseline: Option<bool>,
        #[serde(rename = "quickSessionAvailable")]
        #[serde(default)]
        quick_session_available: Option<bool>,
    },
    StreamLost {
        #[serde(default)]
        detail: Option<String>,
    },
    InstanceChanged {
        #[serde(rename = "instanceId")]
        instance_id: String,
    },
    TokenRejected,
    Quit,
}

pub fn sanitize_port(port: u16) -> u16 {
    if port == 0 {
        DESKTOP_DEFAULT_PORT
    } else {
        port
    }
}

pub fn build_desktop_origin(port: u16) -> String {
    format!("http://{DESKTOP_DEFAULT_HOST}:{}", sanitize_port(port))
}

pub fn is_loopback_observer_url(url: &str, port: u16) -> bool {
    let expected = build_desktop_origin(port);
    url == expected || url.starts_with(&format!("{expected}/"))
}

pub fn create_initial_connection_state(port: u16, now: i64) -> DesktopConnectionState {
    let port = sanitize_port(port);
    DesktopConnectionState {
        status: DesktopConnectionStatus::Probing,
        origin: build_desktop_origin(port),
        port,
        start_command: DESKTOP_START_COMMAND.to_string(),
        instance_id: None,
        reason_code: None,
        detail: None,
        attempt: 0,
        reset_notification_baseline: true,
        quick_session_available: false,
        updated_at: now,
    }
}

fn with_meta(
    state: &DesktopConnectionState,
    patch: DesktopConnectionState,
    now: i64,
) -> DesktopConnectionState {
    DesktopConnectionState {
        origin: build_desktop_origin(patch.port),
        start_command: DESKTOP_START_COMMAND.to_string(),
        updated_at: now,
        ..patch
    }
    .with_port(state, patch.port)
}

trait WithPort {
    fn with_port(self, previous: &DesktopConnectionState, port: u16) -> Self;
}

impl WithPort for DesktopConnectionState {
    fn with_port(mut self, previous: &DesktopConnectionState, port: u16) -> Self {
        self.port = if port == 0 { previous.port } else { port };
        self.origin = build_desktop_origin(self.port);
        self
    }
}

pub fn reduce_connection_state(
    state: &DesktopConnectionState,
    event: &DesktopConnectionEvent,
    now: i64,
) -> DesktopConnectionState {
    match event {
        DesktopConnectionEvent::StartProbe => with_meta(
            state,
            DesktopConnectionState {
                status: DesktopConnectionStatus::Probing,
                reason_code: None,
                detail: None,
                attempt: if state.status == DesktopConnectionStatus::Probing {
                    state.attempt
                } else {
                    state.attempt.saturating_add(1)
                },
                ..state.clone()
            },
            now,
        ),
        DesktopConnectionEvent::Retry => with_meta(
            state,
            DesktopConnectionState {
                status: DesktopConnectionStatus::Probing,
                reason_code: None,
                detail: None,
                attempt: state.attempt.saturating_add(1),
                reset_notification_baseline: matches!(
                    state.status,
                    DesktopConnectionStatus::ServiceNotRunning
                        | DesktopConnectionStatus::Incompatible
                        | DesktopConnectionStatus::Probing
                ) || state.reset_notification_baseline,
                ..state.clone()
            },
            now,
        ),
        DesktopConnectionEvent::ConnectionRefused => with_meta(
            state,
            DesktopConnectionState {
                status: DesktopConnectionStatus::ServiceNotRunning,
                reason_code: Some(DesktopConnectionReasonCode::ConnectionRefused),
                detail: None,
                instance_id: None,
                quick_session_available: false,
                ..state.clone()
            },
            now,
        ),
        DesktopConnectionEvent::NetworkError { detail } => {
            if matches!(
                state.status,
                DesktopConnectionStatus::Connected | DesktopConnectionStatus::Reconnecting
            ) {
                with_meta(
                    state,
                    DesktopConnectionState {
                        status: DesktopConnectionStatus::Reconnecting,
                        reason_code: Some(DesktopConnectionReasonCode::NetworkError),
                        detail: clamp_detail(detail.as_deref()),
                        attempt: state.attempt.saturating_add(1),
                        ..state.clone()
                    },
                    now,
                )
            } else {
                with_meta(
                    state,
                    DesktopConnectionState {
                        status: DesktopConnectionStatus::ServiceNotRunning,
                        reason_code: Some(DesktopConnectionReasonCode::NetworkError),
                        detail: clamp_detail(detail.as_deref()),
                        instance_id: None,
                        quick_session_available: false,
                        ..state.clone()
                    },
                    now,
                )
            }
        }
        DesktopConnectionEvent::Incompatible { reason_code, detail } => with_meta(
            state,
            DesktopConnectionState {
                status: DesktopConnectionStatus::Incompatible,
                reason_code: Some(*reason_code),
                detail: clamp_detail(detail.as_deref()),
                instance_id: None,
                quick_session_available: false,
                ..state.clone()
            },
            now,
        ),
        DesktopConnectionEvent::Connected {
            instance_id,
            reset_baseline,
            quick_session_available,
        } => {
            let instance_changed = state
                .instance_id
                .as_ref()
                .is_some_and(|current| current != instance_id);
            let reset = reset_baseline.unwrap_or(false)
                || state.reset_notification_baseline
                || instance_changed
                || state.status != DesktopConnectionStatus::Connected;
            with_meta(
                state,
                DesktopConnectionState {
                    status: DesktopConnectionStatus::Connected,
                    instance_id: Some(instance_id.clone()),
                    reason_code: None,
                    detail: None,
                    attempt: 0,
                    reset_notification_baseline: reset,
                    quick_session_available: quick_session_available.unwrap_or(false),
                    ..state.clone()
                },
                now,
            )
        }
        DesktopConnectionEvent::StreamLost { detail } => {
            if matches!(
                state.status,
                DesktopConnectionStatus::ServiceNotRunning | DesktopConnectionStatus::Incompatible
            ) {
                return state.clone();
            }
            with_meta(
                state,
                DesktopConnectionState {
                    status: DesktopConnectionStatus::Reconnecting,
                    reason_code: Some(DesktopConnectionReasonCode::StreamError),
                    detail: clamp_detail(detail.as_deref()),
                    attempt: state.attempt.saturating_add(1),
                    ..state.clone()
                },
                now,
            )
        }
        DesktopConnectionEvent::InstanceChanged { instance_id } => with_meta(
            state,
            DesktopConnectionState {
                status: DesktopConnectionStatus::Reconnecting,
                instance_id: Some(instance_id.clone()),
                reason_code: Some(DesktopConnectionReasonCode::InstanceChanged),
                detail: None,
                reset_notification_baseline: true,
                quick_session_available: false,
                attempt: state.attempt.saturating_add(1),
                ..state.clone()
            },
            now,
        ),
        DesktopConnectionEvent::TokenRejected => with_meta(
            state,
            DesktopConnectionState {
                status: DesktopConnectionStatus::Reconnecting,
                reason_code: Some(DesktopConnectionReasonCode::TokenRejected),
                detail: None,
                reset_notification_baseline: true,
                attempt: state.attempt.saturating_add(1),
                ..state.clone()
            },
            now,
        ),
        DesktopConnectionEvent::Quit => with_meta(
            state,
            DesktopConnectionState {
                status: DesktopConnectionStatus::ServiceNotRunning,
                reason_code: None,
                detail: Some("desktop_quit".to_string()),
                instance_id: None,
                attempt: 0,
                reset_notification_baseline: true,
                quick_session_available: false,
                ..state.clone()
            },
            now,
        ),
    }
}

pub fn acknowledge_connection_baseline(
    state: &DesktopConnectionState,
    now: i64,
) -> DesktopConnectionState {
    if !state.reset_notification_baseline {
        return state.clone();
    }
    with_meta(
        state,
        DesktopConnectionState {
            reset_notification_baseline: false,
            ..state.clone()
        },
        now,
    )
}

pub fn can_copy_start_command(state: &DesktopConnectionState) -> bool {
    matches!(
        state.status,
        DesktopConnectionStatus::ServiceNotRunning | DesktopConnectionStatus::Incompatible
    )
}

pub fn public_connection_state(state: &DesktopConnectionState) -> serde_json::Value {
    serde_json::json!({
        "status": state.status,
        "origin": state.origin,
        "port": state.port,
        "startCommand": state.start_command,
        "instanceId": state.instance_id,
        "reasonCode": state.reason_code,
        "detail": state.detail,
        "attempt": state.attempt,
        "resetNotificationBaseline": state.reset_notification_baseline,
        "quickSessionAvailable": state.quick_session_available,
    })
}

fn clamp_detail(detail: Option<&str>) -> Option<String> {
    let trimmed = detail?
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() > 160 {
        let clipped: String = trimmed.chars().take(159).collect();
        Some(format!("{clipped}…"))
    } else {
        Some(trimmed)
    }
}
