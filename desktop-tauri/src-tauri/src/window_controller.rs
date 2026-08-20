use serde::Serialize;
#[cfg(not(windows))]
use tauri::LogicalSize;
use tauri::{PhysicalPosition, WebviewWindow};

// Rust owns native window bounds, so these values mirror desktop/main/window-manager.ts.
const ROOT_PAD: u32 = 6;
const CHROME_HEIGHT: u32 = 18;
const STACK_GAP: u32 = 6;
const SURFACE_SIZE: u32 = 112;
const BUBBLE_RESERVE: u32 = 40;
const INTENT_GUTTER: u32 = 24;
const STATUS_GUTTER: u32 = 16;
const COLLAPSED_WIDTH: u32 = 164;
const COLLAPSED_HEIGHT: u32 = 196;
const TRAY_WIDTH: u32 = 360;
const TRAY_HEIGHT: u32 = 480;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayLayoutAnchor {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl TrayLayoutAnchor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TopLeft => "top-left",
            Self::TopRight => "top-right",
            Self::BottomLeft => "bottom-left",
            Self::BottomRight => "bottom-right",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PetLayoutSpec {
    pub root_pad: u32,
    pub stack_width: u32,
    pub stack_height: u32,
    pub collapsed_width: u32,
    pub collapsed_height: u32,
    pub tray_width: u32,
    pub tray_height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowLayout {
    pub bounds: WindowBounds,
    pub tray_anchor: TrayLayoutAnchor,
}

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

fn scale_layout_px(value: u32, factor: f64) -> u32 {
    (f64::from(value) * factor).round().max(1.0) as u32
}

pub fn pet_layout_spec(scale: &str) -> PetLayoutSpec {
    let factor = match scale {
        "small" => 1.0,
        "large" => 1.5,
        _ => 1.2,
    };
    let root_pad = scale_layout_px(ROOT_PAD, factor);
    let stack_width = scale_layout_px(SURFACE_SIZE, factor)
        .saturating_add(scale_layout_px(INTENT_GUTTER, factor))
        .saturating_add(scale_layout_px(STATUS_GUTTER, factor));
    let stack_height = scale_layout_px(CHROME_HEIGHT, factor)
        .saturating_add(scale_layout_px(STACK_GAP, factor))
        .saturating_add(scale_layout_px(SURFACE_SIZE, factor))
        .saturating_add(scale_layout_px(BUBBLE_RESERVE, factor));
    PetLayoutSpec {
        root_pad,
        stack_width,
        stack_height,
        collapsed_width: scale_layout_px(COLLAPSED_WIDTH, factor)
            .max(root_pad.saturating_mul(2).saturating_add(stack_width)),
        collapsed_height: scale_layout_px(COLLAPSED_HEIGHT, factor)
            .max(root_pad.saturating_mul(2).saturating_add(stack_height)),
        tray_width: scale_layout_px(TRAY_WIDTH, factor)
            .max(root_pad.saturating_mul(2).saturating_add(stack_width)),
        tray_height: scale_layout_px(TRAY_HEIGHT, factor)
            .max(root_pad.saturating_mul(2).saturating_add(stack_height)),
    }
}

fn scale_layout_spec(spec: PetLayoutSpec, factor: f64) -> PetLayoutSpec {
    PetLayoutSpec {
        root_pad: scale_layout_px(spec.root_pad, factor),
        stack_width: scale_layout_px(spec.stack_width, factor),
        stack_height: scale_layout_px(spec.stack_height, factor),
        collapsed_width: scale_layout_px(spec.collapsed_width, factor),
        collapsed_height: scale_layout_px(spec.collapsed_height, factor),
        tray_width: scale_layout_px(spec.tray_width, factor),
        tray_height: scale_layout_px(spec.tray_height, factor),
    }
}

fn window_size(spec: PetLayoutSpec, expanded: bool) -> (u32, u32) {
    if expanded {
        (spec.tray_width, spec.tray_height)
    } else {
        (spec.collapsed_width, spec.collapsed_height)
    }
}

pub fn pet_stack_rect(
    bounds: WindowBounds,
    anchor: TrayLayoutAnchor,
    spec: PetLayoutSpec,
) -> WindowBounds {
    let align_right = matches!(
        anchor,
        TrayLayoutAnchor::TopRight | TrayLayoutAnchor::BottomRight
    );
    let align_bottom = matches!(
        anchor,
        TrayLayoutAnchor::BottomLeft | TrayLayoutAnchor::BottomRight
    );
    WindowBounds {
        x: if align_right {
            bounds
                .x
                .saturating_add(bounds.width as i32)
                .saturating_sub(spec.root_pad as i32)
                .saturating_sub(spec.stack_width as i32)
        } else {
            bounds.x.saturating_add(spec.root_pad as i32)
        },
        y: if align_bottom {
            bounds
                .y
                .saturating_add(bounds.height as i32)
                .saturating_sub(spec.root_pad as i32)
                .saturating_sub(spec.stack_height as i32)
        } else {
            bounds.y.saturating_add(spec.root_pad as i32)
        },
        width: spec.stack_width,
        height: spec.stack_height,
    }
}

fn window_bounds_for_pet_stack(
    stack: WindowBounds,
    anchor: TrayLayoutAnchor,
    width: u32,
    height: u32,
    spec: PetLayoutSpec,
) -> WindowBounds {
    let align_right = matches!(
        anchor,
        TrayLayoutAnchor::TopRight | TrayLayoutAnchor::BottomRight
    );
    let align_bottom = matches!(
        anchor,
        TrayLayoutAnchor::BottomLeft | TrayLayoutAnchor::BottomRight
    );
    WindowBounds {
        x: if align_right {
            stack
                .x
                .saturating_add(stack.width as i32)
                .saturating_add(spec.root_pad as i32)
                .saturating_sub(width as i32)
        } else {
            stack.x.saturating_sub(spec.root_pad as i32)
        },
        y: if align_bottom {
            stack
                .y
                .saturating_add(stack.height as i32)
                .saturating_add(spec.root_pad as i32)
                .saturating_sub(height as i32)
        } else {
            stack.y.saturating_sub(spec.root_pad as i32)
        },
        width,
        height,
    }
}

fn bounds_fit_work_area(bounds: WindowBounds, work_area: WorkArea) -> bool {
    bounds.x >= work_area.x
        && bounds.y >= work_area.y
        && bounds.x.saturating_add(bounds.width as i32)
            <= work_area.x.saturating_add(work_area.width as i32)
        && bounds.y.saturating_add(bounds.height as i32)
            <= work_area.y.saturating_add(work_area.height as i32)
}

fn pick_tray_layout_anchor(
    stack: WindowBounds,
    width: u32,
    height: u32,
    work_area: WorkArea,
    spec: PetLayoutSpec,
) -> TrayLayoutAnchor {
    let anchors = [
        TrayLayoutAnchor::TopLeft,
        TrayLayoutAnchor::TopRight,
        TrayLayoutAnchor::BottomLeft,
        TrayLayoutAnchor::BottomRight,
    ];
    for anchor in anchors {
        let bounds = window_bounds_for_pet_stack(stack, anchor, width, height, spec);
        if bounds_fit_work_area(bounds, work_area) {
            return anchor;
        }
    }

    let mut best = TrayLayoutAnchor::TopLeft;
    let mut best_score = i64::MAX;
    for anchor in anchors {
        let raw = window_bounds_for_pet_stack(stack, anchor, width, height, spec);
        let clamped = clamp_bounds(raw, work_area);
        let placed = pet_stack_rect(clamped, anchor, spec);
        let dx = i64::from(placed.x.saturating_sub(stack.x));
        let dy = i64::from(placed.y.saturating_sub(stack.y));
        let score = dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy));
        if score < best_score {
            best_score = score;
            best = anchor;
        }
    }
    best
}

pub fn transition_window_layout(
    current: WindowBounds,
    current_spec: PetLayoutSpec,
    current_expanded: bool,
    current_anchor: TrayLayoutAnchor,
    next_spec: PetLayoutSpec,
    next_expanded: bool,
    work_area: WorkArea,
) -> WindowLayout {
    let effective_current_anchor = if current_expanded {
        current_anchor
    } else {
        TrayLayoutAnchor::TopLeft
    };
    let stack = pet_stack_rect(current, effective_current_anchor, current_spec);
    let (width, height) = window_size(next_spec, next_expanded);
    let tray_anchor = if next_expanded {
        pick_tray_layout_anchor(stack, width, height, work_area, next_spec)
    } else {
        TrayLayoutAnchor::TopLeft
    };
    let bounds = clamp_bounds(
        window_bounds_for_pet_stack(stack, tray_anchor, width, height, next_spec),
        work_area,
    );
    WindowLayout {
        bounds,
        tray_anchor,
    }
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

#[cfg(windows)]
fn apply_window_layout(
    window: &WebviewWindow,
    _logical_spec: PetLayoutSpec,
    layout: WindowLayout,
    _expanded: bool,
) -> Result<WindowLayout, String> {
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER};

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            layout.bounds.x,
            layout.bounds.y,
            layout.bounds.width as i32,
            layout.bounds.height as i32,
            SWP_NOACTIVATE | SWP_NOZORDER,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(layout)
}

#[cfg(not(windows))]
fn apply_window_layout(
    window: &WebviewWindow,
    logical_spec: PetLayoutSpec,
    layout: WindowLayout,
    expanded: bool,
) -> Result<WindowLayout, String> {
    let (logical_width, logical_height) = window_size(logical_spec, expanded);
    window
        .set_size(LogicalSize::new(
            logical_width as f64,
            logical_height as f64,
        ))
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(layout.bounds.x, layout.bounds.y))
        .map_err(|error| error.to_string())?;
    Ok(layout)
}

pub fn initialize_window_layout(
    window: &WebviewWindow,
    pet_scale: &str,
    expanded: bool,
) -> Result<WindowLayout, String> {
    let current = current_bounds(window)?;
    let work_area = work_area_for_window(window)?;
    let logical_spec = pet_layout_spec(pet_scale);
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let physical_spec = scale_layout_spec(logical_spec, scale_factor);
    let (width, height) = window_size(physical_spec, expanded);
    let layout = WindowLayout {
        bounds: clamp_bounds(
            WindowBounds {
                width,
                height,
                ..current
            },
            work_area,
        ),
        tray_anchor: TrayLayoutAnchor::TopLeft,
    };
    apply_window_layout(window, logical_spec, layout, expanded)
}

pub fn resize_window(
    window: &WebviewWindow,
    current_pet_scale: &str,
    current_expanded: bool,
    current_anchor: TrayLayoutAnchor,
    next_pet_scale: &str,
    next_expanded: bool,
) -> Result<WindowLayout, String> {
    let current = current_bounds(window)?;
    let work_area = work_area_for_window(window)?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let current_spec = scale_layout_spec(pet_layout_spec(current_pet_scale), scale_factor);
    let next_logical_spec = pet_layout_spec(next_pet_scale);
    let next_spec = scale_layout_spec(next_logical_spec, scale_factor);
    let layout = transition_window_layout(
        current,
        current_spec,
        current_expanded,
        current_anchor,
        next_spec,
        next_expanded,
        work_area,
    );
    apply_window_layout(window, next_logical_spec, layout, next_expanded)
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
