use std::sync::Mutex;

use serde_json::{json, Value};

use crate::connection_state::{build_desktop_origin, DesktopConnectionState};
use crate::observer_client::{classify_fetch_failure, DesktopTransport, HttpRequest, LoopbackTransport};

pub const DESKTOP_CONTROL_TOKEN_HEADER: &str = "x-spi-desktop-control-token";
pub const DESKTOP_CONTROL_API_PREFIX: &str = "/api/desktop-control";
pub const DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS: usize = 8000;
const FORBIDDEN_PAYLOAD_KEYS: [&str; 7] = [
    "token",
    "accessKey",
    "cwd",
    "path",
    "firstMessage",
    "prompt",
    "latestSession",
];

#[derive(Debug, Clone)]
struct TokenState {
    token: Option<String>,
    expires_at: i64,
}

pub struct QuickSessionClient<T: DesktopTransport> {
    transport: T,
    port: Mutex<u16>,
    access_key: Mutex<Option<String>>,
    token: Mutex<TokenState>,
    connected: Mutex<bool>,
    available: Mutex<bool>,
    instance_id: Mutex<Option<String>>,
    stopped: Mutex<bool>,
}

impl QuickSessionClient<LoopbackTransport> {
    pub fn loopback(port: u16, access_key: Option<String>) -> Self {
        Self::new(port, access_key, LoopbackTransport::new())
    }
}

impl<T: DesktopTransport> QuickSessionClient<T> {
    pub fn new(port: u16, access_key: Option<String>, transport: T) -> Self {
        Self {
            transport,
            port: Mutex::new(port),
            access_key: Mutex::new(normalize_access_key(access_key.as_deref())),
            token: Mutex::new(TokenState {
                token: None,
                expires_at: 0,
            }),
            connected: Mutex::new(false),
            available: Mutex::new(false),
            instance_id: Mutex::new(None),
            stopped: Mutex::new(false),
        }
    }

    pub fn set_connection(&self, state: &DesktopConnectionState) {
        let connected = matches!(
            state.status,
            crate::connection_state::DesktopConnectionStatus::Connected
        );
        let available = connected && state.quick_session_available;
        if let Ok(mut port) = self.port.lock() {
            *port = state.port;
        }
        let next_instance = state.instance_id.clone();
        if let Ok(mut current) = self.instance_id.lock() {
            if current.as_ref() != next_instance.as_ref() {
                self.discard_token();
            }
            *current = next_instance;
        }
        if let Ok(mut slot) = self.connected.lock() {
            *slot = connected;
        }
        if let Ok(mut slot) = self.available.lock() {
            *slot = available;
        }
        if !connected || !available {
            self.discard_token();
        }
    }

    pub fn set_access_key(&self, access_key: Option<String>) {
        if let Ok(mut slot) = self.access_key.lock() {
            *slot = normalize_access_key(access_key.as_deref());
        }
        self.discard_token();
    }

    pub fn quit(&self) {
        if let Ok(mut stopped) = self.stopped.lock() {
            *stopped = true;
        }
        self.discard_token();
    }

    pub fn token_for_tests(&self) -> Option<String> {
        self.token.lock().ok().and_then(|state| state.token.clone())
    }

    pub fn list_projects(&self, now: i64) -> Value {
        if let Err(code) = self.preflight() {
            return fail(code);
        }
        match self.authed_json("GET", &format!("{DESKTOP_CONTROL_API_PREFIX}/projects"), None, now, true) {
            Ok(payload) => match parse_catalog(&payload) {
                Some(catalog) => json!({ "ok": true, "catalog": catalog }),
                None => fail("result_unknown"),
            },
            Err(code) => fail(code),
        }
    }

    pub fn list_models(&self, project_ref: &str, now: i64) -> Value {
        if let Err(code) = self.preflight() {
            return fail(code);
        }
        if !is_project_ref(project_ref) {
            return fail("bad_request");
        }
        let pathname = format!(
            "{DESKTOP_CONTROL_API_PREFIX}/models?projectRef={}",
            encode_query(project_ref)
        );
        match self.authed_json("GET", &pathname, None, now, true) {
            Ok(payload) => match parse_model_catalog(&payload) {
                Some(catalog) => json!({ "ok": true, "catalog": catalog }),
                None => fail("result_unknown"),
            },
            Err(code) => fail(code),
        }
    }

    pub fn create_session(&self, input: &Value, now: i64) -> Value {
        if let Err(code) = self.preflight() {
            return fail(code);
        }
        let sanitized = match sanitize_create_input(input) {
            Ok(value) => value,
            Err(code) => return fail(code),
        };
        match self.authed_json(
            "POST",
            &format!("{DESKTOP_CONTROL_API_PREFIX}/quick-sessions"),
            Some(sanitized.to_string()),
            now,
            false,
        ) {
            Ok(payload) => match parse_start_result(&payload) {
                Some(result) => json!({ "ok": true, "result": result }),
                None => fail("result_unknown"),
            },
            Err(code) => fail(code),
        }
    }

    fn preflight(&self) -> Result<(), &'static str> {
        if self.stopped.lock().map(|value| *value).unwrap_or(true) {
            return Err("disconnected");
        }
        if !self.connected.lock().map(|value| *value).unwrap_or(false) {
            return Err("disconnected");
        }
        if !self.available.lock().map(|value| *value).unwrap_or(false) {
            return Err("feature_unavailable");
        }
        Ok(())
    }

    fn discard_token(&self) {
        if let Ok(mut state) = self.token.lock() {
            state.token = None;
            state.expires_at = 0;
        }
    }

    fn origin(&self) -> String {
        let port = self.port.lock().map(|port| *port).unwrap_or(62666);
        build_desktop_origin(port)
    }

    fn authed_json(
        &self,
        method: &str,
        pathname: &str,
        body: Option<String>,
        now: i64,
        remint: bool,
    ) -> Result<Value, &'static str> {
        let token = self.ensure_token(now, remint)?;
        match self.request_json(method, pathname, Some(&token), body.as_deref()) {
            Ok(payload) => Ok(payload),
            Err("unauthorized") => {
                self.discard_token();
                let token = self.ensure_token(now, true)?;
                self.request_json(method, pathname, Some(&token), body.as_deref())
            }
            Err(code) => Err(code),
        }
    }

    fn ensure_token(&self, now: i64, remint: bool) -> Result<String, &'static str> {
        if !remint {
            if let Ok(state) = self.token.lock() {
                if let Some(token) = &state.token {
                    if state.expires_at - 5_000 > now {
                        return Ok(token.clone());
                    }
                }
            }
        }
        self.mint_token(now)
    }

    fn mint_token(&self, now: i64) -> Result<String, &'static str> {
        let access_key = self
            .access_key
            .lock()
            .ok()
            .and_then(|value| value.clone());
        let body = if let Some(key) = access_key {
            json!({ "accessKey": key }).to_string()
        } else {
            "{}".to_string()
        };
        let payload = self.request_json(
            "POST",
            &format!("{DESKTOP_CONTROL_API_PREFIX}/session"),
            None,
            Some(&body),
        )?;
        let token = payload
            .get("token")
            .and_then(Value::as_str)
            .filter(|token| token.contains('.'))
            .ok_or("result_unknown")?;
        let instance_id = payload.get("instanceId").and_then(Value::as_str);
        if let Ok(current) = self.instance_id.lock() {
            if let (Some(expected), Some(actual)) = (current.as_deref(), instance_id) {
                if expected != actual {
                    return Err("result_unknown");
                }
            }
        }
        let expires_at = payload
            .get("expiresAt")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .unwrap_or(now + 5 * 60 * 1000);
        if let Ok(mut state) = self.token.lock() {
            state.token = Some(token.to_string());
            state.expires_at = expires_at;
        }
        Ok(token.to_string())
    }

    fn request_json(
        &self,
        method: &str,
        pathname: &str,
        token: Option<&str>,
        body: Option<&str>,
    ) -> Result<Value, &'static str> {
        let url = format!("{}{pathname}", self.origin());
        let mut headers = Vec::new();
        if method == "POST" {
            headers.push(("content-type".to_string(), "application/json".to_string()));
        }
        if let Some(token) = token {
            headers.push((DESKTOP_CONTROL_TOKEN_HEADER.to_string(), token.to_string()));
        }
        let response = self
            .transport
            .fetch(HttpRequest {
                method: method.to_string(),
                url,
                headers,
                body: body.map(ToString::to_string),
            })
            .map_err(|error| {
                if matches!(
                    classify_fetch_failure(&error),
                    crate::connection_state::DesktopConnectionEvent::ConnectionRefused
                ) {
                    "disconnected"
                } else {
                    "result_unknown"
                }
            })?;
        if response.connection_refused {
            return Err("disconnected");
        }
        let payload = serde_json::from_str::<Value>(&response.body).unwrap_or(json!({}));
        if response.status >= 400 {
            return Err(classify_http(response.status, &payload));
        }
        Ok(payload)
    }
}

pub fn sanitize_create_input(input: &Value) -> Result<Value, &'static str> {
    let project_ref = input
        .get("projectRef")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or("bad_request")?;
    if !is_project_ref(project_ref) {
        return Err("bad_request");
    }
    let request_id = input
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or("bad_request")?;
    if !is_request_id(request_id) {
        return Err("bad_request");
    }
    let Some(message) = input.get("message").and_then(Value::as_str) else {
        return Err("bad_request");
    };
    if message.trim().is_empty() {
        return Err("message_empty");
    }
    if message.chars().count() > DESKTOP_QUICK_SESSION_MAX_MESSAGE_CHARS {
        return Err("message_too_long");
    }
    let has_provider = input.get("provider").is_some();
    let has_model = input.get("modelId").is_some();
    if has_provider != has_model {
        return Err("bad_request");
    }
    let mut body = json!({
        "projectRef": project_ref,
        "message": message,
        "requestId": request_id,
    });
    if has_provider {
        let provider = input
            .get("provider")
            .and_then(Value::as_str)
            .map(str::trim)
            .ok_or("bad_request")?;
        let model_id = input
            .get("modelId")
            .and_then(Value::as_str)
            .map(str::trim)
            .ok_or("bad_request")?;
        if !is_provider(provider) || !is_model_id(model_id) {
            return Err("bad_request");
        }
        body["provider"] = json!(provider);
        body["modelId"] = json!(model_id);
    }
    Ok(body)
}

fn fail(code: &str) -> Value {
    json!({ "ok": false, "code": code })
}

fn classify_http(status: u16, payload: &Value) -> &'static str {
    let code = payload.get("code").and_then(Value::as_str).unwrap_or("");
    if status == 401 || status == 403 {
        return match code {
            "auth_invalid" => "auth_invalid",
            "auth_required" => "auth_required",
            _ => "unauthorized",
        };
    }
    match code {
        "message_empty" => "message_empty",
        "message_too_long" => "message_too_long",
        "project_unknown" => "project_unknown",
        "project_unavailable" => "project_unavailable",
        "project_collision" => "project_collision",
        "project_out_of_catalog" => "project_out_of_catalog",
        "model_unavailable" => "model_unavailable",
        "request_conflict" => "request_conflict",
        "start_failed" => "start_failed",
        "bad_request" => "bad_request",
        _ if status == 0 => "result_unknown",
        _ => "result_unknown",
    }
}

fn normalize_access_key(value: Option<&str>) -> Option<String> {
    let key = value?.trim();
    if key.is_empty() || key.len() > 512 {
        None
    } else {
        Some(key.to_string())
    }
}

fn is_project_ref(value: &str) -> bool {
    let rest = match value.strip_prefix("p_") {
        Some(rest) => rest,
        None => return false,
    };
    rest.len() == 16 && rest.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn is_request_id(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    if parts.len() != 5 {
        return false;
    }
    let lens = [8usize, 4, 4, 4, 12];
    parts.iter().zip(lens).all(|(part, len)| {
        part.len() == len && part.chars().all(|ch| ch.is_ascii_hexdigit())
    })
}

fn is_provider(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value == value.trim()
        && !value.contains(['\\', '/', '\0'])
}

fn is_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value == value.trim()
        && !value.contains(['\\', '/', '\0'])
}

fn encode_query(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else {
            for byte in ch.to_string().into_bytes() {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    out
}

fn assert_safe_payload(value: &Value) -> bool {
    let Ok(json) = serde_json::to_string(value) else {
        return false;
    };
    !FORBIDDEN_PAYLOAD_KEYS
        .iter()
        .any(|key| json.contains(&format!("\"{key}\":")))
}

fn parse_catalog(payload: &Value) -> Option<Value> {
    let projects = payload.get("projects")?.as_array()?;
    let mut out = Vec::new();
    for item in projects {
        let project_ref = item.get("projectRef")?.as_str()?;
        if !is_project_ref(project_ref) {
            return None;
        }
        let display_name = item.get("displayName")?.as_str()?.trim();
        if display_name.is_empty() {
            return None;
        }
        let mut row = json!({
            "projectRef": project_ref,
            "displayName": display_name,
            "latestModified": item.get("latestModified").and_then(Value::as_str).unwrap_or(""),
            "archived": item.get("archived") == Some(&Value::Bool(true)),
            "worktree": item.get("worktree") == Some(&Value::Bool(true)),
        });
        if let Some(disambiguator) = item
            .get("disambiguator")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            row["disambiguator"] = json!(disambiguator);
        }
        out.push(row);
    }
    let catalog = json!({
        "projects": out,
        "truncated": payload.get("truncated") == Some(&Value::Bool(true)),
        "omitted": payload.get("omitted").and_then(Value::as_u64).unwrap_or(0),
    });
    assert_safe_payload(&catalog).then_some(catalog)
}

fn parse_model_catalog(payload: &Value) -> Option<Value> {
    let project_ref = payload.get("projectRef")?.as_str()?;
    if !is_project_ref(project_ref) {
        return None;
    }
    let models = payload.get("models")?.as_array()?;
    if models.len() > 80 {
        return None;
    }
    let mut out = Vec::new();
    for item in models {
        let provider = item.get("provider")?.as_str()?;
        let model_id = item.get("modelId")?.as_str()?;
        let name = item.get("name")?.as_str()?.trim();
        if !is_provider(provider) || !is_model_id(model_id) || name.is_empty() {
            return None;
        }
        out.push(json!({
            "provider": provider,
            "modelId": model_id,
            "name": name,
            "primaryCandidate": item.get("primaryCandidate") == Some(&Value::Bool(true)),
        }));
    }
    let default_model = match payload.get("defaultModel") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Object(object)) => {
            let provider = object.get("provider")?.as_str()?;
            let model_id = object.get("modelId")?.as_str()?;
            if !is_provider(provider) || !is_model_id(model_id) {
                return None;
            }
            json!({ "provider": provider, "modelId": model_id })
        }
        _ => return None,
    };
    let catalog = json!({
        "projectRef": project_ref,
        "defaultModel": default_model,
        "models": out,
        "truncated": payload.get("truncated") == Some(&Value::Bool(true)),
    });
    assert_safe_payload(&catalog).then_some(catalog)
}

fn parse_start_result(payload: &Value) -> Option<Value> {
    let session_id = payload.get("sessionId")?.as_str()?.trim();
    let deep_link = payload.get("deepLink")?.as_str()?;
    if session_id.is_empty() || !deep_link.starts_with("/?session=") {
        return None;
    }
    let result = json!({
        "sessionId": session_id,
        "deepLink": deep_link,
        "duplicate": payload.get("duplicate") == Some(&Value::Bool(true)),
    });
    assert_safe_payload(&result).then_some(result)
}
