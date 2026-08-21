use serde_json::Value;
use tauri::{
    image::Image,
    menu::{CheckMenuItem, IconMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent, TrayIconId},
    AppHandle, Manager,
};

use crate::window_controller;
use crate::{app_state::AppState, ShellStateStore};

pub const SHOW_PREVIEW: &str = "show-preview";
pub const DISABLE_CLICK_THROUGH: &str = "disable-click-through";
pub const TOGGLE_DND: &str = "toggle-dnd";
pub const TOGGLE_SOUND: &str = "toggle-sound";
pub const RETRY: &str = "retry";
pub const OPEN_WEBUI: &str = "open-webui";
pub const COPY_START_COMMAND: &str = "copy-start-command";
pub const QUIT_PREVIEW: &str = "quit-preview";
const TRAY_ID: &str = "snail-pi-pet-tauri-preview-tray";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrayMenuItem {
    pub id: &'static str,
    pub label: String,
    pub enabled: bool,
    pub checked: Option<bool>,
    pub separator: bool,
}

pub fn build_tray_menu_model(input: TrayModelInput<'_>) -> Vec<TrayMenuItem> {
    let status_label = match input.connection_status {
        "service-not-running" | "service_not_running" => "蜗牛派桌宠 · 服务未启动".to_string(),
        "incompatible" => "蜗牛派桌宠 · 服务不兼容".to_string(),
        "reconnecting" => "蜗牛派桌宠 · 重连中".to_string(),
        "probing" => "蜗牛派桌宠 · 探测中".to_string(),
        _ => format!("蜗牛派桌宠 · {}", presentation_label(input.presentation)),
    };
    let mut items = vec![
        item("status", status_label, false, None),
        separator(),
        item(SHOW_PREVIEW, "显示桌宠", true, None),
        item(
            DISABLE_CLICK_THROUGH,
            "取消鼠标穿透",
            input.click_through,
            None,
        ),
        item(TOGGLE_DND, "勿扰模式", true, Some(input.dnd_enabled)),
        item(
            TOGGLE_SOUND,
            "声音提示",
            true,
            Some(input.sound_master_enabled),
        ),
        separator(),
        item(RETRY, "重试连接", true, None),
        item(OPEN_WEBUI, "打开 WebUI", true, None),
    ];
    if input.can_copy_start_command {
        items.push(item(COPY_START_COMMAND, "复制启动命令", true, None));
    }
    items.push(separator());
    items.push(item(QUIT_PREVIEW, "退出桌宠", true, None));
    items
}

pub struct TrayModelInput<'a> {
    pub presentation: &'a str,
    pub connection_status: &'a str,
    pub click_through: bool,
    pub dnd_enabled: bool,
    pub sound_master_enabled: bool,
    pub can_copy_start_command: bool,
}

pub fn tray_model_from_view(view: &Value, click_through: bool) -> Vec<TrayMenuItem> {
    build_tray_menu_model(TrayModelInput {
        presentation: view
            .get("presentation")
            .and_then(Value::as_str)
            .unwrap_or("idle"),
        connection_status: view
            .get("connectionStatus")
            .and_then(Value::as_str)
            .unwrap_or("probing"),
        click_through,
        dnd_enabled: view
            .get("dndEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        sound_master_enabled: view
            .get("sound")
            .and_then(|sound| sound.get("masterEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        can_copy_start_command: view
            .get("canCopyStartCommand")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

pub fn build_phase_a_tray(app: &AppHandle) -> tauri::Result<()> {
    refresh_tray(app)
}

pub fn refresh_tray(app: &AppHandle) -> tauri::Result<()> {
    let click_through = app
        .try_state::<ShellStateStore>()
        .and_then(|store| store.0.lock().ok().map(|state| state.click_through))
        .unwrap_or(false);
    let view = app
        .try_state::<std::sync::Arc<AppState>>()
        .and_then(|state| state.current_view().ok())
        .unwrap_or(serde_json::json!({}));
    let model = tray_model_from_view(&view, click_through);
    let icon = Image::from_bytes(include_bytes!("../../../desktop/assets/tray/tray-icon.png"))?;
    let mut owned = Vec::new();
    for item in &model {
        if item.separator {
            owned.push(TrayOwned::Separator(PredefinedMenuItem::separator(app)?));
            continue;
        }
        if item.id == SHOW_PREVIEW {
            owned.push(TrayOwned::Icon(IconMenuItem::with_id(
                app,
                item.id,
                &item.label,
                item.enabled,
                Some(icon.clone()),
                None::<&str>,
            )?));
        } else if let Some(checked) = item.checked {
            owned.push(TrayOwned::Check(CheckMenuItem::with_id(
                app,
                item.id,
                &item.label,
                item.enabled,
                checked,
                None::<&str>,
            )?));
        } else {
            owned.push(TrayOwned::Normal(MenuItem::with_id(
                app,
                item.id,
                &item.label,
                item.enabled,
                None::<&str>,
            )?));
        }
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = owned
        .iter()
        .map(|item| match item {
            TrayOwned::Normal(item) => item as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
            TrayOwned::Icon(item) => item as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
            TrayOwned::Check(item) => item as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
            TrayOwned::Separator(item) => item as &dyn tauri::menu::IsMenuItem<tauri::Wry>,
        })
        .collect();
    let menu = Menu::with_items(app, &refs)?;
    let default_position = model
        .iter()
        .position(|item| item.id == SHOW_PREVIEW)
        .unwrap_or_default() as u32;
    polish_native_menu(&menu, default_position);
    let tooltip = build_tooltip(&view);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_menu(Some(menu));
        let _ = tray.set_tooltip(Some(tooltip));
        return Ok(());
    }
    TrayIconBuilder::with_id(TrayIconId::new(TRAY_ID))
        .icon(icon)
        .tooltip(&tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu_action(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                reveal_from_tray(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

enum TrayOwned {
    Normal(MenuItem<tauri::Wry>),
    Icon(IconMenuItem<tauri::Wry>),
    Check(CheckMenuItem<tauri::Wry>),
    Separator(PredefinedMenuItem<tauri::Wry>),
}

#[cfg(windows)]
fn polish_native_menu(menu: &Menu<tauri::Wry>, default_position: u32) {
    use std::{ffi::c_void, mem::size_of};
    use tauri::menu::ContextMenu;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetMenuInfo, SetMenuDefaultItem, SetMenuInfo, HMENU, MENUINFO, MIM_STYLE, MNS_CHECKORBMP,
    };

    let Ok(raw_menu) = menu.hpopupmenu() else {
        return;
    };
    let menu_handle = HMENU(raw_menu as *mut c_void);
    let mut menu_info = MENUINFO {
        cbSize: size_of::<MENUINFO>() as u32,
        fMask: MIM_STYLE,
        ..Default::default()
    };
    unsafe {
        // Keep checkbox state and the branded action icon in one compact rail.
        if GetMenuInfo(menu_handle, &mut menu_info).is_ok() {
            menu_info.dwStyle |= MNS_CHECKORBMP;
            let _ = SetMenuInfo(menu_handle, &menu_info);
        }
        // Left click performs the same action, so emphasize it as the menu default.
        let _ = SetMenuDefaultItem(menu_handle, default_position, 1);
    }
}

#[cfg(not(windows))]
fn polish_native_menu(_menu: &Menu<tauri::Wry>, _default_position: u32) {}

fn reveal_from_tray(app: &AppHandle) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };
    if window_controller::show_user(&window).is_err() {
        return;
    }
    if let Some(store) = app.try_state::<ShellStateStore>() {
        if let Ok(mut state) = store.0.lock() {
            state.visible = true;
            state.click_through = false;
        }
    }
    if let Some(app_state) = app.try_state::<std::sync::Arc<AppState>>() {
        if app_state.set_click_through_pref(false, &window).is_ok() {
            app_state.set_app_in_background(false);
            let _ = app_state.emit_view(app);
        }
    }
}

fn handle_menu_action(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };
    match id {
        SHOW_PREVIEW | DISABLE_CLICK_THROUGH => reveal_from_tray(app),
        TOGGLE_DND => {
            if let Some(app_state) = app.try_state::<std::sync::Arc<AppState>>() {
                if app_state.toggle_dnd(&window).is_ok() {
                    let _ = app_state.emit_view(app);
                }
            }
        }
        TOGGLE_SOUND => {
            if let Some(app_state) = app.try_state::<std::sync::Arc<AppState>>() {
                if app_state.toggle_sound(&window).is_ok() {
                    let _ = app_state.emit_view(app);
                }
            }
        }
        RETRY => {
            if let Some(app_state) = app.try_state::<std::sync::Arc<AppState>>() {
                app_state.retry();
            }
        }
        OPEN_WEBUI => {
            if let Some(app_state) = app.try_state::<std::sync::Arc<AppState>>() {
                let _ = app_state.open_webui();
            }
        }
        COPY_START_COMMAND => {
            let _ = crate::native::copy_start_command();
        }
        QUIT_PREVIEW => {
            if let Some(app_state) = app.try_state::<std::sync::Arc<AppState>>() {
                app_state.quit_network();
            }
            app.exit(0);
        }
        _ => {}
    }
}

fn item(
    id: &'static str,
    label: impl Into<String>,
    enabled: bool,
    checked: Option<bool>,
) -> TrayMenuItem {
    TrayMenuItem {
        id,
        label: label.into(),
        enabled,
        checked,
        separator: false,
    }
}

fn separator() -> TrayMenuItem {
    TrayMenuItem {
        id: "separator",
        label: String::new(),
        enabled: false,
        checked: None,
        separator: true,
    }
}

fn presentation_label(presentation: &str) -> &'static str {
    match presentation {
        "needs_input" => "需要输入",
        "blocked" => "受阻",
        "ready" => "已完成",
        "retrying" => "重试中",
        "running" => "运行中",
        "service_not_running" => "服务未启动",
        "disconnected" => "未连接",
        _ => "空闲",
    }
}

fn build_tooltip(view: &Value) -> String {
    let presentation = view
        .get("presentation")
        .and_then(Value::as_str)
        .unwrap_or("idle");
    let mut parts = vec![format!("蜗牛派桌宠 · {}", presentation_label(presentation))];
    if let Some(active) = view.get("activeCount").and_then(Value::as_u64) {
        if active > 0 {
            parts.push(format!("活动 {active}"));
        }
    }
    if let Some(attention) = view.get("attentionCount").and_then(Value::as_u64) {
        if attention > 0 {
            parts.push(format!("需关注 {attention}"));
        }
    }
    parts.join(" · ")
}
