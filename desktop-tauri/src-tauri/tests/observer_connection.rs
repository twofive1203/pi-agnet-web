use serde_json::{json, Value};
use snail_pi_pet_tauri_preview_lib::connection_state::{
    acknowledge_connection_baseline, create_initial_connection_state, is_loopback_observer_url,
    is_target_scoped_url, public_connection_state, reduce_connection_state, ConnectionTarget,
    DesktopConnectionEvent, DesktopConnectionReasonCode,
};
use snail_pi_pet_tauri_preview_lib::observer_client::{
    classify_fetch_failure, interpret_health_payload, interpret_protocol_payload,
    interpret_session_payload, unwrap_observer_sse_data, ObserverClient, ProbeResult,
    ProtocolResult, ScriptedStep, ScriptedTransport, SessionResult,
};

fn fixtures() -> Value {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/fixtures/desktop-pet-host/connection-cases.json");
    let raw = std::fs::read_to_string(path).expect("read connection fixtures");
    assert!(
        !raw.contains("\"token\":") && !raw.contains("\"accessKey\":"),
        "connection fixtures must not embed secret keys"
    );
    serde_json::from_str(&raw).expect("parse connection fixtures")
}

#[test]
fn shared_reducer_fixtures_match_electron() {
    let fixtures = fixtures();
    for case in fixtures["reducerCases"].as_array().expect("reducer cases") {
        let port = case["port"].as_u64().unwrap_or(62666) as u16;
        let now = case["now"].as_i64().unwrap_or(0);
        let mut state = create_initial_connection_state(port, now);
        for step in case["steps"].as_array().expect("steps") {
            let at = step["at"].as_i64().unwrap_or(now);
            if step["kind"].as_str() == Some("acknowledge") {
                state = acknowledge_connection_baseline(&state, at);
                continue;
            }
            let event: DesktopConnectionEvent =
                serde_json::from_value(step["event"].clone()).expect("event");
            state = reduce_connection_state(&state, &event, at);
        }
        assert_eq!(
            public_connection_state(&state),
            case["expected"],
            "reducer {}",
            case["id"]
        );
    }
}

#[test]
fn shared_interpreter_fixtures_match_electron() {
    let fixtures = fixtures();
    for case in fixtures["healthCases"].as_array().expect("health") {
        let actual = interpret_health_payload(&case["payload"], case["httpStatus"].as_u64().unwrap() as u16);
        let expected = &case["expected"];
        if expected.is_null() {
            assert!(actual.is_none(), "health {}", case["id"]);
        } else {
            assert_eq!(
                serde_json::to_value(actual).unwrap(),
                *expected,
                "health {}",
                case["id"]
            );
        }
    }

    for case in fixtures["protocolCases"].as_array().expect("protocol") {
        let actual =
            interpret_protocol_payload(&case["payload"], case["httpStatus"].as_u64().unwrap() as u16);
        match actual {
            ProtocolResult::Ok(ok) => {
                assert_eq!(case["expected"]["type"], "protocol_ok", "{}", case["id"]);
                assert_eq!(ok.instance_id, case["expected"]["instanceId"]);
                assert_eq!(ok.auth_required, case["expected"]["authRequired"]);
                assert_eq!(
                    ok.quick_session_available,
                    case["expected"]["quickSessionAvailable"]
                );
            }
            ProtocolResult::Event(event) => {
                assert_eq!(
                    serde_json::to_value(event).unwrap(),
                    case["expected"],
                    "protocol {}",
                    case["id"]
                );
            }
        }
    }

    for case in fixtures["sessionCases"].as_array().expect("session") {
        let mut payload = case["payload"].clone();
        if let Some(secret) = case.get("sessionSecret").and_then(Value::as_str) {
            payload
                .as_object_mut()
                .unwrap()
                .insert("token".to_string(), json!(secret));
        }
        let actual =
            interpret_session_payload(&payload, case["httpStatus"].as_u64().unwrap() as u16);
        match actual {
            SessionResult::Ok {
                instance_id,
                expires_at,
                token,
            } => {
                assert_eq!(case["expected"]["ok"], true, "{}", case["id"]);
                assert_eq!(instance_id, case["expected"]["instanceId"]);
                assert_eq!(expires_at, case["expected"]["expiresAt"]);
                assert_eq!(
                    Some(token.as_str()),
                    case.get("sessionSecret").and_then(Value::as_str)
                );
            }
            SessionResult::Event(event) => {
                assert_eq!(
                    serde_json::to_value(event).unwrap(),
                    case["expected"],
                    "session {}",
                    case["id"]
                );
            }
        }
    }

    for case in fixtures["sseCases"].as_array().expect("sse") {
        let actual = unwrap_observer_sse_data(case["raw"].as_str().unwrap());
        assert_eq!(actual.kind, case["expected"]["kind"], "{}", case["id"]);
        if let Some(reset) = case["expected"].get("reset") {
            assert_eq!(actual.reset, reset.as_bool().unwrap_or(false), "{}", case["id"]);
        }
        if let Some(code) = case["expected"].get("code").and_then(Value::as_str) {
            assert_eq!(actual.code.as_deref(), Some(code), "{}", case["id"]);
        }
        if let Some(includes) = case["expected"].get("includes").and_then(Value::as_str) {
            assert!(
                actual
                    .snapshot_json
                    .as_deref()
                    .is_some_and(|json| json.contains(includes)),
                "{}",
                case["id"]
            );
        }
    }

    for case in fixtures["classifyCases"].as_array().expect("classify") {
        let actual = classify_fetch_failure(case["message"].as_str().unwrap());
        assert_eq!(
            serde_json::to_value(actual).unwrap()["type"],
            case["expected"]["type"],
            "{}",
            case["id"]
        );
    }
}

#[test]
fn loopback_url_allowlist_rejects_non_local_hosts() {
    let fixtures = fixtures();
    let port = fixtures["constants"]["defaultPort"].as_u64().unwrap() as u16;
    for url in fixtures["urlAllowlist"]["accepted"].as_array().unwrap() {
        assert!(
            is_loopback_observer_url(url.as_str().unwrap(), port),
            "{}",
            url
        );
    }
    for url in fixtures["urlAllowlist"]["rejected"].as_array().unwrap() {
        assert!(
            !is_loopback_observer_url(url.as_str().unwrap(), port),
            "{}",
            url
        );
    }
}

#[test]
fn scripted_probe_keeps_token_out_of_connection_state() {
    let transport = ScriptedTransport::new(vec![
        ScriptedStep {
            match_url: "/api/health".to_string(),
            status: 200,
            connection_refused: false,
            body: json!({ "ok": true, "instanceId": "inst-1" }).to_string(),
            sse_chunks: None,
        },
        ScriptedStep {
            match_url: "/protocol".to_string(),
            status: 200,
            connection_refused: false,
            body: json!({
                "product": "snail-pi-web",
                "protocolVersion": 1,
                "mode": "local",
                "compatible": true,
                "instanceId": "inst-1"
            })
            .to_string(),
            sse_chunks: None,
        },
        ScriptedStep {
            match_url: "/session".to_string(),
            status: 200,
            connection_refused: false,
            body: json!({
                "token": "secret-token",
                "expiresAt": 999999,
                "instanceId": "inst-1"
            })
            .to_string(),
            sse_chunks: None,
        },
    ]);
    let client = ObserverClient::new(62666, 1, transport, None, None, None);
    let result = client.probe();
    match result {
        ProbeResult::Ok(success) => {
            assert_eq!(success.instance_id, "inst-1");
            assert_eq!(success.token, "secret-token");
        }
        ProbeResult::Err(event) => panic!("expected probe ok, got {event:?}"),
    }
    let state = serde_json::to_string(&client.get_state()).unwrap();
    assert!(!state.contains("secret-token"));
    assert!(!state.contains("\"token\""));
}

#[test]
fn observer_sources_stay_attach_only() {
    for file in ["observer_client.rs", "app_state.rs", "connection_state.rs"] {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("src")
                .join(file),
        )
        .unwrap();
        assert!(
            !source.contains("std::process::Command") && !source.contains("servicePid"),
            "{file} must remain attach-only"
        );
    }
}

#[test]
fn remote_http_without_flag_is_rejected_before_fetch() {
    let client = ObserverClient::with_target(
        ConnectionTarget {
            profile_id: "srv_ab".to_string(),
            origin: "http://10.0.0.8:62666".to_string(),
            port: 62666,
            allow_insecure_http: false,
            generation: 2,
        },
        1,
        ScriptedTransport::new(vec![]),
        None,
        None,
        None,
    );
    match client.probe() {
        ProbeResult::Err(DesktopConnectionEvent::Incompatible { reason_code, .. }) => {
            assert_eq!(reason_code, DesktopConnectionReasonCode::InsecureHttpRejected);
        }
        other => panic!("expected insecure rejection, got {other:?}"),
    }
}

#[test]
fn target_url_allowlist_is_origin_scoped() {
    assert!(is_target_scoped_url(
        "https://10.0.0.8:8443/api/health",
        "https://10.0.0.8:8443"
    ));
    assert!(!is_target_scoped_url(
        "https://10.0.0.9:8443/api/health",
        "https://10.0.0.8:8443"
    ));
    assert!(!is_loopback_observer_url("https://10.0.0.8:8443/api/health", 8443));
}
