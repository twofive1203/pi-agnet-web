use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::connection_state::{
    build_desktop_origin, is_loopback_observer_url, reduce_connection_state,
    DesktopConnectionEvent, DesktopConnectionReasonCode, DesktopConnectionState,
};

pub const DESKTOP_OBSERVER_PRODUCT: &str = "snail-pi-web";
pub const TASK_OBSERVER_PROTOCOL_VERSION: u64 = 1;
pub const DESKTOP_OBSERVER_TOKEN_HEADER: &str = "x-spi-desktop-observer-token";
pub const DESKTOP_PROTOCOL_CAPABILITY_QUICK_SESSION: &str = "quick_session";

#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub connection_refused: bool,
    pub body: String,
}

#[derive(Debug, Clone)]
pub enum SseTransportResult {
    Ok { status: u16, chunks: Vec<String> },
    Err { status: u16, connection_refused: bool, detail: Option<String> },
}

pub trait DesktopTransport: Send + Sync {
    fn fetch(&self, request: HttpRequest) -> Result<HttpResponse, String>;
    fn sse(&self, request: HttpRequest) -> Result<SseTransportResult, String>;
}

#[derive(Debug, Clone)]
pub struct ScriptedStep {
    pub match_url: String,
    pub status: u16,
    pub connection_refused: bool,
    pub body: String,
    pub sse_chunks: Option<Vec<String>>,
}

#[derive(Debug, Default)]
pub struct ScriptedTransport {
    steps: Mutex<VecDeque<ScriptedStep>>,
}

impl ScriptedTransport {
    pub fn new(steps: Vec<ScriptedStep>) -> Self {
        Self {
            steps: Mutex::new(VecDeque::from(steps)),
        }
    }
}

impl DesktopTransport for ScriptedTransport {
    fn fetch(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let mut steps = self
            .steps
            .lock()
            .map_err(|_| "scripted transport lock poisoned".to_string())?;
        let index = steps
            .iter()
            .position(|step| request.url.contains(&step.match_url))
            .ok_or_else(|| format!("unexpected fetch: {}", request.url))?;
        let step = steps.remove(index).expect("index exists");
        Ok(HttpResponse {
            status: step.status,
            connection_refused: step.connection_refused,
            body: step.body,
        })
    }

    fn sse(&self, request: HttpRequest) -> Result<SseTransportResult, String> {
        let mut steps = self
            .steps
            .lock()
            .map_err(|_| "scripted transport lock poisoned".to_string())?;
        let index = steps
            .iter()
            .position(|step| request.url.contains(&step.match_url) && step.sse_chunks.is_some())
            .ok_or_else(|| format!("unexpected sse: {}", request.url))?;
        let step = steps.remove(index).expect("index exists");
        if step.connection_refused || step.status >= 400 {
            return Ok(SseTransportResult::Err {
                status: step.status,
                connection_refused: step.connection_refused,
                detail: Some(format!("sse_http_{}", step.status)),
            });
        }
        Ok(SseTransportResult::Ok {
            status: step.status,
            chunks: step.sse_chunks.unwrap_or_default(),
        })
    }
}

pub struct LoopbackTransport;

impl LoopbackTransport {
    pub fn new() -> Self {
        Self
    }
}

impl DesktopTransport for LoopbackTransport {
    fn fetch(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        let mut req = match request.method.as_str() {
            "POST" => ureq::post(&request.url),
            _ => ureq::get(&request.url),
        };
        req = req.timeout(Duration::from_secs(15));
        for (key, value) in &request.headers {
            req = req.set(key, value);
        }
        let result = if let Some(body) = &request.body {
            req.send_string(body)
        } else {
            req.call()
        };
        match result {
            Ok(response) => Ok(HttpResponse {
                status: response.status(),
                connection_refused: false,
                body: response.into_string().unwrap_or_default(),
            }),
            Err(ureq::Error::Status(status, response)) => Ok(HttpResponse {
                status,
                connection_refused: false,
                body: response.into_string().unwrap_or_default(),
            }),
            Err(error) => {
                let classified = classify_fetch_failure(&error.to_string());
                if matches!(classified, DesktopConnectionEvent::ConnectionRefused) {
                    Ok(HttpResponse {
                        status: 0,
                        connection_refused: true,
                        body: String::new(),
                    })
                } else {
                    Err(error.to_string())
                }
            }
        }
    }

    fn sse(&self, request: HttpRequest) -> Result<SseTransportResult, String> {
        let mut req = ureq::get(&request.url).timeout(Duration::from_secs(30));
        for (key, value) in &request.headers {
            req = req.set(key, value);
        }
        match req.call() {
            Ok(response) => {
                let status = response.status();
                let text = response.into_string().unwrap_or_default();
                Ok(SseTransportResult::Ok {
                    status,
                    chunks: if text.is_empty() { Vec::new() } else { vec![text] },
                })
            }
            Err(ureq::Error::Status(status, _)) => Ok(SseTransportResult::Err {
                status,
                connection_refused: false,
                detail: Some(format!("sse_http_{status}")),
            }),
            Err(error) => {
                let classified = classify_fetch_failure(&error.to_string());
                Ok(SseTransportResult::Err {
                    status: 0,
                    connection_refused: matches!(
                        classified,
                        DesktopConnectionEvent::ConnectionRefused
                    ),
                    detail: Some(match classified {
                        DesktopConnectionEvent::NetworkError { detail } => {
                            detail.unwrap_or_else(|| "sse_error".to_string())
                        }
                        _ => "connection_refused".to_string(),
                    }),
                })
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProbeSuccess {
    pub instance_id: String,
    pub token: String,
    pub expires_at: i64,
    pub quick_session_available: bool,
}

#[derive(Debug, Clone)]
pub enum ProbeResult {
    Ok(ProbeSuccess),
    Err(DesktopConnectionEvent),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProtocolOk {
    pub instance_id: String,
    pub auth_required: bool,
    pub quick_session_available: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProtocolResult {
    Ok(ProtocolOk),
    Event(DesktopConnectionEvent),
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionResult {
    Ok {
        token: String,
        expires_at: i64,
        instance_id: String,
    },
    Event(DesktopConnectionEvent),
}

#[derive(Debug, Clone, PartialEq)]
pub struct UnwrappedSse {
    pub kind: String,
    pub snapshot_json: Option<String>,
    pub reset: bool,
    pub code: Option<String>,
}

pub fn classify_fetch_failure(message: &str) -> DesktopConnectionEvent {
    let lower = message.to_ascii_lowercase();
    if lower.contains("econnrefused") || lower.contains("connection refused") {
        return DesktopConnectionEvent::ConnectionRefused;
    }
    if lower.contains("fetch failed")
        || lower.contains("networkerror")
        || lower.contains("connect etimedout")
        || lower.contains("enotfound")
        || lower.contains("error sending request")
        || lower.contains("connection reset")
    {
        if lower.contains("econnrefused") || lower.contains("connection refused") {
            return DesktopConnectionEvent::ConnectionRefused;
        }
        return DesktopConnectionEvent::NetworkError {
            detail: Some(message.to_string()),
        };
    }
    DesktopConnectionEvent::NetworkError {
        detail: Some(message.to_string()),
    }
}

pub fn interpret_health_payload(payload: &Value, http_status: u16) -> Option<DesktopConnectionEvent> {
    if http_status == 0 {
        return Some(DesktopConnectionEvent::ConnectionRefused);
    }
    if !(200..300).contains(&http_status) {
        return Some(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::HealthHttpError,
            detail: Some(format!("http_{http_status}")),
        });
    }
    let Some(record) = payload.as_object() else {
        return Some(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::HealthInvalid,
            detail: Some("non_object".to_string()),
        });
    };
    match record.get("instanceId").and_then(Value::as_str) {
        Some(instance) if !instance.trim().is_empty() => None,
        _ => Some(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::HealthInvalid,
            detail: Some("missing_instance".to_string()),
        }),
    }
}

pub fn protocol_has_quick_session_capability(capabilities: Option<&Value>) -> bool {
    capabilities
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.as_str() == Some(DESKTOP_PROTOCOL_CAPABILITY_QUICK_SESSION)
            })
        })
}

pub fn interpret_protocol_payload(payload: &Value, http_status: u16) -> ProtocolResult {
    if http_status == 0 {
        return ProtocolResult::Event(DesktopConnectionEvent::ConnectionRefused);
    }
    if http_status == 401 || http_status == 403 {
        return ProtocolResult::Event(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::AuthRequired,
            detail: Some(format!("http_{http_status}")),
        });
    }
    if !(200..300).contains(&http_status) {
        return ProtocolResult::Event(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::ProtocolHttpError,
            detail: Some(format!("http_{http_status}")),
        });
    }
    let Some(record) = payload.as_object() else {
        return ProtocolResult::Event(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::ProtocolInvalid,
            detail: Some("non_object".to_string()),
        });
    };
    let product = record.get("product").and_then(Value::as_str).unwrap_or("missing");
    if product != DESKTOP_OBSERVER_PRODUCT {
        return ProtocolResult::Event(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::ProductMismatch,
            detail: Some(product.to_string()),
        });
    }
    let protocol_version = record.get("protocolVersion").and_then(value_as_u64);
    if protocol_version != Some(TASK_OBSERVER_PROTOCOL_VERSION) {
        return ProtocolResult::Event(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::ProtocolMismatch,
            detail: Some(format!(
                "got_{}",
                record
                    .get("protocolVersion")
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "null".to_string())
            )),
        });
    }
    if record.get("compatible") == Some(&Value::Bool(false)) {
        let reason = if record.get("reasonCode").and_then(Value::as_str) == Some("server_mode")
            || record.get("mode").and_then(Value::as_str) == Some("server")
        {
            DesktopConnectionReasonCode::ServerMode
        } else {
            DesktopConnectionReasonCode::ProtocolInvalid
        };
        return ProtocolResult::Event(DesktopConnectionEvent::Incompatible {
            reason_code: reason,
            detail: record
                .get("reasonCode")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        });
    }
    let Some(instance_id) = record
        .get("instanceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return ProtocolResult::Event(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::ProtocolInvalid,
            detail: Some("missing_instance".to_string()),
        });
    };
    let auth_required = record.get("authRequired") == Some(&Value::Bool(true))
        || record.get("mode").and_then(Value::as_str) == Some("server")
        || record.get("reasonCode").and_then(Value::as_str) == Some("auth_required");
    ProtocolResult::Ok(ProtocolOk {
        instance_id: instance_id.to_string(),
        auth_required,
        quick_session_available: protocol_has_quick_session_capability(record.get("capabilities")),
    })
}

pub fn interpret_session_payload(payload: &Value, http_status: u16) -> SessionResult {
    if http_status == 0 {
        return SessionResult::Event(DesktopConnectionEvent::ConnectionRefused);
    }
    if http_status == 401 || http_status == 403 {
        let code = payload
            .as_object()
            .and_then(|record| record.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let event = if code == "auth_invalid" {
            DesktopConnectionEvent::Incompatible {
                reason_code: DesktopConnectionReasonCode::AuthInvalid,
                detail: Some(format!("session_http_{http_status}")),
            }
        } else if code == "auth_required" || code == "unauthorized" || code.is_empty() {
            DesktopConnectionEvent::Incompatible {
                reason_code: DesktopConnectionReasonCode::AuthRequired,
                detail: Some(format!("session_http_{http_status}")),
            }
        } else {
            DesktopConnectionEvent::Incompatible {
                reason_code: DesktopConnectionReasonCode::AuthInvalid,
                detail: Some(code.to_string()),
            }
        };
        return SessionResult::Event(event);
    }
    if !(200..300).contains(&http_status) {
        return SessionResult::Event(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::ProtocolHttpError,
            detail: Some(format!("session_http_{http_status}")),
        });
    }
    let Some(record) = payload.as_object() else {
        return SessionResult::Event(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::ProtocolInvalid,
            detail: Some("session_non_object".to_string()),
        });
    };
    let Some(token) = record
        .get("token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return SessionResult::Event(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::ProtocolInvalid,
            detail: Some("missing_token".to_string()),
        });
    };
    let Some(instance_id) = record
        .get("instanceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return SessionResult::Event(DesktopConnectionEvent::Incompatible {
            reason_code: DesktopConnectionReasonCode::ProtocolInvalid,
            detail: Some("session_missing_instance".to_string()),
        });
    };
    let expires_at = record
        .get("expiresAt")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    SessionResult::Ok {
        token: token.to_string(),
        expires_at: if expires_at > 0 {
            expires_at
        } else {
            15 * 60 * 1000
        },
        instance_id: instance_id.to_string(),
    }
}

pub fn parse_sse_block(block: &str) -> Option<(Option<String>, String)> {
    let mut event = None;
    let mut data_lines = Vec::new();
    for line in block.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            event = Some(rest.trim().to_string());
            continue;
        }
        if let Some(rest) = line.strip_prefix("data:") {
            data_lines.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
        }
    }
    if data_lines.is_empty() && event.is_none() {
        return None;
    }
    Some((event, data_lines.join("\n")))
}

pub fn unwrap_observer_sse_data(raw_data: &str) -> UnwrappedSse {
    let trimmed = raw_data.trim();
    if trimmed.is_empty() {
        return UnwrappedSse {
            kind: "ignore".to_string(),
            snapshot_json: None,
            reset: false,
            code: None,
        };
    }
    let parsed: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => {
            return UnwrappedSse {
                kind: "error".to_string(),
                snapshot_json: None,
                reset: false,
                code: Some("bad_json".to_string()),
            };
        }
    };
    let Some(record) = parsed.as_object() else {
        return UnwrappedSse {
            kind: "error".to_string(),
            snapshot_json: None,
            reset: false,
            code: Some("not_object".to_string()),
        };
    };
    if record.get("type").and_then(Value::as_str) == Some("error") {
        return UnwrappedSse {
            kind: "error".to_string(),
            snapshot_json: None,
            reset: false,
            code: Some(
                record
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("stream_error")
                    .to_string(),
            ),
        };
    }
    if record.get("snapshot").map(Value::is_object).unwrap_or(false) {
        let snapshot = record.get("snapshot").cloned().unwrap_or(Value::Null);
        let reset = record.get("type").and_then(Value::as_str) == Some("reset")
            || snapshot.get("reset") == Some(&Value::Bool(true));
        return UnwrappedSse {
            kind: "snapshot".to_string(),
            snapshot_json: Some(snapshot.to_string()),
            reset,
            code: None,
        };
    }
    if record
        .get("instanceId")
        .and_then(Value::as_str)
        .is_some()
        || record.get("revision").and_then(Value::as_i64).is_some()
    {
        return UnwrappedSse {
            kind: "snapshot".to_string(),
            snapshot_json: Some(trimmed.to_string()),
            reset: record.get("reset") == Some(&Value::Bool(true)),
            code: None,
        };
    }
    UnwrappedSse {
        kind: "ignore".to_string(),
        snapshot_json: None,
        reset: false,
        code: None,
    }
}

#[derive(Debug, Clone)]
pub struct SnapshotMeta {
    pub reset: bool,
    pub instance_id: Option<String>,
}

pub struct ObserverClient<T: DesktopTransport> {
    transport: Arc<T>,
    state: Mutex<DesktopConnectionState>,
    access_key: Mutex<Option<String>>,
    token: Mutex<Option<String>>,
    stopped: Mutex<bool>,
    on_state: Option<Arc<dyn Fn(DesktopConnectionState) + Send + Sync>>,
    on_snapshot: Option<Arc<dyn Fn(String, SnapshotMeta) + Send + Sync>>,
}

impl<T: DesktopTransport> ObserverClient<T> {
    pub fn new(
        port: u16,
        now: i64,
        transport: T,
        access_key: Option<String>,
        on_state: Option<Arc<dyn Fn(DesktopConnectionState) + Send + Sync>>,
        on_snapshot: Option<Arc<dyn Fn(String, SnapshotMeta) + Send + Sync>>,
    ) -> Self {
        Self {
            transport: Arc::new(transport),
            state: Mutex::new(crate::connection_state::create_initial_connection_state(
                port, now,
            )),
            access_key: Mutex::new(normalize_access_key(access_key.as_deref())),
            token: Mutex::new(None),
            stopped: Mutex::new(false),
            on_state,
            on_snapshot,
        }
    }

    pub fn get_state(&self) -> DesktopConnectionState {
        self.state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_else(|error| error.into_inner().clone())
    }

    pub fn token_for_tests(&self) -> Option<String> {
        self.token.lock().ok().and_then(|token| token.clone())
    }

    pub fn set_access_key(&self, access_key: Option<String>) {
        if let Ok(mut slot) = self.access_key.lock() {
            *slot = normalize_access_key(access_key.as_deref());
        }
    }

    pub fn quit(&self, now: i64) {
        if let Ok(mut stopped) = self.stopped.lock() {
            *stopped = true;
        }
        if let Ok(mut token) = self.token.lock() {
            *token = None;
        }
        self.dispatch(DesktopConnectionEvent::Quit, now);
    }

    pub fn retry(&self, now: i64) -> ProbeResult {
        if self.is_stopped() {
            return ProbeResult::Err(DesktopConnectionEvent::Quit);
        }
        self.dispatch(DesktopConnectionEvent::Retry, now);
        self.probe_and_attach(now)
    }

    pub fn start(&self, now: i64) -> ProbeResult {
        if let Ok(mut stopped) = self.stopped.lock() {
            *stopped = false;
        }
        self.dispatch(DesktopConnectionEvent::StartProbe, now);
        self.probe_and_attach(now)
    }

    pub fn consume_notification_baseline(&self, now: i64) {
        if let Ok(mut state) = self.state.lock() {
            *state = crate::connection_state::acknowledge_connection_baseline(&state, now);
            let next = state.clone();
            drop(state);
            if let Some(on_state) = &self.on_state {
                on_state(next);
            }
        }
    }

    pub fn probe_and_attach(&self, now: i64) -> ProbeResult {
        if self.is_stopped() {
            return ProbeResult::Err(DesktopConnectionEvent::NetworkError {
                detail: Some("stopped".to_string()),
            });
        }
        match self.probe() {
            ProbeResult::Ok(success) => {
                let previous = self.get_state();
                if let Ok(mut token) = self.token.lock() {
                    *token = Some(success.token.clone());
                }
                let reset_baseline = previous.instance_id.as_deref() != Some(success.instance_id.as_str())
                    || previous.reset_notification_baseline;
                self.dispatch(
                    DesktopConnectionEvent::Connected {
                        instance_id: success.instance_id.clone(),
                        reset_baseline: Some(reset_baseline),
                        quick_session_available: Some(success.quick_session_available),
                    },
                    now,
                );
                ProbeResult::Ok(success)
            }
            ProbeResult::Err(event) => {
                if let Ok(mut token) = self.token.lock() {
                    *token = None;
                }
                self.dispatch(event.clone(), now);
                ProbeResult::Err(event)
            }
        }
    }

    pub fn probe(&self) -> ProbeResult {
        let state = self.get_state();
        let origin = build_desktop_origin(state.port);
        let health = match self.safe_fetch(format!("{origin}/api/health"), "GET", None, None) {
            Ok(response) => response,
            Err(event) => return ProbeResult::Err(event),
        };
        let health_json = parse_json_body(&health.body);
        if let Some(event) = interpret_health_payload(&health_json, health.status) {
            return ProbeResult::Err(event);
        }

        let protocol = match self.safe_fetch(
            format!("{origin}/api/desktop-observer/protocol"),
            "GET",
            None,
            None,
        ) {
            Ok(response) => response,
            Err(event) => return ProbeResult::Err(event),
        };
        let protocol_json = parse_json_body(&protocol.body);
        let protocol_result = interpret_protocol_payload(&protocol_json, protocol.status);
        let ProtocolResult::Ok(protocol_ok) = protocol_result else {
            if let ProtocolResult::Event(event) = protocol_result {
                return ProbeResult::Err(event);
            }
            return ProbeResult::Err(DesktopConnectionEvent::Incompatible {
                reason_code: DesktopConnectionReasonCode::ProtocolInvalid,
                detail: Some("protocol".to_string()),
            });
        };

        let access_key = self
            .access_key
            .lock()
            .ok()
            .and_then(|value| value.clone());
        if protocol_ok.auth_required && access_key.is_none() {
            return ProbeResult::Err(DesktopConnectionEvent::Incompatible {
                reason_code: DesktopConnectionReasonCode::AuthRequired,
                detail: Some("missing_access_key".to_string()),
            });
        }

        let body = if let Some(key) = access_key {
            serde_json::json!({ "accessKey": key }).to_string()
        } else {
            "{}".to_string()
        };
        let session = match self.safe_fetch(
            format!("{origin}/api/desktop-observer/session"),
            "POST",
            Some(vec![("content-type".to_string(), "application/json".to_string())]),
            Some(body),
        ) {
            Ok(response) => response,
            Err(event) => return ProbeResult::Err(event),
        };
        let session_json = parse_json_body(&session.body);
        match interpret_session_payload(&session_json, session.status) {
            SessionResult::Ok {
                token,
                expires_at,
                instance_id,
            } => {
                if instance_id != protocol_ok.instance_id {
                    return ProbeResult::Err(DesktopConnectionEvent::Incompatible {
                        reason_code: DesktopConnectionReasonCode::ProtocolInvalid,
                        detail: Some("instance_mismatch".to_string()),
                    });
                }
                ProbeResult::Ok(ProbeSuccess {
                    instance_id,
                    token,
                    expires_at,
                    quick_session_available: protocol_ok.quick_session_available,
                })
            }
            SessionResult::Event(event) => ProbeResult::Err(event),
        }
    }

    pub fn consume_sse_text(&self, text: &str, now: i64) {
        let mut buffer = text.to_string();
        while let Some(split_at) = buffer.find("\n\n") {
            let block = buffer[..split_at].to_string();
            buffer = buffer[split_at + 2..].to_string();
            if let Some((event, data)) = parse_sse_block(&block) {
                self.handle_sse_message(event.as_deref(), &data, now);
            }
        }
    }

    pub fn handle_sse_message(&self, event_name: Option<&str>, data: &str, now: i64) {
        if self.is_stopped() || data.trim().is_empty() {
            return;
        }
        let unwrapped = unwrap_observer_sse_data(data);
        if unwrapped.kind == "ignore" {
            return;
        }
        if unwrapped.kind == "error" {
            if unwrapped.code.as_deref() == Some("token_expired") {
                self.handle_token_expiry(now);
                return;
            }
            self.dispatch(
                DesktopConnectionEvent::StreamLost {
                    detail: unwrapped.code,
                },
                now,
            );
            return;
        }
        let Some(snapshot_json) = unwrapped.snapshot_json else {
            return;
        };
        let parsed: Value = match serde_json::from_str(&snapshot_json) {
            Ok(value) => value,
            Err(_) => {
                self.dispatch(
                    DesktopConnectionEvent::StreamLost {
                        detail: Some("bad_snapshot_json".to_string()),
                    },
                    now,
                );
                return;
            }
        };
        let instance_id = parsed
            .get("instanceId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
        let current = self.get_state();
        if let (Some(current_id), Some(next_id)) = (current.instance_id.as_ref(), instance_id.as_ref()) {
            if current_id != next_id {
                self.dispatch(
                    DesktopConnectionEvent::InstanceChanged {
                        instance_id: next_id.clone(),
                    },
                    now,
                );
                if let Ok(mut token) = self.token.lock() {
                    *token = None;
                }
                return;
            }
        }
        let reset = unwrapped.reset
            || event_name == Some("reset")
            || parsed.get("reset") == Some(&Value::Bool(true));
        if current.status != crate::connection_state::DesktopConnectionStatus::Connected {
            self.dispatch(
                DesktopConnectionEvent::Connected {
                    instance_id: instance_id.clone().unwrap_or_else(|| "unknown".to_string()),
                    reset_baseline: Some(reset || current.reset_notification_baseline),
                    quick_session_available: Some(current.quick_session_available),
                },
                now,
            );
        }
        if let Some(on_snapshot) = &self.on_snapshot {
            on_snapshot(
                snapshot_json,
                SnapshotMeta {
                    reset: reset || self.get_state().reset_notification_baseline,
                    instance_id: self.get_state().instance_id,
                },
            );
        }
        if reset || self.get_state().reset_notification_baseline {
            self.consume_notification_baseline(now);
        }
    }

    pub fn handle_token_expiry(&self, now: i64) {
        if let Ok(mut token) = self.token.lock() {
            *token = None;
        }
        self.dispatch(DesktopConnectionEvent::TokenRejected, now);
    }

    pub fn attach_sse_if_token(&self, now: i64) -> Result<(), String> {
        let token = self.token_for_tests().ok_or_else(|| "missing token".to_string())?;
        let state = self.get_state();
        let url = format!("{}/api/desktop-observer/events", build_desktop_origin(state.port));
        if !is_loopback_observer_url(&url, state.port) {
            return Err("refusing non-loopback observer url".to_string());
        }
        let result = self.transport.sse(HttpRequest {
            method: "GET".to_string(),
            url,
            headers: vec![
                ("Accept".to_string(), "text/event-stream".to_string()),
                (DESKTOP_OBSERVER_TOKEN_HEADER.to_string(), token),
            ],
            body: None,
        })?;
        match result {
            SseTransportResult::Ok { chunks, .. } => {
                for chunk in chunks {
                    self.consume_sse_text(&chunk, now);
                }
                Ok(())
            }
            SseTransportResult::Err {
                status,
                connection_refused,
                detail,
            } => {
                if status == 401 || status == 403 {
                    self.handle_token_expiry(now);
                    return Ok(());
                }
                if connection_refused {
                    if let Ok(mut token) = self.token.lock() {
                        *token = None;
                    }
                    self.dispatch(DesktopConnectionEvent::ConnectionRefused, now);
                } else {
                    self.dispatch(
                        DesktopConnectionEvent::StreamLost { detail },
                        now,
                    );
                }
                Ok(())
            }
        }
    }

    fn safe_fetch(
        &self,
        url: String,
        method: &str,
        headers: Option<Vec<(String, String)>>,
        body: Option<String>,
    ) -> Result<HttpResponse, DesktopConnectionEvent> {
        let port = self.get_state().port;
        if !is_loopback_observer_url(&url, port) {
            return Err(DesktopConnectionEvent::Incompatible {
                reason_code: DesktopConnectionReasonCode::ProtocolInvalid,
                detail: Some("non_loopback_url".to_string()),
            });
        }
        match self.transport.fetch(HttpRequest {
            method: method.to_string(),
            url,
            headers: headers.unwrap_or_default(),
            body,
        }) {
            Ok(response) if response.connection_refused => {
                Err(DesktopConnectionEvent::ConnectionRefused)
            }
            Ok(response) => Ok(response),
            Err(error) => Err(classify_fetch_failure(&error)),
        }
    }

    fn dispatch(&self, event: DesktopConnectionEvent, now: i64) {
        let next = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            *state = reduce_connection_state(&state, &event, now);
            state.clone()
        };
        if let Some(on_state) = &self.on_state {
            on_state(next);
        }
    }

    fn is_stopped(&self) -> bool {
        self.stopped.lock().map(|value| *value).unwrap_or(true)
    }
}

fn parse_json_body(body: &str) -> Value {
    serde_json::from_str(body).unwrap_or(Value::Null)
}

fn value_as_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_i64().and_then(|n| u64::try_from(n).ok()))
}

fn normalize_access_key(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() || trimmed.len() > 512 {
        None
    } else {
        Some(trimmed.to_string())
    }
}
