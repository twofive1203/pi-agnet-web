pub mod tray_controller;
pub mod window_controller;

use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, State, WebviewWindow, WindowEvent};

pub const TAURI_PREVIEW_IDENTIFIER: &str = "com.twofive.snail-pi-pet.tauri-preview";
pub const TAURI_SETTINGS_FILE_NAME: &str = "tauri-preview-settings.json";
pub const TAURI_PREVIEW_EXECUTABLE: &str = "snail-pi-pet-tauri-preview";

#[derive(Debug, Clone, Serialize)]
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
) -> Result<ShellState, String> {
    let window = pet_window(&window)?;
    let expanded = {
        let mut state = store
            .0
            .lock()
            .map_err(|_| "shell state lock poisoned".to_string())?;
        state.expanded = !state.expanded;
        state.expanded
    };
    if let Err(error) = window_controller::resize_window(&window, expanded) {
        if let Ok(mut state) = store.0.lock() {
            state.expanded = !expanded;
        }
        return Err(error);
    }
    snapshot(&window, &store)
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
fn quit_preview(window: WebviewWindow) -> Result<(), String> {
    let window = pet_window(&window)?;
    window.app_handle().exit(0);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // Register first so the Preview's independent identifier owns only its own single-instance domain.
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
            set_click_through,
            set_always_on_top,
            hide_to_tray,
            show_preview,
            quit_preview
        ])
        .setup(|app| {
            let window = app
                .get_webview_window("pet")
                .ok_or_else(|| "pet window is missing".to_string())?;
            window_controller::recover_to_visible_work_area(&window)?;
            tray_controller::build_phase_a_tray(app.handle())?;

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
                    // Display/DPI transitions can move physical bounds; pull the shell back
                    // into the current monitor work area without activating it.
                    if let Some(window) = app_handle.get_webview_window("pet") {
                        let _ = window_controller::recover_to_visible_work_area(&window);
                    }
                }
                _ => {}
            });

            window_controller::show_inactive(&window)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run isolated Tauri Preview");
}
