use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use snail_pi_pet_tauri_preview_lib::access_key::{
    access_key_file_path, save_desktop_access_key, AccessKeyCodec, MemoryAccessKeyCodec,
};
use snail_pi_pet_tauri_preview_lib::server_profiles::{
    assert_projection_safe, delete_server_profile, load_or_migrate_profile_store, load_profile_store,
    normalize_server_origin, parse_save_intent, profiles_projection_json, project_profiles,
    save_profile_store, save_server_profile, server_profiles_file_path, switch_active_profile,
    AccessKeyCommand, ProfileError, RuntimeProfile, RuntimeProfileStore, SaveProfileIntent,
    LOCAL_PROFILE_ID, MAX_SERVER_PROFILES,
};

struct TestCodec;

impl AccessKeyCodec for TestCodec {
    fn is_available(&self) -> bool {
        true
    }

    fn encrypt(&self, plain: &str) -> Result<String, String> {
        Ok(format!("v1:{}", plain.chars().rev().collect::<String>()))
    }

    fn decrypt(&self, blob: &str) -> Result<String, String> {
        let rest = blob.strip_prefix("v1:").ok_or_else(|| "corrupt".to_string())?;
        Ok(rest.chars().rev().collect())
    }
}

fn temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "snail-pi-tauri-profiles-{label}-{nanos}-{}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn empty_store() -> RuntimeProfileStore {
    RuntimeProfileStore {
        active_server_id: LOCAL_PROFILE_ID.to_string(),
        profiles: vec![RuntimeProfile {
            id: LOCAL_PROFILE_ID.to_string(),
            name: Some("本机".to_string()),
            origin: "http://127.0.0.1:62666".to_string(),
            allow_insecure_http: false,
            access_key: None,
            key_persisted: false,
        }],
    }
}

#[test]
fn origin_normalization_covers_hosts_and_rejects_unsafe_input() {
    assert_eq!(
        normalize_server_origin("192.168.1.10", false).unwrap(),
        "https://192.168.1.10:62666"
    );
    assert_eq!(
        normalize_server_origin("[2001:db8::1]", false).unwrap(),
        "https://[2001:db8::1]:62666"
    );
    assert_eq!(
        normalize_server_origin("pi.example", false).unwrap(),
        "https://pi.example:62666"
    );
    assert_eq!(
        normalize_server_origin("https://pi.example:8443", false).unwrap(),
        "https://pi.example:8443"
    );
    assert_eq!(
        normalize_server_origin("http://127.0.0.1", false).unwrap(),
        "http://127.0.0.1:62666"
    );
    assert_eq!(
        normalize_server_origin("http://10.0.0.8:62666", true).unwrap(),
        "http://10.0.0.8:62666"
    );

    assert_eq!(
        normalize_server_origin("http://10.0.0.8", false).unwrap_err(),
        ProfileError::InsecureHttpNotAllowed
    );
    assert_eq!(
        normalize_server_origin("http://user:pass@10.0.0.8", true).unwrap_err(),
        ProfileError::UserinfoForbidden
    );
    assert_eq!(
        normalize_server_origin("https://pi.example/path", false).unwrap_err(),
        ProfileError::PathForbidden
    );
    assert_eq!(
        normalize_server_origin("https://pi.example?x=1", false).unwrap_err(),
        ProfileError::QueryForbidden
    );
    assert_eq!(
        normalize_server_origin("https://pi.example#frag", false).unwrap_err(),
        ProfileError::FragmentForbidden
    );
    assert_eq!(
        normalize_server_origin("ftp://pi.example", false).unwrap_err(),
        ProfileError::UnknownScheme
    );
    assert_eq!(
        normalize_server_origin("https://pi.example:0", false).unwrap_err(),
        ProfileError::InvalidPort
    );
}

#[test]
fn save_two_https_profiles_round_trips_without_plaintext() {
    let dir = temp_dir("two-https");
    let codec = TestCodec;
    let first = save_server_profile(
        &empty_store(),
        SaveProfileIntent {
            id: None,
            name: Some("办公".to_string()),
            address: "https://10.0.0.8:8443".to_string(),
            allow_insecure_http: false,
            access_key: AccessKeyCommand::Replace("alpha-secret-key".to_string()),
        },
        &codec,
    )
    .unwrap();
    let second = save_server_profile(
        &first,
        SaveProfileIntent {
            id: None,
            name: Some("实验室".to_string()),
            address: "pi.lab.local".to_string(),
            allow_insecure_http: false,
            access_key: AccessKeyCommand::Replace("beta-secret-key".to_string()),
        },
        &codec,
    )
    .unwrap();
    let persisted = save_profile_store(&dir, &second, &codec).unwrap();
    let reloaded = load_profile_store(&dir, &codec).unwrap().unwrap();
    assert_eq!(reloaded.profiles.len(), 3);
    let office = reloaded
        .profiles
        .iter()
        .find(|profile| profile.name.as_deref() == Some("办公"))
        .unwrap();
    assert_eq!(office.origin, "https://10.0.0.8:8443");
    assert_eq!(office.access_key.as_deref(), Some("alpha-secret-key"));
    assert!(office.key_persisted);
    let lab = reloaded
        .profiles
        .iter()
        .find(|profile| profile.name.as_deref() == Some("实验室"))
        .unwrap();
    assert_eq!(lab.origin, "https://pi.lab.local:62666");
    assert_eq!(lab.access_key.as_deref(), Some("beta-secret-key"));

    let disk = fs::read_to_string(server_profiles_file_path(&dir)).unwrap();
    assert!(!disk.contains("alpha-secret-key"));
    assert!(!disk.contains("beta-secret-key"));
    assert!(!disk.contains("\"accessKey\""));
    let projection = profiles_projection_json(&persisted);
    assert_projection_safe(&projection).unwrap();
    assert!(projection.to_string().contains("hasAccessKey"));
    assert!(!projection.to_string().contains("alpha-secret-key"));
}

#[test]
fn loopback_http_does_not_require_insecure_flag_remote_http_does() {
    let codec = TestCodec;
    let loopback = save_server_profile(
        &empty_store(),
        SaveProfileIntent {
            id: Some(LOCAL_PROFILE_ID.to_string()),
            name: Some("本机".to_string()),
            address: "http://127.0.0.1:62666".to_string(),
            allow_insecure_http: false,
            access_key: AccessKeyCommand::Preserve,
        },
        &codec,
    )
    .unwrap();
    assert!(!loopback.profiles[0].is_insecure());
    let remote = save_server_profile(
        &loopback,
        SaveProfileIntent {
            id: None,
            name: None,
            address: "http://10.0.0.9:62666".to_string(),
            allow_insecure_http: true,
            access_key: AccessKeyCommand::Preserve,
        },
        &codec,
    )
    .unwrap();
    let added = remote.profiles.iter().find(|profile| profile.origin.contains("10.0.0.9")).unwrap();
    assert!(added.is_insecure());
    assert!(added.allow_insecure_http);
}

#[test]
fn duplicate_origin_and_limits_are_rejected() {
    let codec = TestCodec;
    let first = save_server_profile(
        &empty_store(),
        SaveProfileIntent {
            id: None,
            name: None,
            address: "10.0.0.8".to_string(),
            allow_insecure_http: false,
            access_key: AccessKeyCommand::Preserve,
        },
        &codec,
    )
    .unwrap();
    let duplicate = save_server_profile(
        &first,
        SaveProfileIntent {
            id: None,
            name: None,
            address: "https://10.0.0.8:62666".to_string(),
            allow_insecure_http: false,
            access_key: AccessKeyCommand::Preserve,
        },
        &codec,
    );
    assert_eq!(duplicate.unwrap_err(), ProfileError::DuplicateOrigin);

    let mut crowded = first.clone();
    for index in 0..MAX_SERVER_PROFILES - 1 {
        crowded.profiles.push(RuntimeProfile {
            id: format!("srv_{index:028x}"),
            name: None,
            origin: format!("https://10.0.0.{}:62666", index + 11),
            allow_insecure_http: false,
            access_key: None,
            key_persisted: false,
        });
    }
    let overflow = save_server_profile(
        &crowded,
        SaveProfileIntent {
            id: None,
            name: None,
            address: "https://10.1.1.1:62666".to_string(),
            allow_insecure_http: false,
            access_key: AccessKeyCommand::Preserve,
        },
        &codec,
    );
    assert_eq!(overflow.unwrap_err(), ProfileError::TooManyProfiles);
}

#[test]
fn invalid_edits_leave_the_store_unchanged() {
    let codec = TestCodec;
    let original = empty_store();
    for address in [
        "http://user:pass@10.0.0.8",
        "https://pi.example/path",
        "https://pi.example?x=1",
        "https://pi.example#frag",
        "ftp://pi.example",
        "https://pi.example:99999",
        "http://10.0.0.8",
    ] {
        let result = save_server_profile(
            &original,
            SaveProfileIntent {
                id: None,
                name: None,
                address: address.to_string(),
                allow_insecure_http: false,
                access_key: AccessKeyCommand::Preserve,
            },
            &codec,
        );
        assert!(result.is_err(), "{address}");
    }
}

#[test]
fn memory_codec_persists_metadata_only() {
    let dir = temp_dir("memory-codec");
    let codec = MemoryAccessKeyCodec;
    let saved = save_server_profile(
        &empty_store(),
        SaveProfileIntent {
            id: None,
            name: Some("远程".to_string()),
            address: "https://10.0.0.8:8443".to_string(),
            allow_insecure_http: false,
            access_key: AccessKeyCommand::Replace("only-in-memory".to_string()),
        },
        &codec,
    )
    .unwrap();
    let persisted = save_profile_store(&dir, &saved, &codec).unwrap();
    let remote = persisted
        .profiles
        .iter()
        .find(|profile| profile.name.as_deref() == Some("远程"))
        .unwrap();
    assert_eq!(remote.access_key.as_deref(), Some("only-in-memory"));
    assert!(!remote.key_persisted);
    let disk = fs::read_to_string(server_profiles_file_path(&dir)).unwrap();
    assert!(!disk.contains("only-in-memory"));
    assert!(!disk.contains("\"accessKeyCiphertext\"") || disk.contains("\"accessKeyCiphertext\": null"));

    let reloaded = load_profile_store(&dir, &codec).unwrap().unwrap();
    let remote = reloaded
        .profiles
        .iter()
        .find(|profile| profile.name.as_deref() == Some("远程"))
        .unwrap();
    assert!(remote.access_key.is_none());
    assert!(!remote.key_persisted);
}

#[test]
fn legacy_port_and_key_migrate_then_old_file_is_removed() {
    let dir = temp_dir("migrate-ok");
    let codec = TestCodec;
    save_desktop_access_key(&dir, "legacy-secret-key", &codec).unwrap();
    assert!(access_key_file_path(&dir).exists());
    let store = load_or_migrate_profile_store(&dir, 51234, &codec);
    assert_eq!(store.active_server_id, LOCAL_PROFILE_ID);
    assert_eq!(store.profiles[0].origin, "http://127.0.0.1:51234");
    assert_eq!(store.profiles[0].access_key.as_deref(), Some("legacy-secret-key"));
    assert!(store.profiles[0].key_persisted);
    assert!(!access_key_file_path(&dir).exists());
    let disk = fs::read_to_string(server_profiles_file_path(&dir)).unwrap();
    assert!(!disk.contains("legacy-secret-key"));
}

#[test]
fn migration_keeps_legacy_key_when_new_store_cannot_persist() {
    let dir = temp_dir("migrate-fail");
    let codec = TestCodec;
    save_desktop_access_key(&dir, "legacy-secret-key", &codec).unwrap();
    let blocker = server_profiles_file_path(&dir);
    fs::create_dir_all(&blocker).unwrap();
    let store = load_or_migrate_profile_store(&dir, 62666, &codec);
    assert_eq!(store.profiles[0].origin, "http://127.0.0.1:62666");
    assert_eq!(store.profiles[0].access_key.as_deref(), Some("legacy-secret-key"));
    assert!(access_key_file_path(&dir).exists());
}

#[test]
fn cannot_delete_active_or_last_profile() {
    let codec = TestCodec;
    let with_remote = save_server_profile(
        &empty_store(),
        SaveProfileIntent {
            id: None,
            name: None,
            address: "https://10.0.0.8:8443".to_string(),
            allow_insecure_http: false,
            access_key: AccessKeyCommand::Preserve,
        },
        &codec,
    )
    .unwrap();
    assert_eq!(
        delete_server_profile(&with_remote, LOCAL_PROFILE_ID).unwrap_err(),
        ProfileError::CannotDeleteActive
    );
    let switched = switch_active_profile(
        &with_remote,
        &with_remote.profiles[1].id,
    )
    .unwrap();
    let after_delete = delete_server_profile(&switched, LOCAL_PROFILE_ID).unwrap();
    assert_eq!(
        delete_server_profile(&after_delete, &after_delete.active_server_id).unwrap_err(),
        ProfileError::CannotDeleteLast
    );
}

#[test]
fn projection_omits_ciphertext_and_codec_errors() {
    let mut store = empty_store();
    store.profiles[0].access_key = Some("super-secret-key".to_string());
    store.profiles[0].key_persisted = true;
    let projected = project_profiles(&store);
    let json = serde_json::to_value(&projected).unwrap();
    assert_projection_safe(&json).unwrap();
    assert_eq!(json[0]["hasAccessKey"], true);
    assert_eq!(json[0]["keyPersisted"], true);
    assert!(json[0].get("accessKey").is_none());
    assert!(json[0].get("accessKeyCiphertext").is_none());
}

#[test]
fn parse_save_intent_defaults_to_preserve() {
    let intent = parse_save_intent(&json!({
        "address": "https://10.0.0.8:8443",
        "name": "办公"
    }))
    .unwrap();
    assert_eq!(intent.access_key, AccessKeyCommand::Preserve);
    assert_eq!(intent.name.as_deref(), Some("办公"));
}
