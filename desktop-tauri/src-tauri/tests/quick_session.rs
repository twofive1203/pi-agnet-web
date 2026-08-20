use serde_json::json;
use snail_pi_pet_tauri_preview_lib::connection_state::{
    create_initial_connection_state, DesktopConnectionState, DesktopConnectionStatus,
};
use snail_pi_pet_tauri_preview_lib::observer_client::{ScriptedStep, ScriptedTransport};
use snail_pi_pet_tauri_preview_lib::quick_session_client::{
    sanitize_create_input, QuickSessionClient, DESKTOP_CONTROL_TOKEN_HEADER,
};

fn connected_state() -> DesktopConnectionState {
    let mut state = create_initial_connection_state(62666, 0);
    state.status = DesktopConnectionStatus::Connected;
    state.quick_session_available = true;
    state.instance_id = Some("inst-1".to_string());
    state
}

#[test]
fn lists_projects_without_leaking_secrets() {
    let transport = ScriptedTransport::new(vec![
        ScriptedStep {
            match_url: "/api/desktop-control/session".to_string(),
            status: 200,
            connection_refused: false,
            body: json!({
                "token": "header.payload.sig",
                "expiresAt": 9_999_999_999_i64,
                "instanceId": "inst-1"
            })
            .to_string(),
            sse_chunks: None,
        },
        ScriptedStep {
            match_url: "/api/desktop-control/projects".to_string(),
            status: 200,
            connection_refused: false,
            body: json!({
                "projects": [{
                    "projectRef": "p_0123456789abcdef",
                    "displayName": "Demo",
                    "latestModified": "2026-09-17T00:00:00.000Z",
                    "archived": false,
                    "worktree": false
                }],
                "truncated": false,
                "omitted": 0
            })
            .to_string(),
            sse_chunks: None,
        },
    ]);
    let client = QuickSessionClient::new(62666, None, transport);
    client.set_connection(&connected_state());
    let payload = client.list_projects(1_000);
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["catalog"]["projects"][0]["projectRef"], "p_0123456789abcdef");
    let json = payload.to_string();
    assert!(!json.contains("token"));
    assert!(!json.contains("accessKey"));
    assert!(!json.contains("cwd"));
    assert!(!json.contains("firstMessage"));
    assert!(client.token_for_tests().unwrap().contains('.'));
}

#[test]
fn create_session_is_idempotent_for_the_same_request_id() {
    let transport = ScriptedTransport::new(vec![
        ScriptedStep {
            match_url: "/api/desktop-control/session".to_string(),
            status: 200,
            connection_refused: false,
            body: json!({
                "token": "header.payload.sig",
                "expiresAt": 9_999_999_999_i64,
                "instanceId": "inst-1"
            })
            .to_string(),
            sse_chunks: None,
        },
        ScriptedStep {
            match_url: "/api/desktop-control/quick-sessions".to_string(),
            status: 200,
            connection_refused: false,
            body: json!({
                "sessionId": "sess-1",
                "deepLink": "/?session=sess-1",
                "duplicate": false
            })
            .to_string(),
            sse_chunks: None,
        },
        ScriptedStep {
            match_url: "/api/desktop-control/quick-sessions".to_string(),
            status: 200,
            connection_refused: false,
            body: json!({
                "sessionId": "sess-1",
                "deepLink": "/?session=sess-1",
                "duplicate": true
            })
            .to_string(),
            sse_chunks: None,
        },
    ]);
    let client = QuickSessionClient::new(62666, None, transport);
    client.set_connection(&connected_state());
    let input = json!({
        "projectRef": "p_0123456789abcdef",
        "message": "hello",
        "requestId": "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb"
    });
    let first = client.create_session(&input, 1_000);
    let second = client.create_session(&input, 1_000);
    assert_eq!(first["ok"], true);
    assert_eq!(second["result"]["duplicate"], true);
    assert_eq!(second["result"]["sessionId"], "sess-1");
}

#[test]
fn rejects_unsafe_create_input_and_old_servers() {
    assert_eq!(
        sanitize_create_input(&json!({
            "projectRef": "../etc",
            "message": "hi",
            "requestId": "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb"
        }))
        .unwrap_err(),
        "bad_request"
    );
    assert_eq!(
        sanitize_create_input(&json!({
            "projectRef": "p_0123456789abcdef",
            "message": "   ",
            "requestId": "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb"
        }))
        .unwrap_err(),
        "message_empty"
    );

    let client = QuickSessionClient::new(62666, None, ScriptedTransport::new(vec![]));
    let mut state = connected_state();
    state.quick_session_available = false;
    client.set_connection(&state);
    let payload = client.list_projects(1);
    assert_eq!(payload["ok"], false);
    assert_eq!(payload["code"], "feature_unavailable");
}

#[test]
fn control_token_header_stays_backend_only() {
    assert_eq!(DESKTOP_CONTROL_TOKEN_HEADER, "x-spi-desktop-control-token");
    let source = include_str!("../src/quick_session_client.rs");
    assert!(source.contains("discard_token"));
    assert!(!source.contains("std::process::Command"));
}
