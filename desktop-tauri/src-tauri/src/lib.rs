pub mod activity_view;
pub mod app_state;
pub mod connection_state;
pub mod observer_client;
pub mod tray_controller;
pub mod window_controller;

use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{Manager, State, WebviewWindow, WindowEvent};

use crate::app_state::AppState;

pub const TAURI_PREVIEW_IDENTIFIER: &str = "com.twofive.snail-pi-pet.tauri-preview";
pub const TAURI_SETTINGS_FILE_NAME: &str = "tauri-preview-settings.json";
pub const TAURI_PREVIEW_EXECUTABLE: &str = "snail-pi-pet-tauri-preview";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellState {
    pub visible: bool,
    pub click_through: bool,
    pub always_on_top: bool,
    pub expanded: bool,
    pub bounds: Option<window_controller::WindowBounds>,
    pub monitor_count: usize,
    pub scale_factor: f64,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            visible: true,
            click_through: false,
            always_on_top: true,
            expanded: false,
            bounds: None,
            monitor_count: 0,
            scale_factor: 1.0,
        }
    }
}

pub struct ShellStateStore(pub Mutex<ShellState>);

fn pet_window(window: &WebviewWindow) -> Result<WebviewWindow, String> {
    if window.label() != "pet" {
        return Err("command is restricted to the pet window".to_string());
    }
    Ok(window.clone())
}

fn snapshot(
    window: &WebviewWindow,
    store: &State<'_, ShellStateStore>,
) -> Result<ShellState, String> {
    let mut state = store
        .0
        .lock()
        .map_err(|_| "shell state lock poisoned".to_string())?;
    state.visible = window.is_visible().map_err(|error| error.to_string())?;
    state.always_on_top = window
        .is_always_on_top()
        .map_err(|error| error.to_string())?;
    state.bounds = window_controller::current_bounds(window).ok();
    state.monitor_count = window_controller::monitor_count(window);
    state.scale_factor = window_controller::current_scale_factor(window);
    Ok(state.clone())
}

#[tauri::command]
fn get_shell_state(
    window: WebviewWindow,
    store: State<'_, ShellStateStore>,
) -> Result<ShellState, String> {
    let window = pet_window(&window)?;
    snapshot(&window, &store)
}

#[tauri::command]
fn move_by(
    window: WebviewWindow,
    store: State<'_, ShellStateStore>,
    dx: f64,
    dy: f64,
) -> Result<ShellState, String> {
    let window = pet_window(&window)?;
    window_controller::move_window_by(&window, dx, dy)?;
    snapshot(&window, &store)
}

#[tauri::command]
fn toggle_expanded(
    window: WebviewWindow,
    store: State<'_, ShellStateStore>,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<Value, String> {
    let window = pet_window(&window)?;
    let view = app.toggle_tray(&window)?;
    if let Ok(mut state) = store.0.lock() {
        state.expanded = view
            .get("trayOpen")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    }
    let _ = app.emit_view(&window.app_handle());
    Ok(view)
}

#[tauri::command]
fn set_click_through(
    window: WebviewWindow,
    store: State<'_, ShellStateStore>,
    click_through: bool,
) -> Result<ShellState, String> {
    let window = pet_window(&window)?;
    window_controller::set_click_through(&window, click_through)?;
    store
        .0
        .lock()
        .map_err(|_| "shell state lock poisoned".to_string())?
        .click_through = click_through;
    snapshot(&window, &store)
}

#[tauri::command]
fn set_always_on_top(
    window: WebviewWindow,
    store: State<'_, ShellStateStore>,
    always_on_top: bool,
) -> Result<ShellState, String> {
    let window = pet_window(&window)?;
    window
        .set_always_on_top(always_on_top)
        .map_err(|error| error.to_string())?;
    store
        .0
        .lock()
        .map_err(|_| "shell state lock poisoned".to_string())?
        .always_on_top = always_on_top;
    snapshot(&window, &store)
}

#[tauri::command]
fn hide_to_tray(
    window: WebviewWindow,
    store: State<'_, ShellStateStore>,
) -> Result<ShellState, String> {
    let window = pet_window(&window)?;
    window.hide().map_err(|error| error.to_string())?;
    store
        .0
        .lock()
        .map_err(|_| "shell state lock poisoned".to_string())?
        .visible = false;
    snapshot(&window, &store)
}

#[tauri::command]
fn show_preview(
    window: WebviewWindow,
    store: State<'_, ShellStateStore>,
) -> Result<ShellState, String> {
    let window = pet_window(&window)?;
    window_controller::show_user(&window)?;
    {
        let mut state = store
            .0
            .lock()
            .map_err(|_| "shell state lock poisoned".to_string())?;
        state.visible = true;
        state.click_through = false;
    }
    snapshot(&window, &store)
}

#[tauri::command]
fn quit_preview(window: WebviewWindow, app: State<'_, std::sync::Arc<AppState>>) -> Result<(), String> {
    let window = pet_window(&window)?;
    app.quit_network();
    window.app_handle().exit(0);
    Ok(())
}

#[tauri::command]
fn get_state(window: WebviewWindow, app: State<'_, std::sync::Arc<AppState>>) -> Result<Value, String> {
    pet_window(&window)?;
    app.current_view()
}

#[tauri::command]
fn toggle_tray(
    window: WebviewWindow,
    store: State<'_, ShellStateStore>,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<Value, String> {
    toggle_expanded(window, store, app)
}

#[tauri::command]
fn select_activity(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    activity_id: String,
) -> Result<Value, String> {
    pet_window(&window)?;
    let view = app.select_activity(activity_id)?;
    let _ = app.emit_view(&window.app_handle());
    Ok(view)
}

#[tauri::command]
fn mark_read(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    activity_id: String,
) -> Result<Value, String> {
    pet_window(&window)?;
    let view = app.mark_read(&activity_id)?;
    let _ = app.emit_view(&window.app_handle());
    Ok(view)
}

#[tauri::command]
fn mark_all_read(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<Value, String> {
    pet_window(&window)?;
    let view = app.mark_all_read()?;
    let _ = app.emit_view(&window.app_handle());
    Ok(view)
}

#[tauri::command]
fn open_activity(window: WebviewWindow, _activity_id: String) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(json!({ "ok": false, "reason": "phase_c" }))
}

#[tauri::command]
fn open_external_url(window: WebviewWindow, href: String) -> Result<Value, String> {
    pet_window(&window)?;
    if href.starts_with("http://") || href.starts_with("https://") {
        return Ok(json!({ "ok": false, "reason": "absolute_url_rejected" }));
    }
    Ok(json!({ "ok": false, "reason": "phase_c" }))
}

#[tauri::command]
fn retry(window: WebviewWindow, app: State<'_, std::sync::Arc<AppState>>) -> Result<(), String> {
    pet_window(&window)?;
    app.retry();
    Ok(())
}

#[tauri::command]
fn copy_start_command(window: WebviewWindow) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(json!({ "ok": true, "copied": false, "text": crate::connection_state::DESKTOP_START_COMMAND }))
}

#[tauri::command]
fn set_prefs(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    patch: Value,
) -> Result<Value, String> {
    let window = pet_window(&window)?;
    let view = app.apply_prefs(patch, &window)?;
    app.emit_view(&window.app_handle())?;
    Ok(view)
}

#[tauri::command]
fn restore_default_position(window: WebviewWindow) -> Result<(), String> {
    let window = pet_window(&window)?;
    window_controller::recover_to_visible_work_area(&window)?;
    let _ = window_controller::resize_window(&window, false);
    Ok(())
}

#[tauri::command]
fn set_reduced_motion(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    value: bool,
) -> Result<(), String> {
    pet_window(&window)?;
    if let Ok(mut runtime) = app.runtime.lock() {
        runtime.reduced_motion = value;
    }
    let _ = app.emit_view(&window.app_handle());
    Ok(())
}

#[tauri::command]
fn set_access_key(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    access_key: String,
) -> Result<Value, String> {
    pet_window(&window)?;
    app.set_access_key(Some(access_key));
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn clear_access_key(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<Value, String> {
    pet_window(&window)?;
    app.set_access_key(None);
    Ok(json!({ "ok": true }))
}

#[tauri::command]
fn get_custom_pets(window: WebviewWindow) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(json!({ "pets": [], "diagnostics": [] }))
}

#[tauri::command]
fn open_custom_pets_dir(window: WebviewWindow) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(json!({ "ok": false, "reason": "phase_c" }))
}

#[tauri::command]
fn rescan_custom_pets(window: WebviewWindow) -> Result<(), String> {
    pet_window(&window)?;
    Ok(())
}

#[tauri::command]
fn get_pet_asset(window: WebviewWindow, _pet_key: String) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(json!({ "ok": false, "reason": "phase_c" }))
}

#[tauri::command]
fn list_quick_session_projects(window: WebviewWindow) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(json!({ "available": false, "projects": [] }))
}

#[tauri::command]
fn list_quick_session_models(window: WebviewWindow, _project_ref: String) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(json!({ "available": false, "models": [] }))
}

#[tauri::command]
fn create_quick_session(window: WebviewWindow) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(json!({ "ok": false, "code": "unavailable" }))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("pet") {
                if window_controller::show_user(&window).is_ok() {
                    if let Some(store) = app.try_state::<ShellStateStore>() {
                        if let Ok(mut state) = store.0.lock() {
                            state.visible = true;
                            state.click_through = false;
                        }
                    }
                }
            }
        }))
        .manage(ShellStateStore(Mutex::new(ShellState::default())))
        .invoke_handler(tauri::generate_handler![
            get_shell_state,
            move_by,
            toggle_expanded,
            toggle_tray,
            set_click_through,
            set_always_on_top,
            hide_to_tray,
            show_preview,
            quit_preview,
            get_state,
            select_activity,
            mark_read,
            mark_all_read,
            open_activity,
            open_external_url,
            retry,
            copy_start_command,
            set_prefs,
            restore_default_position,
            set_reduced_motion,
            set_access_key,
            clear_access_key,
            get_custom_pets,
            open_custom_pets_dir,
            rescan_custom_pets,
            get_pet_asset,
            list_quick_session_projects,
            list_quick_session_models,
            create_quick_session
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("pet")
                .ok_or_else(|| "pet window is missing".to_string())?;
            window_controller::recover_to_visible_work_area(&window)?;
            tray_controller::build_phase_a_tray(app.handle())?;

            let state = AppState::start(app.handle().clone())?;
            app.manage(state.clone());
            state.spawn();

            let app_handle = app.handle().clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if let Some(window) = app_handle.get_webview_window("pet") {
                        let _ = window.hide();
                    }
                    if let Some(store) = app_handle.try_state::<ShellStateStore>() {
                        if let Ok(mut state) = store.0.lock() {
                            state.visible = false;
                        }
                    }
                }
                WindowEvent::ScaleFactorChanged { .. } => {
                    if let Some(window) = app_handle.get_webview_window("pet") {
                        let _ = window_controller::recover_to_visible_work_area(&window);
                    }
                }
                _ => {}
            });

            window_controller::show_inactive(&window)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build isolated Tauri Preview")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<std::sync::Arc<AppState>>() {
                    state.quit_network();
                }
            }
        });
}
