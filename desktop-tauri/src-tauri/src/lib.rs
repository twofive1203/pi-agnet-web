pub mod access_key;
pub mod activity_view;
pub mod app_state;
pub mod connection_state;
pub mod custom_pets;
pub mod deep_links;
pub mod native;
pub mod notifications;
pub mod observer_client;
pub mod quick_session_client;
pub mod settings;
pub mod tray_controller;
pub mod window_controller;

use std::sync::Mutex;
use std::thread;
use std::time::Duration;

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
    app: State<'_, std::sync::Arc<AppState>>,
    dx: f64,
    dy: f64,
) -> Result<ShellState, String> {
    let window = pet_window(&window)?;
    let bounds = window_controller::move_window_by(&window, dx, dy)?;
    app.persist_window_position(bounds.x, bounds.y);
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
    let _ = app.emit_view(window.app_handle());
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
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<ShellState, String> {
    let window = pet_window(&window)?;
    if let Ok(bounds) = window_controller::current_bounds(&window) {
        app.persist_window_position(bounds.x, bounds.y);
    }
    window_controller::hide_to_tray(&window)?;
    app.set_app_in_background(true);
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
fn quit_preview(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<(), String> {
    let window = pet_window(&window)?;
    app.quit_network();
    window.app_handle().exit(0);
    Ok(())
}

#[tauri::command]
fn get_state(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<Value, String> {
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
    let _ = app.emit_view(window.app_handle());
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
    let _ = app.emit_view(window.app_handle());
    Ok(view)
}

#[tauri::command]
fn mark_all_read(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<Value, String> {
    pet_window(&window)?;
    let view = app.mark_all_read()?;
    let _ = app.emit_view(window.app_handle());
    Ok(view)
}

#[tauri::command]
fn open_activity(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    activity_id: String,
) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(app.open_activity(&activity_id))
}

#[tauri::command]
fn open_external_url(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    href: String,
) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(app.open_external_url(&href))
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
    let copied = crate::native::copy_start_command();
    Ok(json!({
        "ok": copied,
        "copied": copied,
        "command": crate::connection_state::DESKTOP_START_COMMAND
    }))
}

#[tauri::command]
fn set_prefs(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    patch: Value,
) -> Result<Value, String> {
    let window = pet_window(&window)?;
    let view = app.apply_prefs(patch, &window)?;
    app.emit_view(window.app_handle())?;
    Ok(view)
}

#[tauri::command]
fn restore_default_position(
    window: WebviewWindow,
    store: State<'_, ShellStateStore>,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<(), String> {
    let window = pet_window(&window)?;
    let _ = app.restore_default_window(&window)?;
    if let Ok(mut shell) = store.0.lock() {
        shell.expanded = false;
        shell.bounds = window_controller::current_bounds(&window).ok();
    }
    app.emit_view(window.app_handle())?;
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
    let _ = app.emit_view(window.app_handle());
    Ok(())
}

#[tauri::command]
fn set_access_key(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    access_key: String,
) -> Result<Value, String> {
    pet_window(&window)?;
    let result = app.set_access_key(Some(access_key));
    let _ = app.emit_view(window.app_handle());
    Ok(result)
}

#[tauri::command]
fn clear_access_key(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<Value, String> {
    pet_window(&window)?;
    let result = app.set_access_key(None);
    let _ = app.emit_view(window.app_handle());
    Ok(result)
}

#[tauri::command]
fn get_custom_pets(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<Value, String> {
    pet_window(&window)?;
    app.custom_pets_payload()
}

#[tauri::command]
fn open_custom_pets_dir(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(app.open_custom_pets_dir())
}

#[tauri::command]
fn rescan_custom_pets(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<(), String> {
    pet_window(&window)?;
    let _ = app.rescan_custom_pets(window.app_handle())?;
    Ok(())
}

#[tauri::command]
fn get_pet_asset(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    pet_key: String,
) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(app.get_pet_asset(&pet_key))
}

#[tauri::command]
fn list_quick_session_projects(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(app.list_quick_session_projects())
}

#[tauri::command]
fn list_quick_session_models(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    project_ref: String,
) -> Result<Value, String> {
    pet_window(&window)?;
    Ok(app.list_quick_session_models(&project_ref))
}

#[tauri::command]
fn create_quick_session(
    window: WebviewWindow,
    app: State<'_, std::sync::Arc<AppState>>,
    project_ref: String,
    message: String,
    request_id: String,
    provider: Option<String>,
    model_id: Option<String>,
) -> Result<Value, String> {
    pet_window(&window)?;
    let mut input = json!({
        "projectRef": project_ref,
        "message": message,
        "requestId": request_id,
    });
    if let (Some(provider), Some(model_id)) = (provider, model_id) {
        input["provider"] = json!(provider);
        input["modelId"] = json!(model_id);
    }
    Ok(app.create_quick_session(input))
}

fn spawn_monitor_watcher(window: WebviewWindow, state: std::sync::Arc<AppState>) {
    thread::Builder::new()
        .name("snail-pi-tauri-monitors".to_string())
        .spawn(move || {
            let mut previous = window_controller::monitor_topology_signature(&window).ok();
            while !state.is_stopped() {
                thread::sleep(Duration::from_secs(2));
                if state.is_stopped() {
                    break;
                }
                let Ok(current) = window_controller::monitor_topology_signature(&window) else {
                    continue;
                };
                if previous.as_ref() != Some(&current) {
                    let _ = state.recover_window_position(&window);
                    previous = Some(current);
                }
            }
        })
        .expect("monitor watcher thread");
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
            let state = AppState::start(app.handle().clone())?;
            app.manage(state.clone());
            state.restore_saved_position(&window);
            let initial_layout = state.runtime.lock().ok().map(|runtime| {
                (
                    runtime.settings.pet_scale.clone(),
                    runtime.settings.activity_tray_open,
                )
            });
            if let Some((pet_scale, expanded)) = initial_layout {
                let layout =
                    window_controller::initialize_window_layout(&window, &pet_scale, expanded)?;
                if let Ok(mut runtime) = state.runtime.lock() {
                    runtime.tray_anchor = layout.tray_anchor;
                    runtime.settings.window_position = Some(crate::activity_view::WindowPosition {
                        x: layout.bounds.x,
                        y: layout.bounds.y,
                    });
                }
            }
            if let Ok(runtime) = state.runtime.lock() {
                let _ = window.set_always_on_top(runtime.settings.always_on_top);
                let _ =
                    window_controller::set_click_through(&window, runtime.settings.click_through);
                let _ = crate::native::apply_launch_at_login(runtime.settings.launch_at_login);
                if let Some(store) = app.try_state::<ShellStateStore>() {
                    if let Ok(mut shell) = store.0.lock() {
                        shell.always_on_top = runtime.settings.always_on_top;
                        shell.click_through = runtime.settings.click_through;
                        shell.expanded = runtime.settings.activity_tray_open;
                    }
                }
            }
            tray_controller::build_phase_a_tray(app.handle())?;
            state.spawn();

            let app_handle = app.handle().clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if let Some(window) = app_handle.get_webview_window("pet") {
                        let _ = window_controller::hide_to_tray(&window);
                    }
                    if let Some(state) = app_handle.try_state::<std::sync::Arc<AppState>>() {
                        state.set_app_in_background(true);
                    }
                    if let Some(store) = app_handle.try_state::<ShellStateStore>() {
                        if let Ok(mut state) = store.0.lock() {
                            state.visible = false;
                        }
                    }
                }
                WindowEvent::Focused(focused) => {
                    if let Some(state) = app_handle.try_state::<std::sync::Arc<AppState>>() {
                        state.set_app_in_background(!focused);
                    }
                }
                WindowEvent::ScaleFactorChanged { .. } => {
                    if let (Some(window), Some(state)) = (
                        app_handle.get_webview_window("pet"),
                        app_handle.try_state::<std::sync::Arc<AppState>>(),
                    ) {
                        let _ = state.recover_window_position(&window);
                    }
                }
                _ => {}
            });

            spawn_monitor_watcher(window.clone(), state.clone());
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
