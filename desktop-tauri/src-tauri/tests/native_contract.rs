use snail_pi_pet_tauri_preview_lib::{
    tray_controller::{DISABLE_CLICK_THROUGH, QUIT_PREVIEW},
    window_controller::{
        clamp_bounds, nearest_corner_anchor, resize_from_anchor, union_work_areas, CornerAnchor,
        WindowBounds, WorkArea,
    },
};

#[test]
fn clamp_supports_negative_monitor_coordinates() {
    let work_area = WorkArea {
        x: -1920,
        y: -200,
        width: 1920,
        height: 1080,
    };
    let clamped = clamp_bounds(
        WindowBounds {
            x: -2600,
            y: -500,
            width: 360,
            height: 480,
        },
        work_area,
    );
    assert_eq!(clamped.x, -1920);
    assert_eq!(clamped.y, -200);
}

#[test]
fn resizing_preserves_the_nearest_visual_corner() {
    let work_area = WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    let collapsed = WindowBounds {
        x: 1716,
        y: 836,
        width: 180,
        height: 220,
    };
    assert_eq!(
        nearest_corner_anchor(collapsed, work_area),
        CornerAnchor::BottomRight
    );
    let expanded = resize_from_anchor(collapsed, 360, 480, work_area);
    assert_eq!(
        expanded.x + expanded.width as i32,
        collapsed.x + collapsed.width as i32
    );
    assert_eq!(
        expanded.y + expanded.height as i32,
        collapsed.y + collapsed.height as i32
    );
}

#[test]
fn virtual_desktop_union_spans_mixed_layouts() {
    let union = union_work_areas(&[
        WorkArea {
            x: -2560,
            y: 0,
            width: 2560,
            height: 1440,
        },
        WorkArea {
            x: 0,
            y: -540,
            width: 3840,
            height: 2160,
        },
    ])
    .expect("union");
    assert_eq!(union.x, -2560);
    assert_eq!(union.y, -540);
    assert_eq!(union.width, 6400);
    assert_eq!(union.height, 2160);
}

#[test]
fn tray_always_has_click_through_recovery_and_preview_only_quit() {
    assert_eq!(DISABLE_CLICK_THROUGH, "disable-click-through");
    assert_eq!(QUIT_PREVIEW, "quit-preview");
    let source = include_str!("../src/tray_controller.rs");
    assert!(source.contains("取消鼠标穿透"));
    assert!(source.contains("退出 Tauri Preview"));
    assert!(!source.contains("spi --no-open"));
}

#[test]
fn click_through_uses_tauri_api_without_global_input_hooks() {
    let source = include_str!("../src/window_controller.rs");
    assert!(source.contains("set_ignore_cursor_events"));
    assert!(source.contains("show_inactive"));
    assert!(!source.contains("SetWindowsHookEx"));
    assert!(!source.contains("WH_MOUSE"));
}
