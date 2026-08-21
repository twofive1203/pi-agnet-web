use std::path::{Path, PathBuf};

use crate::connection_state::DESKTOP_START_COMMAND;
use crate::TAURI_PREVIEW_IDENTIFIER;

pub const TAURI_AUTOSTART_VALUE_NAME: &str = "SnailPiPetTauriPreview";
const ELECTRON_AUTOSTART_HINTS: [&str; 3] = ["SnailPiPet", "snail-pi-pet", "com.twofive.snail-pi-pet"];

pub fn copy_start_command() -> bool {
    write_clipboard(DESKTOP_START_COMMAND)
}

pub fn open_https_or_loopback_url(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    let scheme = if trimmed.starts_with("https://") {
        "https"
    } else if trimmed.starts_with("http://") {
        "http"
    } else {
        return Err("url_protocol".to_string());
    };
    let rest = trimmed.split_once("://").map(|(_, rest)| rest).unwrap_or("");
    let host = rest.split('/').next().unwrap_or(rest);
    open_configured_origin_url(&format!("{scheme}://{host}"), trimmed)
}

pub fn open_configured_origin_url(origin: &str, url: &str) -> Result<(), String> {
    let origin = origin.trim().trim_end_matches('/');
    let url = url.trim();
    if !(origin.starts_with("http://") || origin.starts_with("https://")) {
        return Err("url_protocol".to_string());
    }
    if origin.contains('@') || url.contains(['\r', '\n', '"']) {
        return Err("url_invalid".to_string());
    }
    if !crate::server_profiles::is_origin_scoped_url(url, origin) {
        return Err("url_origin_mismatch".to_string());
    }
    shell_open(url)
}

pub fn open_directory(path: &Path) -> Result<(), String> {
    if !path.exists() {
        std::fs::create_dir_all(path).map_err(|error| error.to_string())?;
    }
    let display = path.to_string_lossy();
    if display.contains(['\r', '\n', '"']) {
        return Err("path_invalid".to_string());
    }
    shell_open(&display)
}

pub fn apply_launch_at_login(enabled: bool) -> bool {
    match set_launch_at_login(enabled) {
        Ok(actual) => actual == enabled,
        Err(_) => false,
    }
}

pub fn show_notification<F>(title: &str, body: &str, on_click: F) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    show_notification_impl(title, body, on_click)
}

#[cfg(windows)]
fn write_clipboard(text: &str) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    const CF_UNICODETEXT: u32 = 13;

    let mut wide: Vec<u16> = std::ffi::OsStr::new(text).encode_wide().collect();
    wide.push(0);
    let bytes = wide.len() * 2;
    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let _ = EmptyClipboard();
        let Ok(handle) = GlobalAlloc(GMEM_MOVEABLE, bytes) else {
            let _ = CloseClipboard();
            return false;
        };
        let locked = GlobalLock(handle);
        if locked.is_null() {
            let _ = CloseClipboard();
            return false;
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), locked as *mut u16, wide.len());
        let _ = GlobalUnlock(handle);
        let result = SetClipboardData(CF_UNICODETEXT, Some(HANDLE(handle.0)));
        let _ = CloseClipboard();
        result.is_ok()
    }
}

#[cfg(not(windows))]
fn write_clipboard(_text: &str) -> bool {
    false
}

#[cfg(windows)]
fn shell_open(target: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let mut wide: Vec<u16> = std::ffi::OsStr::new(target).encode_wide().collect();
    wide.push(0);
    let mut verb: Vec<u16> = std::ffi::OsStr::new("open").encode_wide().collect();
    verb.push(0);
    let result = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err("open_failed".to_string())
    }
}

#[cfg(not(windows))]
fn shell_open(_target: &str) -> Result<(), String> {
    Err("open_unsupported".to_string())
}

#[cfg(windows)]
fn set_launch_at_login(enabled: bool) -> Result<bool, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegSetValueExW, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    let exe = current_exe()?;
    let quoted = format!("\"{}\"", exe.display());
    if ELECTRON_AUTOSTART_HINTS
        .iter()
        .any(|hint| quoted.to_ascii_lowercase().contains(&hint.to_ascii_lowercase()) && !quoted.contains("tauri-preview"))
    {
        return Err("refusing to write electron autostart".to_string());
    }
    let mut name: Vec<u16> = std::ffi::OsStr::new(TAURI_AUTOSTART_VALUE_NAME)
        .encode_wide()
        .collect();
    name.push(0);
    let mut subkey: Vec<u16> = std::ffi::OsStr::new(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .encode_wide()
        .collect();
    subkey.push(0);
    let mut hkey = windows::Win32::System::Registry::HKEY::default();
    unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            None,
            None,
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        )
        .ok()
        .map_err(|error| error.message())?;
        let result = if enabled {
            let mut value: Vec<u16> = std::ffi::OsStr::new(&quoted).encode_wide().collect();
            value.push(0);
            let bytes = value.len() * 2;
            RegSetValueExW(
                hkey,
                PCWSTR(name.as_ptr()),
                None,
                REG_SZ,
                Some(std::slice::from_raw_parts(value.as_ptr() as *const u8, bytes)),
            )
            .ok()
            .map(|_| true)
            .map_err(|error| error.message())
        } else {
            let _ = RegDeleteValueW(hkey, PCWSTR(name.as_ptr()));
            Ok(false)
        };
        let _ = RegCloseKey(hkey);
        result
    }
}

#[cfg(not(windows))]
fn set_launch_at_login(_enabled: bool) -> Result<bool, String> {
    Ok(false)
}

fn current_exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|error| error.to_string())
}

#[cfg(windows)]
fn show_notification_impl<F>(title: &str, body: &str, on_click: F) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    use tauri_winrt_notification::Toast;
    Toast::new(TAURI_PREVIEW_IDENTIFIER)
        .title(title)
        .text1(body)
        .on_activated(move |_| {
            on_click();
            Ok(())
        })
        .show()
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn show_notification_impl<F>(_title: &str, _body: &str, _on_click: F) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    let _ = TAURI_PREVIEW_IDENTIFIER;
    Ok(())
}

pub fn autostart_value_name() -> &'static str {
    TAURI_AUTOSTART_VALUE_NAME
}

pub fn current_exe_display() -> String {
    current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_default()
}
