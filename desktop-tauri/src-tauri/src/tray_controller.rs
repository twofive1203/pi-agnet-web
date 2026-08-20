use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

use crate::{window_controller, ShellStateStore};

pub const SHOW_PREVIEW: &str = "show-preview";
pub const HIDE_PREVIEW: &str = "hide-preview";
pub const DISABLE_CLICK_THROUGH: &str = "disable-click-through";
pub const TOGGLE_ALWAYS_ON_TOP: &str = "toggle-always-on-top";
pub const QUIT_PREVIEW: &str = "quit-preview";

fn update_visibility(app: &AppHandle, visible: bool, click_through: Option<bool>) {
    if let Some(store) = app.try_state::<ShellStateStore>() {
        if let Ok(mut state) = store.0.lock() {
            state.visible = visible;
            if let Some(value) = click_through {
                state.click_through = value;
            }
        }
    }
}

fn handle_menu_action(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window("pet") else {
        return;
    };
    match id {
        SHOW_PREVIEW | DISABLE_CLICK_THROUGH => {
            if window_controller::show_user(&window).is_ok() {
                update_visibility(app, true, Some(false));
            }
        }
        HIDE_PREVIEW => {
            if window.hide().is_ok() {
                update_visibility(app, false, None);
            }
        }
        TOGGLE_ALWAYS_ON_TOP => {
            if let Some(store) = app.try_state::<ShellStateStore>() {
                if let Ok(mut state) = store.0.lock() {
                    let next = !state.always_on_top;
                    if window.set_always_on_top(next).is_ok() {
                        state.always_on_top = next;
                    }
                }
            }
        }
        QUIT_PREVIEW => app.exit(0),
        _ => {}
    }
}

pub fn build_phase_a_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW_PREVIEW, "显示 Tauri Preview", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, HIDE_PREVIEW, "隐藏到托盘", true, None::<&str>)?;
    let disable_click_through = MenuItem::with_id(
        app,
        DISABLE_CLICK_THROUGH,
        "取消鼠标穿透",
        true,
        None::<&str>,
    )?;
    let always_on_top = CheckMenuItem::with_id(
        app,
        TOGGLE_ALWAYS_ON_TOP,
        "窗口置顶",
        true,
        true,
        None::<&str>,
    )?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_PREVIEW, "退出 Tauri Preview", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &hide,
            &disable_click_through,
            &always_on_top,
            &separator,
            &quit,
        ],
    )?;
    let icon = Image::from_bytes(include_bytes!("../../../desktop/assets/tray/tray-icon.png"))?;

    TrayIconBuilder::with_id("snail-pi-pet-tauri-preview-tray")
        .icon(icon)
        .tooltip("Snail Pi Pet — Tauri Preview")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu_action(app, event.id().as_ref()))
        .build(app)?;
    Ok(())
}
