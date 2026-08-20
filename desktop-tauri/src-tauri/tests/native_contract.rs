use serde_json::json;
use snail_pi_pet_tauri_preview_lib::{
    deep_links::{open_validated_deep_link, parse_desktop_deep_link, reject_arbitrary_renderer_url},
    native::TAURI_AUTOSTART_VALUE_NAME,
    notifications::select_notification_candidates,
    tray_controller::{build_tray_menu_model, DISABLE_CLICK_THROUGH, QUIT_PREVIEW, TrayModelInput},
    window_controller::{
        clamp_bounds, default_window_layout, pet_layout_spec, pet_stack_rect,
        recover_bounds_to_nearest_work_area, transition_window_layout, union_work_areas,
        TrayLayoutAnchor, WindowBounds, WorkArea,
    },
    activity_view::default_desktop_settings,
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
fn tauri_sizes_match_the_shared_renderer_layout_at_every_pet_scale() {
    let small = pet_layout_spec("small");
    assert_eq!((small.collapsed_width, small.collapsed_height), (164, 196));
    assert_eq!((small.tray_width, small.tray_height), (360, 480));

    let medium = pet_layout_spec("medium");
    assert_eq!((medium.collapsed_width, medium.collapsed_height), (197, 235));
    assert_eq!((medium.tray_width, medium.tray_height), (432, 576));

    let large = pet_layout_spec("large");
    assert_eq!((large.collapsed_width, large.collapsed_height), (246, 294));
    assert_eq!((large.tray_width, large.tray_height), (540, 720));
}

#[test]
fn tray_and_scale_transitions_keep_the_pet_stack_screen_position() {
    let work_area = WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    let medium = pet_layout_spec("medium");
    let collapsed = WindowBounds {
        x: 800,
        y: 300,
        width: medium.collapsed_width,
        height: medium.collapsed_height,
    };
    let initial_stack = pet_stack_rect(collapsed, TrayLayoutAnchor::TopLeft, medium);

    let large = pet_layout_spec("large");
    let scaled = transition_window_layout(
        collapsed,
        medium,
        false,
        TrayLayoutAnchor::TopLeft,
        large,
        false,
        work_area,
    );
    let scaled_stack = pet_stack_rect(scaled.bounds, scaled.tray_anchor, large);
    assert_eq!((scaled_stack.x, scaled_stack.y), (initial_stack.x, initial_stack.y));

    let expanded = transition_window_layout(
        scaled.bounds,
        large,
        false,
        scaled.tray_anchor,
        large,
        true,
        work_area,
    );
    let expanded_stack = pet_stack_rect(expanded.bounds, expanded.tray_anchor, large);
    assert_eq!((expanded_stack.x, expanded_stack.y), (scaled_stack.x, scaled_stack.y));

    let collapsed_again = transition_window_layout(
        expanded.bounds,
        large,
        true,
        expanded.tray_anchor,
        large,
        false,
        work_area,
    );
    let final_stack = pet_stack_rect(
        collapsed_again.bounds,
        collapsed_again.tray_anchor,
        large,
    );
    assert_eq!((final_stack.x, final_stack.y), (scaled_stack.x, scaled_stack.y));
}

#[test]
fn bottom_right_tray_expands_up_and_left_without_moving_the_pet() {
    let work_area = WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };
    let spec = pet_layout_spec("medium");
    let collapsed = WindowBounds {
        x: 1920 - spec.collapsed_width as i32 - 24,
        y: 1080 - spec.collapsed_height as i32 - 24,
        width: spec.collapsed_width,
        height: spec.collapsed_height,
    };
    let stack = pet_stack_rect(collapsed, TrayLayoutAnchor::TopLeft, spec);
    let expanded = transition_window_layout(
        collapsed,
        spec,
        false,
        TrayLayoutAnchor::TopLeft,
        spec,
        true,
        work_area,
    );
    assert_eq!(expanded.tray_anchor, TrayLayoutAnchor::BottomRight);
    assert_eq!(pet_stack_rect(expanded.bounds, expanded.tray_anchor, spec), stack);
}

#[test]
fn restore_default_uses_medium_collapsed_bottom_right_layout() {
    let work_area = WorkArea {
        x: -1920,
        y: -200,
        width: 1920,
        height: 1080,
    };
    let layout = default_window_layout(work_area, pet_layout_spec("medium"));
    assert_eq!(layout.tray_anchor, TrayLayoutAnchor::TopLeft);
    assert_eq!(layout.bounds.width, 197);
    assert_eq!(layout.bounds.height, 235);
    assert_eq!(layout.bounds.x, -221);
    assert_eq!(layout.bounds.y, 621);
}

#[test]
fn display_recovery_selects_nearest_remaining_work_area() {
    let current = WindowBounds {
        x: -1800,
        y: 100,
        width: 197,
        height: 235,
    };
    let remaining = [WorkArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    }];
    let recovered = recover_bounds_to_nearest_work_area(current, &remaining).expect("recovered");
    assert_eq!(recovered.x, 0);
    assert_eq!(recovered.y, 100);
    assert_eq!(recovered.width, current.width);
    assert_eq!(recovered.height, current.height);

    let already_visible = WindowBounds { x: 50, y: 50, ..current };
    assert_eq!(
        recover_bounds_to_nearest_work_area(already_visible, &remaining),
        Some(already_visible)
    );
    assert_eq!(recover_bounds_to_nearest_work_area(current, &[]), None);
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
fn mixed_dpi_crossing_does_not_run_display_topology_recovery() {
    let host_source = include_str!("../src/lib.rs");
    assert!(host_source.contains("spawn_monitor_watcher"));
    assert!(!host_source.contains("WindowEvent::ScaleFactorChanged"));
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
fn hide_to_tray_uses_the_windows_native_visibility_path() {
    let window_source = include_str!("../src/window_controller.rs");
    let host_source = include_str!("../src/lib.rs");
    assert!(window_source.contains("SW_HIDE"));
    assert!(window_source.contains("pub fn hide_to_tray"));
    assert!(host_source.contains("window_controller::hide_to_tray(&window)"));
}

#[test]
fn click_through_uses_tauri_api_without_global_input_hooks() {
    let source = include_str!("../src/window_controller.rs");
    assert!(source.contains("set_ignore_cursor_events"));
    assert!(source.contains("show_inactive"));
    assert!(source.contains("SetWindowPos"));
    assert!(!source.contains("SetWindowsHookEx"));
    assert!(!source.contains("WH_MOUSE"));
}

#[test]
fn tray_model_covers_dnd_sound_retry_and_preview_only_quit() {
    let items = build_tray_menu_model(TrayModelInput {
        presentation: "needs_input",
        connection_status: "connected",
        click_through: true,
        dnd_enabled: true,
        sound_master_enabled: false,
        can_copy_start_command: true,
    });
    assert!(items.iter().any(|item| item.id == "toggle-dnd" && item.checked == Some(true)));
    assert!(items.iter().any(|item| item.id == "toggle-sound" && item.checked == Some(false)));
    assert!(items.iter().any(|item| item.id == "retry" && item.enabled));
    assert!(items.iter().any(|item| item.id == "open-webui"));
    let quit = items.iter().find(|item| item.id == QUIT_PREVIEW).expect("quit");
    assert_eq!(quit.label, "退出 Tauri Preview");
    assert!(!quit.label.contains("任务"));
    let copy = items.iter().find(|item| item.id == "copy-start-command").expect("copy");
    assert!(copy.label.contains("spi --no-open"));
}

#[test]
fn deep_links_allowlist_relative_paths_and_reject_absolute_urls() {
    assert!(parse_desktop_deep_link("/?session=abc").is_ok());
    assert!(parse_desktop_deep_link("/?inspector=snflow&task=task-1").is_ok());
    assert!(parse_desktop_deep_link("/?panel=automation&task=t1&run=r1").is_ok());
    assert!(parse_desktop_deep_link("https://example.com").is_err());
    assert!(parse_desktop_deep_link("/?cwd=C:\\Users").is_err());
    assert!(parse_desktop_deep_link("/?session=abc&token=secret").is_err());
    let rejected = reject_arbitrary_renderer_url("https://evil.example");
    match rejected {
        snail_pi_pet_tauri_preview_lib::deep_links::DeepLinkResult::Err { reason } => {
            assert_eq!(reason, "absolute_url_rejected");
        }
        _ => panic!("expected rejection"),
    }
    let opened = open_validated_deep_link("http://127.0.0.1:62666", "https://example.com");
    match opened {
        snail_pi_pet_tauri_preview_lib::deep_links::DeepLinkResult::Err { reason } => {
            assert_eq!(reason, "absolute_or_protocol_relative");
        }
        _ => panic!("absolute url must not open"),
    }
}

#[test]
fn notifications_seed_baseline_and_consume_dnd_without_replay() {
    let mut settings = default_desktop_settings();
    settings.dnd_enabled = true;
    let snapshot = json!({
        "recentTransitions": [{
            "transitionId": "tr-1",
            "activityId": "a1",
            "taskKey": "task",
            "projectKey": "proj",
            "presentation": "needs_input"
        }],
        "projects": []
    });
    let (candidates, effects) = select_notification_candidates(&settings, &snapshot, false, true, 1_000);
    assert!(candidates.is_empty());
    assert!(effects.notified_transition_ids.contains(&"tr-1".to_string()));
    let (again, _) = select_notification_candidates(
        &snail_pi_pet_tauri_preview_lib::activity_view::DesktopPetSettings {
            notified_transition_ids: effects.notified_transition_ids.clone(),
            ..settings
        },
        &snapshot,
        false,
        true,
        2_000,
    );
    assert!(again.is_empty());
}

#[test]
fn autostart_name_is_preview_specific() {
    assert_eq!(TAURI_AUTOSTART_VALUE_NAME, "SnailPiPetTauriPreview");
    assert!(!TAURI_AUTOSTART_VALUE_NAME.contains("SnailPiPet") || TAURI_AUTOSTART_VALUE_NAME.contains("TauriPreview"));
    let native = include_str!("../src/native.rs");
    assert!(!native.contains("std::process::Command"));
    assert!(native.contains("ShellExecuteW") || native.contains("open_unsupported"));
}
