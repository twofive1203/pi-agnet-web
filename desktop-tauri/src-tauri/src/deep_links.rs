use serde_json::{json, Value};

use crate::connection_state::is_loopback_observer_url;

const ID_PATTERN_MAX: usize = 128;
const ALLOWED_QUERY: [&str; 5] = ["session", "inspector", "task", "panel", "run"];
const FORBIDDEN_QUERY: [&str; 12] = [
    "cwd",
    "path",
    "file",
    "filePath",
    "sessionPath",
    "url",
    "href",
    "redirect",
    "next",
    "token",
    "prompt",
    "command",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkResult {
    Ok { url: String },
    Err { reason: String },
}

impl DeepLinkResult {
    pub fn to_json(&self) -> Value {
        match self {
            DeepLinkResult::Ok { url } => json!({ "ok": true, "url": url }),
            DeepLinkResult::Err { reason } => json!({ "ok": false, "reason": reason }),
        }
    }
}

pub fn reject_arbitrary_renderer_url(raw: &str) -> DeepLinkResult {
    let value = raw.trim();
    if value.is_empty() {
        return DeepLinkResult::Err {
            reason: "empty".to_string(),
        };
    }
    if has_scheme_or_protocol_relative(value) {
        return DeepLinkResult::Err {
            reason: "absolute_url_rejected".to_string(),
        };
    }
    DeepLinkResult::Err {
        reason: "not_allowlisted".to_string(),
    }
}

pub fn is_allowlisted_desktop_deep_link(raw: &str) -> bool {
    parse_desktop_deep_link(raw).is_ok()
}

pub fn parse_desktop_deep_link(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty".to_string());
    }
    if has_scheme_or_protocol_relative(trimmed) || trimmed.contains('\\') {
        return Err("absolute_or_protocol_relative".to_string());
    }
    if !trimmed.starts_with('/') {
        return Err("must_be_root_relative".to_string());
    }
    if trimmed.starts_with("//") {
        return Err("protocol_relative".to_string());
    }
    if trimmed.contains('#') {
        return Err("hash_not_allowed".to_string());
    }
    let (path, query) = split_path_query(trimmed);
    if path != "/" {
        return Err("path_not_allowlisted".to_string());
    }
    let params = parse_query(query)?;
    for key in params.iter().map(|(key, _)| key.as_str()) {
        if FORBIDDEN_QUERY.contains(&key) || key.eq_ignore_ascii_case("cwd") {
            return Err(format!("forbidden_query:{key}"));
        }
        if !ALLOWED_QUERY.contains(&key) {
            return Err(format!("unknown_query:{key}"));
        }
    }
    build_canonical_href(&params)
}

pub fn resolve_desktop_deep_link(origin: &str, relative_href: &str) -> DeepLinkResult {
    let origin_trimmed = origin.trim().trim_end_matches('/');
    if !origin_trimmed.starts_with("http://") && !origin_trimmed.starts_with("https://") {
        return DeepLinkResult::Err {
            reason: "origin_protocol".to_string(),
        };
    }
    let host = origin_trimmed
        .split_once("://")
        .map(|(_, rest)| rest.split('/').next().unwrap_or(rest))
        .unwrap_or_default();
    let hostname = host.split(':').next().unwrap_or(host);
    if hostname != "127.0.0.1" {
        return DeepLinkResult::Err {
            reason: "origin_not_loopback".to_string(),
        };
    }
    match parse_desktop_deep_link(relative_href) {
        Ok(href) => {
            let url = format!("{origin_trimmed}{href}");
            let port = host
                .split_once(':')
                .and_then(|(_, port)| port.parse::<u16>().ok())
                .unwrap_or(80);
            if !is_loopback_observer_url(&url, port) && !url.starts_with("http://127.0.0.1") {
                return DeepLinkResult::Err {
                    reason: "origin_not_loopback".to_string(),
                };
            }
            DeepLinkResult::Ok { url }
        }
        Err(reason) => DeepLinkResult::Err { reason },
    }
}

pub fn open_validated_deep_link(origin: &str, relative_href: &str) -> DeepLinkResult {
    let href = relative_href.trim();
    if href.is_empty() {
        return DeepLinkResult::Err {
            reason: "empty".to_string(),
        };
    }
    if has_scheme_or_protocol_relative(href) {
        return DeepLinkResult::Err {
            reason: "absolute_or_protocol_relative".to_string(),
        };
    }
    if !is_allowlisted_desktop_deep_link(href) {
        return DeepLinkResult::Err {
            reason: "not_allowlisted".to_string(),
        };
    }
    match resolve_desktop_deep_link(origin, href) {
        DeepLinkResult::Ok { url } => match crate::native::open_https_or_loopback_url(&url) {
            Ok(()) => DeepLinkResult::Ok { url },
            Err(_) => DeepLinkResult::Err {
                reason: "open_failed".to_string(),
            },
        },
        other => other,
    }
}

fn has_scheme_or_protocol_relative(value: &str) -> bool {
    if value.starts_with("//") {
        return true;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    let rest: String = chars.collect();
    let prefix_end = rest
        .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '+' || ch == '.' || ch == '-'))
        .unwrap_or(rest.len());
    rest.as_bytes().get(prefix_end) == Some(&b':')
}

fn split_path_query(value: &str) -> (&str, &str) {
    match value.split_once('?') {
        Some((path, query)) => (path, query),
        None => (value, ""),
    }
}

fn parse_query(query: &str) -> Result<Vec<(String, String)>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut params = Vec::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let (key, value) = match pair.split_once('=') {
            Some((key, value)) => (decode(key), decode(value)),
            None => (decode(pair), String::new()),
        };
        params.push((key, value));
    }
    Ok(params)
}

fn decode(value: &str) -> String {
    let mut out = String::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                out.push(' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = &value[index + 1..index + 3];
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte as char);
                    index += 3;
                } else {
                    out.push('%');
                    index += 1;
                }
            }
            other => {
                out.push(other as char);
                index += 1;
            }
        }
    }
    out
}

fn require_id(label: &str, value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("{label} is required"));
    }
    if trimmed.len() > ID_PATTERN_MAX
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
    {
        return Err(format!("{label} must not contain path segments"));
    }
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return Err(format!("{label} is not a stable id"));
    };
    if !first.is_ascii_alphanumeric() {
        return Err(format!("{label} is not a stable id"));
    }
    if !chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '-')) {
        return Err(format!("{label} is not a stable id"));
    }
    Ok(trimmed.to_string())
}

fn encode_id(value: &str) -> String {
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

fn first<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(candidate, _)| candidate == key)
        .map(|(_, value)| value.as_str())
}

fn build_canonical_href(params: &[(String, String)]) -> Result<String, String> {
    let panel = first(params, "panel").unwrap_or("").trim();
    let inspector = first(params, "inspector").unwrap_or("").trim();
    let session_raw = first(params, "session").unwrap_or("").trim();
    let session_id = if session_raw.is_empty() {
        None
    } else {
        Some(require_id("sessionId", session_raw)?)
    };
    let task_raw = first(params, "task").map(str::trim).filter(|value| !value.is_empty());
    let run_raw = first(params, "run").map(str::trim).filter(|value| !value.is_empty());

    if panel == "automation" {
        if !inspector.is_empty() {
            return Err("automation_panel_with_inspector".to_string());
        }
        let task = require_id("taskId", task_raw.ok_or_else(|| "automation_requires_task_and_run".to_string())?)?;
        let run = require_id("runId", run_raw.ok_or_else(|| "automation_requires_task_and_run".to_string())?)?;
        return Ok(format!(
            "/?panel=automation&task={}&run={}",
            encode_id(&task),
            encode_id(&run)
        ));
    }
    if panel == "quick-commands" {
        if !inspector.is_empty() {
            return Err("quick_command_with_inspector".to_string());
        }
        if task_raw.is_some() {
            return Err("quick_command_rejects_task".to_string());
        }
        let run = require_id("runId", run_raw.ok_or_else(|| "quick_command_requires_run".to_string())?)?;
        return Ok(format!("/?panel=quick-commands&run={}", encode_id(&run)));
    }
    if !panel.is_empty() {
        return Err(format!("unknown_panel:{panel}"));
    }
    if inspector == "snflow" {
        if run_raw.is_some() {
            return Err("snflow_rejects_run".to_string());
        }
        let task = require_id("taskId", task_raw.ok_or_else(|| "snflow_requires_task".to_string())?)?;
        return Ok(match session_id {
            Some(session) => format!(
                "/?session={}&inspector=snflow&task={}",
                encode_id(&session),
                encode_id(&task)
            ),
            None => format!("/?inspector=snflow&task={}", encode_id(&task)),
        });
    }
    if !inspector.is_empty() {
        return Err(format!("unknown_inspector:{inspector}"));
    }
    if let Some(session) = session_id {
        if task_raw.is_none() && run_raw.is_none() {
            return Ok(format!("/?session={}", encode_id(&session)));
        }
    }
    Err("missing_target".to_string())
}
