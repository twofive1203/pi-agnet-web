use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::activity_view::{
    assert_renderer_view_safe, build_activity_view, default_desktop_settings, find_last_transition_id,
    mark_activity_read, mark_all_terminal_read, overlay_settings, select_transition_effects,
    BuildViewInput, DesktopPetSettings,
};
use crate::connection_state::{
    build_desktop_origin, is_loopback_observer_url, DesktopConnectionReasonCode,
    DesktopConnectionState,
};
use crate::observer_client::{
    LoopbackTransport, ObserverClient, ProbeResult, DESKTOP_OBSERVER_TOKEN_HEADER,
};
use crate::window_controller;

pub const STATE_CHANGED_EVENT: &str = "pet:state-changed";
pub const SOUND_CUE_EVENT: &str = "pet:sound-cue";

pub struct PetRuntime {
    pub settings: DesktopPetSettings,
    pub snapshot: Option<Value>,
    pub connection: DesktopConnectionState,
    pub selected_activity_id: Option<String>,
    pub reduced_motion: bool,
    pub stale: bool,
    pub reset: bool,
    pub access_key: Option<String>,
}

impl PetRuntime {
    pub fn new() -> Self {
        let settings = default_desktop_settings();
        let connection = crate::connection_state::create_initial_connection_state(settings.port, now_ms());
        Self {
            settings,
            snapshot: None,
            connection,
            selected_activity_id: None,
            reduced_motion: false,
            stale: false,
            reset: true,
            access_key: None,
        }
    }

    pub fn view(&self) -> Result<Value, String> {
        let view = build_activity_view(BuildViewInput {
            snapshot: self.snapshot.as_ref(),
            connection: &self.connection,
            settings: &self.settings,
            now: now_ms(),
            reduced_motion: self.reduced_motion,
            selected_activity_id: self.selected_activity_id.clone(),
            stale: self.stale,
            has_access_key: self.access_key.is_some(),
            tray_anchor: Some("top-left"),
            reset: self.reset,
        });
        assert_renderer_view_safe(&view)?;
        Ok(view)
    }
}

pub struct AppState {
    pub runtime: Mutex<PetRuntime>,
    pub client: Arc<ObserverClient<LoopbackTransport>>,
    stopped: Arc<AtomicBool>,
}

impl AppState {
    pub fn start(app: AppHandle) -> Result<Arc<Self>, String> {
        let runtime = PetRuntime::new();
        let port = runtime.settings.port;
        let access_key = runtime.access_key.clone();
        let runtime = Mutex::new(runtime);
        let app_for_state = app.clone();
        let app_for_snapshot = app.clone();
        let client = Arc::new(ObserverClient::new(
            port,
            now_ms(),
            LoopbackTransport::new(),
            access_key,
            Some(Arc::new(move |state| {
                if let Some(store) = app_for_state.try_state::<Arc<AppState>>() {
                    store.apply_connection(state);
                    let _ = store.emit_view(&app_for_state);
                }
            })),
            Some(Arc::new(move |json, meta| {
                if let Some(store) = app_for_snapshot.try_state::<Arc<AppState>>() {
                    store.apply_snapshot(&app_for_snapshot, &json, meta.reset);
                    let _ = store.emit_view(&app_for_snapshot);
                }
            })),
        ));
        Ok(Arc::new(Self {
            runtime,
            client,
            stopped: Arc::new(AtomicBool::new(false)),
        }))
    }

    pub fn spawn(self: &Arc<Self>) {
        spawn_observer_loop(self.clone());
    }

    pub fn apply_connection(&self, state: DesktopConnectionState) {
        if let Ok(mut runtime) = self.runtime.lock() {
            if state.status != crate::connection_state::DesktopConnectionStatus::Connected {
                runtime.stale = runtime.snapshot.is_some();
            }
            if matches!(
                state.reason_code,
                Some(DesktopConnectionReasonCode::AuthRequired | DesktopConnectionReasonCode::AuthInvalid)
            ) {
                runtime.settings.activity_tray_open = true;
            }
            runtime.connection = state;
        }
    }

    pub fn apply_snapshot(&self, app: &AppHandle, json: &str, reset: bool) {
        let parsed = match serde_json::from_str::<Value>(json) {
            Ok(Value::Object(value)) if value.get("instanceId").and_then(Value::as_str).is_some() => {
                Value::Object(value)
            }
            _ => return,
        };
        let cues = if let Ok(mut runtime) = self.runtime.lock() {
            let effects = select_transition_effects(
                &runtime.settings,
                &parsed,
                reset || parsed.get("reset") == Some(&Value::Bool(true)),
                false,
                now_ms(),
            );
            runtime.settings.notified_transition_ids = effects.notified_transition_ids;
            runtime.settings.sounded_transition_ids = effects.sounded_transition_ids.clone();
            runtime.snapshot = Some(parsed);
            runtime.reset = reset;
            runtime.stale = false;
            runtime.connection = self.client.get_state();
            effects.sound_cues
        } else {
            Vec::new()
        };
        for cue in cues {
            self.emit_sound(app, &cue);
        }
    }

    pub fn emit_view(&self, app: &AppHandle) -> Result<Value, String> {
        let view = self
            .runtime
            .lock()
            .map_err(|_| "runtime lock poisoned".to_string())?
            .view()?;
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.reset = false;
        }
        app.emit(STATE_CHANGED_EVENT, &view)
            .map_err(|error| error.to_string())?;
        Ok(view)
    }

    pub fn emit_sound(&self, app: &AppHandle, kind: &str) {
        let _ = app.emit(SOUND_CUE_EVENT, json!({ "kind": kind }));
    }

    pub fn current_view(&self) -> Result<Value, String> {
        self.runtime
            .lock()
            .map_err(|_| "runtime lock poisoned".to_string())?
            .view()
    }

    pub fn retry(&self) {
        let _ = self.client.retry(now_ms());
    }

    pub fn quit_network(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.client.quit(now_ms());
    }

    pub fn set_access_key(&self, access_key: Option<String>) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.access_key = access_key.clone();
        }
        self.client.set_access_key(access_key);
        let _ = self.client.retry(now_ms());
    }

    pub fn apply_prefs(&self, patch: Value, window: &tauri::WebviewWindow) -> Result<Value, String> {
        {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "runtime lock poisoned".to_string())?;
            runtime.settings = overlay_settings(runtime.settings.clone(), &patch);
            if let Some(always_on_top) = patch.get("alwaysOnTop").and_then(Value::as_bool) {
                let _ = window.set_always_on_top(always_on_top);
            }
            if let Some(click_through) = patch.get("clickThrough").and_then(Value::as_bool) {
                let _ = window_controller::set_click_through(window, click_through);
            }
            if let Some(port) = patch.get("port").and_then(Value::as_u64) {
                if port > 0 && port <= 65535 {
                    runtime.connection.port = port as u16;
                    runtime.connection.origin = build_desktop_origin(port as u16);
                }
            }
        }
        self.current_view()
    }

    pub fn toggle_tray(&self, window: &tauri::WebviewWindow) -> Result<Value, String> {
        let expanded = {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "runtime lock poisoned".to_string())?;
            runtime.settings.activity_tray_open = !runtime.settings.activity_tray_open;
            runtime.settings.activity_tray_open
        };
        window_controller::resize_window(window, expanded)?;
        self.current_view()
    }

    pub fn select_activity(&self, activity_id: String) -> Result<Value, String> {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.selected_activity_id = Some(activity_id);
        }
        self.current_view()
    }

    pub fn mark_read(&self, activity_id: &str) -> Result<Value, String> {
        let view = self.current_view()?;
        if let Some(transition_id) = find_last_transition_id(&view, activity_id) {
            if let Ok(mut runtime) = self.runtime.lock() {
                runtime.settings = mark_activity_read(&runtime.settings, &transition_id);
            }
        }
        self.current_view()
    }

    pub fn mark_all_read(&self) -> Result<Value, String> {
        let view = self.current_view()?;
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.settings = mark_all_terminal_read(&runtime.settings, &view);
        }
        self.current_view()
    }
}

fn spawn_observer_loop(state: Arc<AppState>) {
    thread::Builder::new()
        .name("snail-pi-tauri-observer".to_string())
        .spawn(move || {
            let mut attempt = 0u32;
            while !state.stopped.load(Ordering::SeqCst) {
                match state.client.start(now_ms()) {
                    ProbeResult::Ok(_) => {
                        attempt = 0;
                        stream_observer_sse(&state);
                    }
                    ProbeResult::Err(event) => {
                        if matches!(
                            event,
                            crate::connection_state::DesktopConnectionEvent::ConnectionRefused
                                | crate::connection_state::DesktopConnectionEvent::NetworkError { .. }
                        ) {
                            attempt = attempt.saturating_add(1);
                            let delay = Duration::from_millis((1500 * attempt.min(8) as u64).min(30_000));
                            thread::sleep(delay);
                        } else {
                            thread::sleep(Duration::from_secs(5));
                        }
                    }
                }
            }
        })
        .expect("observer thread");
}

fn stream_observer_sse(state: &AppState) {
    let Some(token) = state.client.token_for_tests() else {
        return;
    };
    let connection = state.client.get_state();
    let url = format!(
        "{}/api/desktop-observer/events",
        build_desktop_origin(connection.port)
    );
    if !is_loopback_observer_url(&url, connection.port) {
        return;
    }
    let response = match ureq::get(&url)
        .timeout(Duration::from_secs(60))
        .set("Accept", "text/event-stream")
        .set(DESKTOP_OBSERVER_TOKEN_HEADER, &token)
        .call()
    {
        Ok(response) => response,
        Err(ureq::Error::Status(401 | 403, _)) => {
            state.client.handle_token_expiry(now_ms());
            return;
        }
        Err(error) => {
            let classified = crate::observer_client::classify_fetch_failure(&error.to_string());
            if matches!(
                classified,
                crate::connection_state::DesktopConnectionEvent::ConnectionRefused
            ) {
                state.client.handle_token_expiry(now_ms());
            }
            return;
        }
    };

    let reader = BufReader::new(response.into_reader());
    let mut block = String::new();
    for line in reader.lines() {
        if state.stopped.load(Ordering::SeqCst) {
            break;
        }
        let Ok(line) = line else {
            break;
        };
        if line.is_empty() {
            state
                .client
                .consume_sse_text(&format!("{block}\n\n"), now_ms());
            block.clear();
        } else {
            block.push_str(&line);
            block.push('\n');
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}
