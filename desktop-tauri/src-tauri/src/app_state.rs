use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::access_key::{default_codec, normalize_access_key_input, AccessKeyCodec};
use crate::activity_view::{
    assert_renderer_view_safe, build_activity_view, find_last_transition_id, mark_activity_read,
    mark_all_terminal_read, BuildViewInput, DesktopPetSettings, TransitionRuntimeState,
};
use crate::connection_state::{
    build_desktop_origin, is_target_scoped_url, ConnectionTarget, DesktopConnectionReasonCode,
    DesktopConnectionState,
};
use crate::custom_pets::{
    normalize_selected_pet, read_pet_asset, renderer_catalog_payload, resolve_codex_root,
    resolve_snail_root, scan_pet_catalog, PetCatalogState,
};
use crate::deep_links::{open_validated_deep_link, reject_arbitrary_renderer_url};
use crate::notifications::{select_notification_candidates_with_runtime, show_candidates};
use crate::observer_client::{
    LoopbackTransport, ObserverClient, ProbeResult, DESKTOP_OBSERVER_TOKEN_HEADER,
};
use crate::quick_session_client::QuickSessionClient;
use crate::server_profiles::{
    assert_projection_safe, connection_fields_changed, delete_server_profile,
    load_or_migrate_profile_store, parse_save_intent, profiles_projection_json, save_profile_store,
    save_server_profile, switch_active_profile, ProfileError, RuntimeProfile, RuntimeProfileStore,
};
use crate::settings::{apply_settings_patch, load_desktop_settings, save_desktop_settings};
use crate::window_controller::{self, TrayLayoutAnchor};

pub const STATE_CHANGED_EVENT: &str = "pet:state-changed";
pub const SOUND_CUE_EVENT: &str = "pet:sound-cue";
pub const CUSTOM_PETS_CHANGED_EVENT: &str = "pet:custom-pets-changed";

pub struct PetRuntime {
    pub settings: DesktopPetSettings,
    pub snapshot: Option<Value>,
    pub connection: DesktopConnectionState,
    pub selected_activity_id: Option<String>,
    pub reduced_motion: bool,
    pub stale: bool,
    pub reset: bool,
    pub access_key: Option<String>,
    pub tray_anchor: TrayLayoutAnchor,
    pub app_in_background: bool,
    pub transition_runtime: TransitionRuntimeState,
    pub active_profile_id: String,
    pub active_profile_name: Option<String>,
}

impl PetRuntime {
    pub fn from_profile(settings: DesktopPetSettings, profile: &RuntimeProfile, generation: u64) -> Self {
        let target = target_from_profile(profile, generation);
        let mut connection =
            crate::connection_state::create_initial_connection_state_for_target(&target, now_ms());
        connection.generation = generation;
        Self {
            settings,
            snapshot: None,
            connection,
            selected_activity_id: None,
            reduced_motion: false,
            stale: false,
            reset: true,
            access_key: profile.access_key.clone(),
            tray_anchor: TrayLayoutAnchor::TopLeft,
            app_in_background: true,
            transition_runtime: TransitionRuntimeState::default(),
            active_profile_id: profile.id.clone(),
            active_profile_name: profile.name.clone(),
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
            tray_anchor: Some(self.tray_anchor.as_str()),
            reset: self.reset,
            active_server_id: Some(self.active_profile_id.as_str()),
            active_server_name: self.active_profile_name.as_deref(),
            active_server_generation: self.connection.generation,
        });
        assert_renderer_view_safe(&view)?;
        Ok(view)
    }
}

pub struct AppState {
    pub runtime: Mutex<PetRuntime>,
    pub client: Arc<ObserverClient<LoopbackTransport>>,
    pub quick_session: QuickSessionClient<LoopbackTransport>,
    pub catalog: Mutex<PetCatalogState>,
    pub data_dir: PathBuf,
    profiles: Mutex<RuntimeProfileStore>,
    generation: std::sync::atomic::AtomicU64,
    codec: Box<dyn AccessKeyCodec>,
    stopped: Arc<AtomicBool>,
}

impl AppState {
    pub fn start(app: AppHandle) -> Result<Arc<Self>, String> {
        let data_dir = app
            .path()
            .app_config_dir()
            .map_err(|error| error.to_string())?;
        let mut settings = load_desktop_settings(&data_dir);
        let codec = default_codec();
        let profiles = load_or_migrate_profile_store(&data_dir, settings.port, codec.as_ref());
        let catalog = scan_pet_catalog(&resolve_snail_root(), &resolve_codex_root());
        if normalize_selected_pet(&mut settings, &catalog) {
            let _ = save_desktop_settings(&data_dir, &settings);
        }
        let generation = 1u64;
        let active = profiles
            .active()
            .cloned()
            .unwrap_or_else(|| profiles.profiles[0].clone());
        let runtime = PetRuntime::from_profile(settings, &active, generation);
        let target = target_from_profile(&active, generation);
        let access_key = active.access_key.clone();
        let runtime = Mutex::new(runtime);
        let app_for_state = app.clone();
        let app_for_snapshot = app.clone();
        let client = Arc::new(ObserverClient::with_target(
            target.clone(),
            now_ms(),
            LoopbackTransport::new(),
            access_key.clone(),
            Some(Arc::new(move |state| {
                if let Some(store) = app_for_state.try_state::<Arc<AppState>>() {
                    store.apply_connection(&app_for_state, state);
                    let _ = store.emit_view(&app_for_state);
                }
            })),
            Some(Arc::new(move |json, meta| {
                if let Some(store) = app_for_snapshot.try_state::<Arc<AppState>>() {
                    store.apply_snapshot(&app_for_snapshot, &json, meta.reset, meta.generation);
                    let _ = store.emit_view(&app_for_snapshot);
                }
            })),
        ));
        let quick_session = QuickSessionClient::loopback(target.port, access_key.clone());
        quick_session.set_target(target, access_key);
        Ok(Arc::new(Self {
            runtime,
            client,
            quick_session,
            catalog: Mutex::new(catalog),
            data_dir,
            profiles: Mutex::new(profiles),
            generation: std::sync::atomic::AtomicU64::new(generation),
            codec,
            stopped: Arc::new(AtomicBool::new(false)),
        }))
    }

    pub fn spawn(self: &Arc<Self>) {
        spawn_observer_loop(self.clone());
    }

    pub fn persist(&self) {
        if let Ok(runtime) = self.runtime.lock() {
            let _ = save_desktop_settings(&self.data_dir, &runtime.settings);
        }
    }

    pub fn apply_connection(&self, app: &AppHandle, state: DesktopConnectionState) {
        if !self.generation_matches(state.generation) {
            return;
        }
        self.quick_session.set_connection(&state);
        let needs_auth_tray = matches!(
            state.reason_code,
            Some(
                DesktopConnectionReasonCode::AuthRequired
                    | DesktopConnectionReasonCode::AuthInvalid
            )
        );
        if needs_auth_tray {
            let layout_input = self.runtime.lock().ok().and_then(|runtime| {
                if runtime.settings.activity_tray_open {
                    None
                } else {
                    Some((runtime.settings.pet_scale.clone(), runtime.tray_anchor))
                }
            });
            if let (Some((pet_scale, tray_anchor)), Some(window)) =
                (layout_input, app.get_webview_window("pet"))
            {
                if let Ok(layout) = crate::window_controller::resize_window(
                    &window,
                    &pet_scale,
                    false,
                    tray_anchor,
                    &pet_scale,
                    true,
                ) {
                    if let Ok(mut runtime) = self.runtime.lock() {
                        runtime.settings.activity_tray_open = true;
                        runtime.settings.window_position =
                            Some(crate::activity_view::WindowPosition {
                                x: layout.bounds.x,
                                y: layout.bounds.y,
                            });
                        runtime.tray_anchor = layout.tray_anchor;
                    }
                }
            }
        }
        if let Ok(mut runtime) = self.runtime.lock() {
            if state.status != crate::connection_state::DesktopConnectionStatus::Connected {
                runtime.stale = runtime.snapshot.is_some();
            }
            runtime.connection = state;
        }
    }

    pub fn apply_snapshot(&self, app: &AppHandle, json: &str, reset: bool, generation: u64) {
        if !self.generation_matches(generation) {
            return;
        }
        let parsed = match serde_json::from_str::<Value>(json) {
            Ok(Value::Object(value))
                if value.get("instanceId").and_then(Value::as_str).is_some() =>
            {
                Value::Object(value)
            }
            _ => return,
        };
        let reset_baseline = reset || parsed.get("reset") == Some(&Value::Bool(true));
        let (cues, origin, candidates) = if let Ok(mut runtime) = self.runtime.lock() {
            let settings = runtime.settings.clone();
            let app_in_background = runtime.app_in_background;
            let mut transition_runtime = std::mem::take(&mut runtime.transition_runtime);
            let (candidates, effects) = select_notification_candidates_with_runtime(
                &settings,
                &parsed,
                reset_baseline,
                app_in_background,
                now_ms(),
                &mut transition_runtime,
            );
            runtime.transition_runtime = transition_runtime;
            runtime.settings.notified_transition_ids = effects.notified_transition_ids;
            runtime.settings.sounded_transition_ids = effects.sounded_transition_ids.clone();
            runtime.snapshot = Some(parsed);
            runtime.reset = reset;
            runtime.stale = false;
            runtime.connection = self.client.get_state();
            (
                effects.sound_cues,
                runtime.connection.origin.clone(),
                candidates,
            )
        } else {
            (Vec::new(), String::new(), Vec::new())
        };
        self.persist();
        show_candidates(&origin, &candidates);
        for cue in cues {
            self.emit_sound(app, &cue);
        }
    }

    pub fn set_app_in_background(&self, app_in_background: bool) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.app_in_background = app_in_background;
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
        crate::tray_controller::refresh_tray(app).map_err(|error| error.to_string())?;
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
        self.quick_session.quit();
    }

    pub fn set_access_key(&self, access_key: Option<String>) -> Value {
        let command = if let Some(raw) = access_key {
            let Some(normalized) = normalize_access_key_input(Some(&raw)) else {
                return json!({ "ok": false, "reason": "invalid_key" });
            };
            crate::server_profiles::AccessKeyCommand::Replace(normalized)
        } else {
            crate::server_profiles::AccessKeyCommand::Clear
        };
        match self.mutate_active_profile_key(command) {
            Ok(persisted) => {
                let _ = self.reconnect_active();
                json!({ "ok": true, "persisted": persisted })
            }
            Err(error) => json!({ "ok": false, "reason": error.code() }),
        }
    }

    pub fn apply_prefs(&self, patch: Value, window: &WebviewWindow) -> Result<Value, String> {
        let (previous, current_anchor) = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| "runtime lock poisoned".to_string())?;
            (runtime.settings.clone(), runtime.tray_anchor)
        };
        let mut next = apply_settings_patch(previous.clone(), &patch);
        let layout_changed = previous.pet_scale != next.pet_scale
            || previous.activity_tray_open != next.activity_tray_open;
        let layout = if layout_changed {
            Some(crate::window_controller::resize_window(
                window,
                &previous.pet_scale,
                previous.activity_tray_open,
                current_anchor,
                &next.pet_scale,
                next.activity_tray_open,
            )?)
        } else {
            None
        };
        if let Some(layout) = layout {
            next.window_position = Some(crate::activity_view::WindowPosition {
                x: layout.bounds.x,
                y: layout.bounds.y,
            });
        }

        if let Some(always_on_top) = patch.get("alwaysOnTop").and_then(Value::as_bool) {
            window
                .set_always_on_top(always_on_top)
                .map_err(|error| error.to_string())?;
        }
        if let Some(click_through) = patch.get("clickThrough").and_then(Value::as_bool) {
            window_controller::set_click_through(window, click_through)?;
        }

        let launch_at_login =
            (previous.launch_at_login != next.launch_at_login).then_some(next.launch_at_login);
        if let Some(enabled) = launch_at_login {
            if !crate::native::apply_launch_at_login(enabled) {
                return Err("failed to update launch-at-login state".to_string());
            }
        }
        {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "runtime lock poisoned".to_string())?;
            runtime.settings = next;
            if let Some(layout) = layout {
                runtime.tray_anchor = layout.tray_anchor;
            }
        }
        self.persist();
        self.current_view()
    }

    pub fn set_click_through_pref(
        &self,
        click_through: bool,
        window: &WebviewWindow,
    ) -> Result<Value, String> {
        self.apply_prefs(json!({ "clickThrough": click_through }), window)
    }

    pub fn toggle_dnd(&self, window: &WebviewWindow) -> Result<Value, String> {
        let enabled = self
            .runtime
            .lock()
            .ok()
            .map(|runtime| !runtime.settings.dnd_enabled)
            .unwrap_or(true);
        self.apply_prefs(json!({ "dndEnabled": enabled }), window)
    }

    pub fn toggle_sound(&self, window: &WebviewWindow) -> Result<Value, String> {
        let enabled = self
            .runtime
            .lock()
            .ok()
            .map(|runtime| !runtime.settings.sound.master_enabled)
            .unwrap_or(true);
        self.apply_prefs(json!({ "sound": { "masterEnabled": enabled } }), window)
    }

    pub fn toggle_tray(&self, window: &WebviewWindow) -> Result<Value, String> {
        let (pet_scale, expanded, tray_anchor) = {
            let runtime = self
                .runtime
                .lock()
                .map_err(|_| "runtime lock poisoned".to_string())?;
            (
                runtime.settings.pet_scale.clone(),
                runtime.settings.activity_tray_open,
                runtime.tray_anchor,
            )
        };
        let layout = window_controller::resize_window(
            window,
            &pet_scale,
            expanded,
            tray_anchor,
            &pet_scale,
            !expanded,
        )?;
        {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "runtime lock poisoned".to_string())?;
            runtime.settings.activity_tray_open = !expanded;
            runtime.settings.window_position = Some(crate::activity_view::WindowPosition {
                x: layout.bounds.x,
                y: layout.bounds.y,
            });
            runtime.tray_anchor = layout.tray_anchor;
        }
        self.persist();
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
        self.persist();
        self.current_view()
    }

    pub fn mark_all_read(&self) -> Result<Value, String> {
        let view = self.current_view()?;
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.settings = mark_all_terminal_read(&runtime.settings, &view);
        }
        self.persist();
        self.current_view()
    }

    pub fn persist_window_position(&self, x: i32, y: i32) {
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.settings.window_position = Some(crate::activity_view::WindowPosition { x, y });
        }
        self.persist();
    }

    pub fn restore_default_window(&self, window: &WebviewWindow) -> Result<Value, String> {
        let layout = window_controller::restore_default_layout(window)?;
        {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "runtime lock poisoned".to_string())?;
            runtime.settings.pet_scale = "medium".to_string();
            runtime.settings.activity_tray_open = false;
            runtime.settings.window_position = Some(crate::activity_view::WindowPosition {
                x: layout.bounds.x,
                y: layout.bounds.y,
            });
            runtime.tray_anchor = layout.tray_anchor;
        }
        self.persist();
        self.current_view()
    }

    pub fn recover_window_position(&self, window: &WebviewWindow) -> Result<bool, String> {
        let Some(bounds) = window_controller::recover_to_visible_work_areas(window)? else {
            return Ok(false);
        };
        self.persist_window_position(bounds.x, bounds.y);
        Ok(true)
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    pub fn restore_saved_position(&self, window: &WebviewWindow) {
        let position = self
            .runtime
            .lock()
            .ok()
            .and_then(|runtime| runtime.settings.window_position.clone());
        if let Some(position) = position {
            let _ = window.set_position(tauri::PhysicalPosition::new(position.x, position.y));
            let _ = window_controller::recover_to_visible_work_area(window);
        }
    }

    pub fn open_activity(&self, activity_id: &str) -> Value {
        let Ok(view) = self.current_view() else {
            return json!({ "ok": false, "reason": "missing" });
        };
        let Some(row) = find_activity(&view, activity_id) else {
            return json!({ "ok": false, "reason": "missing" });
        };
        if let Some(transition_id) = row.get("lastTransitionId").and_then(Value::as_str) {
            if let Ok(mut runtime) = self.runtime.lock() {
                runtime.settings = mark_activity_read(&runtime.settings, transition_id);
            }
            self.persist();
        }
        let deep_link = row.get("deepLink").and_then(Value::as_str).unwrap_or("");
        let origin = self
            .runtime
            .lock()
            .ok()
            .map(|runtime| runtime.connection.origin.clone())
            .unwrap_or_else(|| build_desktop_origin(62666));
        open_validated_deep_link(&origin, deep_link).to_json()
    }

    pub fn open_external_url(&self, href: &str) -> Value {
        if href.contains("://") || href.starts_with("//") {
            return reject_arbitrary_renderer_url(href).to_json();
        }
        let origin = self
            .runtime
            .lock()
            .ok()
            .map(|runtime| runtime.connection.origin.clone())
            .unwrap_or_else(|| build_desktop_origin(62666));
        open_validated_deep_link(&origin, href).to_json()
    }

    pub fn open_webui(&self) -> Result<(), String> {
        let origin = self
            .runtime
            .lock()
            .ok()
            .map(|runtime| runtime.connection.origin.clone())
            .unwrap_or_else(|| build_desktop_origin(62666));
        crate::native::open_https_or_loopback_url(&format!("{origin}/"))
    }

    pub fn custom_pets_payload(&self) -> Result<Value, String> {
        let catalog = self
            .catalog
            .lock()
            .map_err(|_| "catalog lock poisoned".to_string())?;
        renderer_catalog_payload(&catalog)
    }

    pub fn rescan_custom_pets(&self, app: &AppHandle) -> Result<Value, String> {
        let next = scan_pet_catalog(&resolve_snail_root(), &resolve_codex_root());
        let payload = renderer_catalog_payload(&next)?;
        let selection_changed = self
            .runtime
            .lock()
            .map(|mut runtime| normalize_selected_pet(&mut runtime.settings, &next))
            .unwrap_or(false);
        if let Ok(mut catalog) = self.catalog.lock() {
            *catalog = next;
        }
        if selection_changed {
            self.persist();
        }
        app.emit(CUSTOM_PETS_CHANGED_EVENT, &payload)
            .map_err(|error| error.to_string())?;
        self.emit_view(app)?;
        Ok(payload)
    }

    pub fn get_pet_asset(&self, pet_key: &str) -> Value {
        let Ok(catalog) = self.catalog.lock() else {
            return json!({ "ok": false, "reason": "read_failed" });
        };
        read_pet_asset(&catalog, pet_key)
    }

    pub fn open_custom_pets_dir(&self) -> Value {
        match crate::native::open_directory(&resolve_snail_root()) {
            Ok(()) => json!({ "ok": true }),
            Err(_) => json!({ "ok": false, "reason": "open_failed" }),
        }
    }

    pub fn list_server_profiles(&self) -> Value {
        let Ok(store) = self.profiles.lock() else {
            return json!({ "ok": false, "reason": "persist_failed" });
        };
        let payload = profiles_projection_json(&store);
        if assert_projection_safe(&payload).is_err() {
            return json!({ "ok": false, "reason": "persist_failed" });
        }
        payload
    }

    pub fn save_server_profile_command(&self, patch: Value) -> Value {
        let intent = match parse_save_intent(&patch) {
            Ok(intent) => intent,
            Err(error) => return json!({ "ok": false, "reason": error.code() }),
        };
        let previous = match self.profiles.lock() {
            Ok(store) => store.clone(),
            Err(_) => return json!({ "ok": false, "reason": "persist_failed" }),
        };
        let next = match save_server_profile(&previous, intent, self.codec.as_ref()) {
            Ok(store) => store,
            Err(error) => return json!({ "ok": false, "reason": error.code() }),
        };
        let persisted = match save_profile_store(&self.data_dir, &next, self.codec.as_ref()) {
            Ok(store) => store,
            Err(error) => return json!({ "ok": false, "reason": error.code() }),
        };
        let reconnect = should_reconnect_after_save(&previous, &persisted);
        if let Ok(mut slot) = self.profiles.lock() {
            *slot = persisted.clone();
        }
        if reconnect {
            let _ = self.reconnect_active();
        }
        let payload = profiles_projection_json(&persisted);
        if assert_projection_safe(&payload).is_err() {
            return json!({ "ok": false, "reason": "persist_failed" });
        }
        payload
    }

    pub fn delete_server_profile_command(&self, id: String) -> Value {
        let previous = match self.profiles.lock() {
            Ok(store) => store.clone(),
            Err(_) => return json!({ "ok": false, "reason": "persist_failed" }),
        };
        let next = match delete_server_profile(&previous, id.trim()) {
            Ok(store) => store,
            Err(error) => return json!({ "ok": false, "reason": error.code() }),
        };
        let persisted = match save_profile_store(&self.data_dir, &next, self.codec.as_ref()) {
            Ok(store) => store,
            Err(error) => return json!({ "ok": false, "reason": error.code() }),
        };
        if let Ok(mut slot) = self.profiles.lock() {
            *slot = persisted.clone();
        }
        let payload = profiles_projection_json(&persisted);
        if assert_projection_safe(&payload).is_err() {
            return json!({ "ok": false, "reason": "persist_failed" });
        }
        payload
    }

    pub fn switch_server_profile_command(&self, id: String) -> Value {
        let previous = match self.profiles.lock() {
            Ok(store) => store.clone(),
            Err(_) => return json!({ "ok": false, "reason": "persist_failed" }),
        };
        let next = match switch_active_profile(&previous, id.trim()) {
            Ok(store) => store,
            Err(error) => return json!({ "ok": false, "reason": error.code() }),
        };
        let persisted = match save_profile_store(&self.data_dir, &next, self.codec.as_ref()) {
            Ok(store) => store,
            Err(error) => return json!({ "ok": false, "reason": error.code() }),
        };
        if let Ok(mut slot) = self.profiles.lock() {
            *slot = persisted.clone();
        }
        if let Err(error) = self.reconnect_active() {
            return json!({ "ok": false, "reason": error.code() });
        }
        let payload = profiles_projection_json(&persisted);
        if assert_projection_safe(&payload).is_err() {
            return json!({ "ok": false, "reason": "persist_failed" });
        }
        payload
    }

    fn mutate_active_profile_key(
        &self,
        command: crate::server_profiles::AccessKeyCommand,
    ) -> Result<bool, ProfileError> {
        let mut store = self
            .profiles
            .lock()
            .map_err(|_| ProfileError::PersistFailed)?
            .clone();
        let profile = store.active_mut().ok_or(ProfileError::NotFound)?;
        match command {
            crate::server_profiles::AccessKeyCommand::Replace(key) => {
                profile.access_key = Some(key);
                profile.key_persisted = self.codec.is_available();
            }
            crate::server_profiles::AccessKeyCommand::Clear => {
                profile.access_key = None;
                profile.key_persisted = false;
            }
            crate::server_profiles::AccessKeyCommand::Preserve => {}
        }
        let persisted = save_profile_store(&self.data_dir, &store, self.codec.as_ref())?;
        let key_persisted = persisted.active().is_some_and(|profile| profile.key_persisted);
        if let Ok(mut slot) = self.profiles.lock() {
            *slot = persisted;
        }
        Ok(key_persisted)
    }

    fn reconnect_active(&self) -> Result<(), ProfileError> {
        let store = self
            .profiles
            .lock()
            .map_err(|_| ProfileError::PersistFailed)?
            .clone();
        let profile = store.active().cloned().ok_or(ProfileError::NotFound)?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let target = target_from_profile(&profile, generation);
        self.client.clear_token();
        self.quick_session.set_target(target.clone(), profile.access_key.clone());
        self.client
            .set_target(target, profile.access_key.clone(), now_ms());
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.snapshot = None;
            runtime.selected_activity_id = None;
            runtime.stale = false;
            runtime.reset = true;
            runtime.transition_runtime = TransitionRuntimeState::default();
            runtime.access_key = profile.access_key.clone();
            runtime.active_profile_id = profile.id.clone();
            runtime.active_profile_name = profile.name.clone();
            runtime.connection =
                crate::connection_state::create_initial_connection_state_for_target(
                    &target_from_profile(&profile, generation),
                    now_ms(),
                );
        }
        let _ = self.client.start(now_ms());
        Ok(())
    }

    fn generation_matches(&self, generation: u64) -> bool {
        generation == 0 || generation == self.generation.load(Ordering::SeqCst)
    }

    pub fn list_quick_session_projects(&self) -> Value {
        let payload = self.quick_session.list_projects(now_ms());
        sanitize_quick_payload(payload)
    }

    pub fn list_quick_session_models(&self, project_ref: &str) -> Value {
        let payload = self.quick_session.list_models(project_ref, now_ms());
        sanitize_quick_payload(payload)
    }

    pub fn create_quick_session(&self, input: Value) -> Value {
        let payload = self.quick_session.create_session(&input, now_ms());
        sanitize_quick_payload(payload)
    }
}

fn target_from_profile(profile: &RuntimeProfile, generation: u64) -> ConnectionTarget {
    ConnectionTarget {
        profile_id: profile.id.clone(),
        origin: profile.origin.clone(),
        port: profile.port(),
        allow_insecure_http: profile.allow_insecure_http,
        generation,
    }
}

fn should_reconnect_after_save(
    previous: &RuntimeProfileStore,
    next: &RuntimeProfileStore,
) -> bool {
    let Some(prev_active) = previous.active() else {
        return true;
    };
    let Some(next_active) = next.active() else {
        return true;
    };
    prev_active.id == next_active.id && connection_fields_changed(prev_active, next_active)
}

fn sanitize_quick_payload(payload: Value) -> Value {
    if assert_renderer_view_safe(&payload).is_err() {
        return json!({ "ok": false, "code": "result_unknown" });
    }
    payload
}

fn find_activity<'a>(view: &'a Value, activity_id: &str) -> Option<&'a Value> {
    let projects = view.get("projects")?.as_array()?;
    for project in projects {
        if let Some(activities) = project.get("activities").and_then(Value::as_array) {
            if let Some(row) = activities
                .iter()
                .find(|row| row.get("activityId").and_then(Value::as_str) == Some(activity_id))
            {
                return Some(row);
            }
        }
    }
    None
}

fn spawn_observer_loop(state: Arc<AppState>) {
    thread::Builder::new()
        .name("snail-pi-tauri-observer".to_string())
        .spawn(move || {
            let mut attempt = 0u32;
            let mut initial_probe = true;
            while !state.stopped.load(Ordering::SeqCst) {
                let probe = if initial_probe {
                    initial_probe = false;
                    state.client.start(now_ms())
                } else {
                    state.client.reattach(now_ms())
                };
                match probe {
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
    let generation = state.client.generation();
    let origin = state.client.get_state().origin;
    let url = format!("{origin}/api/desktop-observer/events");
    if !is_target_scoped_url(&url, &origin) {
        return;
    }
    let agent = LoopbackTransport::agent(Duration::from_secs(60));
    let response = match agent
        .get(&url)
        .set("Accept", "text/event-stream")
        .set(DESKTOP_OBSERVER_TOKEN_HEADER, &token)
        .call()
    {
        Ok(response) => response,
        Err(ureq::Error::Status(401 | 403, _)) => {
            if state.generation_matches(generation) {
                state.client.prepare_token_renewal();
            }
            return;
        }
        Err(error) => {
            if !state.generation_matches(generation) {
                return;
            }
            let classified = crate::observer_client::classify_fetch_failure(&error.to_string());
            if matches!(
                classified,
                crate::connection_state::DesktopConnectionEvent::ConnectionRefused
            ) {
                state.client.prepare_token_renewal();
            }
            return;
        }
    };

    let reader = BufReader::new(response.into_reader());
    let mut block = String::new();
    for line in reader.lines() {
        if state.stopped.load(Ordering::SeqCst) || !state.generation_matches(generation) {
            break;
        }
        let Ok(line) = line else {
            break;
        };
        if line.is_empty() {
            if state.generation_matches(generation) {
                state
                    .client
                    .consume_sse_text(&format!("{block}\n\n"), now_ms());
            }
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
