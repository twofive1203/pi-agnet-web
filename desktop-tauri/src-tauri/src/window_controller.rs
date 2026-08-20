use serde::Serialize;
use tauri::{LogicalSize, PhysicalPosition, WebviewWindow};

pub const COLLAPSED_WIDTH: u32 = 180;
pub const COLLAPSED_HEIGHT: u32 = 220;
pub const EXPANDED_WIDTH: u32 = 360;
pub const EXPANDED_HEIGHT: u32 = 480;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CornerAnchor {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

pub fn clamp_bounds(bounds: WindowBounds, work_area: WorkArea) -> WindowBounds {
    let min_x = work_area.x;
    let min_y = work_area.y;
    let max_x = work_area
        .x
        .saturating_add(work_area.width as i32)
        .saturating_sub(bounds.width as i32)
        .max(min_x);
    let max_y = work_area
        .y
        .saturating_add(work_area.height as i32)
        .saturating_sub(bounds.height as i32)
        .max(min_y);
    WindowBounds {
        x: bounds.x.clamp(min_x, max_x),
        y: bounds.y.clamp(min_y, max_y),
        ..bounds
    }
}

pub fn nearest_corner_anchor(bounds: WindowBounds, work_area: WorkArea) -> CornerAnchor {
    let left = (bounds.x - work_area.x).unsigned_abs();
    let top = (bounds.y - work_area.y).unsigned_abs();
    let right_edge = work_area.x.saturating_add(work_area.width as i32);
    let bottom_edge = work_area.y.saturating_add(work_area.height as i32);
    let right = (right_edge - bounds.x.saturating_add(bounds.width as i32)).unsigned_abs();
    let bottom = (bottom_edge - bounds.y.saturating_add(bounds.height as i32)).unsigned_abs();
    match (right < left, bottom < top) {
        (false, false) => CornerAnchor::TopLeft,
        (true, false) => CornerAnchor::TopRight,
        (false, true) => CornerAnchor::BottomLeft,
        (true, true) => CornerAnchor::BottomRight,
    }
}

pub fn resize_from_anchor(
    bounds: WindowBounds,
    width: u32,
    height: u32,
    work_area: WorkArea,
) -> WindowBounds {
    let anchor = nearest_corner_anchor(bounds, work_area);
    let right = bounds.x.saturating_add(bounds.width as i32);
    let bottom = bounds.y.saturating_add(bounds.height as i32);
    let resized = WindowBounds {
        x: match anchor {
            CornerAnchor::TopLeft | CornerAnchor::BottomLeft => bounds.x,
            CornerAnchor::TopRight | CornerAnchor::BottomRight => {
                right.saturating_sub(width as i32)
            }
        },
        y: match anchor {
            CornerAnchor::TopLeft | CornerAnchor::TopRight => bounds.y,
            CornerAnchor::BottomLeft | CornerAnchor::BottomRight => {
                bottom.saturating_sub(height as i32)
            }
        },
        width,
        height,
    };
    clamp_bounds(resized, work_area)
}

pub fn union_work_areas(work_areas: &[WorkArea]) -> Option<WorkArea> {
    let first = *work_areas.first()?;
    let mut left = first.x;
    let mut top = first.y;
    let mut right = first.x.saturating_add(first.width as i32);
    let mut bottom = first.y.saturating_add(first.height as i32);
    for area in &work_areas[1..] {
        left = left.min(area.x);
        top = top.min(area.y);
        right = right.max(area.x.saturating_add(area.width as i32));
        bottom = bottom.max(area.y.saturating_add(area.height as i32));
    }
    Some(WorkArea {
        x: left,
        y: top,
        width: right.saturating_sub(left) as u32,
        height: bottom.saturating_sub(top) as u32,
    })
}

fn monitor_work_area(monitor: &tauri::Monitor) -> WorkArea {
    let rect = monitor.work_area();
    WorkArea {
        x: rect.position.x,
        y: rect.position.y,
        width: rect.size.width,
        height: rect.size.height,
    }
}

pub fn current_bounds(window: &WebviewWindow) -> Result<WindowBounds, String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    Ok(WindowBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

fn work_area_for_window(window: &WebviewWindow) -> Result<WorkArea, String> {
    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        return Ok(monitor_work_area(&monitor));
    }
    if let Some(monitor) = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
    {
        return Ok(monitor_work_area(&monitor));
    }
    Err("no monitor is available".to_string())
}

pub fn recover_to_visible_work_area(window: &WebviewWindow) -> Result<(), String> {
    let work_area = work_area_for_window(window)?;
    let current = current_bounds(window)?;
    let clamped = clamp_bounds(current, work_area);
    let fully_offscreen = current.x.saturating_add(current.width as i32) <= work_area.x
        || current.y.saturating_add(current.height as i32) <= work_area.y
        || current.x >= work_area.x.saturating_add(work_area.width as i32)
        || current.y >= work_area.y.saturating_add(work_area.height as i32);
    let target = if fully_offscreen {
        WindowBounds {
            x: work_area
                .x
                .saturating_add(work_area.width as i32)
                .saturating_sub(current.width as i32)
                .saturating_sub(24),
            y: work_area
                .y
                .saturating_add(work_area.height as i32)
                .saturating_sub(current.height as i32)
                .saturating_sub(24),
            ..current
        }
    } else {
        clamped
    };
    window
        .set_position(PhysicalPosition::new(target.x, target.y))
        .map_err(|error| error.to_string())
}

pub fn resize_window(window: &WebviewWindow, expanded: bool) -> Result<WindowBounds, String> {
    let current = current_bounds(window)?;
    let work_area = work_area_for_window(window)?;
    let (logical_width, logical_height) = if expanded {
        (EXPANDED_WIDTH, EXPANDED_HEIGHT)
    } else {
        (COLLAPSED_WIDTH, COLLAPSED_HEIGHT)
    };
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let width = (logical_width as f64 * scale_factor).round().max(1.0) as u32;
    let height = (logical_height as f64 * scale_factor).round().max(1.0) as u32;
    let target = resize_from_anchor(current, width, height, work_area);
    window
        .set_size(LogicalSize::new(
            logical_width as f64,
            logical_height as f64,
        ))
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(target.x, target.y))
        .map_err(|error| error.to_string())?;
    Ok(target)
}

pub fn move_window_by(window: &WebviewWindow, dx: f64, dy: f64) -> Result<WindowBounds, String> {
    if !dx.is_finite() || !dy.is_finite() {
        return Err("drag delta must be finite".to_string());
    }
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let current = current_bounds(window)?;
    let next = WindowBounds {
        x: current.x.saturating_add((dx * scale_factor).round() as i32),
        y: current.y.saturating_add((dy * scale_factor).round() as i32),
        ..current
    };
    let work_areas = window
        .available_monitors()
        .map_err(|error| error.to_string())?
        .iter()
        .map(monitor_work_area)
        .collect::<Vec<_>>();
    let target = if let Some(union) = union_work_areas(&work_areas) {
        // Permit half a pet outside the virtual desktop while dragging, but never lose it completely.
        let soft = WorkArea {
            x: union.x.saturating_sub((current.width / 2) as i32),
            y: union.y.saturating_sub((current.height / 2) as i32),
            width: union.width.saturating_add(current.width),
            height: union.height.saturating_add(current.height),
        };
        clamp_bounds(next, soft)
    } else {
        next
    };
    window
        .set_position(PhysicalPosition::new(target.x, target.y))
        .map_err(|error| error.to_string())?;
    Ok(target)
}

pub fn set_click_through(window: &WebviewWindow, click_through: bool) -> Result<(), String> {
    // Tauri/WRY exposes ignore-cursor-events but not Electron's `{ forward: true }`.
    // Phase A deliberately keeps system-tray recovery instead of installing a global input hook.
    window
        .set_ignore_cursor_events(click_through)
        .map_err(|error| error.to_string())
}

pub fn show_user(window: &WebviewWindow) -> Result<(), String> {
    set_click_through(window, false)?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(windows)]
pub fn show_inactive(window: &WebviewWindow) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    // This is the narrow Windows-only equivalent under evaluation for Electron showInactive.
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn show_inactive(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

pub fn monitor_count(window: &WebviewWindow) -> usize {
    window
        .available_monitors()
        .map(|monitors| monitors.len())
        .unwrap_or(0)
}

pub fn current_scale_factor(window: &WebviewWindow) -> f64 {
    window.scale_factor().unwrap_or(1.0)
}
