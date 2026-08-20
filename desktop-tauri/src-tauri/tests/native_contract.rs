use serde_json::json;
use snail_pi_pet_tauri_preview_lib::{
    deep_links::{open_validated_deep_link, parse_desktop_deep_link, reject_arbitrary_renderer_url},
    native::TAURI_AUTOSTART_VALUE_NAME,
    notifications::select_notification_candidates,
    tray_controller::{build_tray_menu_model, DISABLE_CLICK_THROUGH, QUIT_PREVIEW, TrayModelInput},
    window_controller::{
        clamp_bounds, nearest_corner_anchor, resize_from_anchor, union_work_areas, CornerAnchor,
        WindowBounds, WorkArea,
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
