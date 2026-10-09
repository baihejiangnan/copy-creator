use crate::update_package::{self, Artifact, CheckedUpdate, PreparedUpdate};
use reqwest::StatusCode;
use semver::Version;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{collections::HashMap, sync::Mutex};
use tauri::Manager;

const REPOSITORY: &str = "https://github.com/baihejiangnan/copy-creator";
const UPDATE_METADATA: &str =
    "https://github.com/baihejiangnan/copy-creator/releases/latest/download/latest.json";
const MAX_METADATA_BYTES: usize = 1024 * 1024;
const AUTO_CHECK_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;

// One admission gate for both WebViews. Attempts stay local to the application
// identifier, outside user databases and backups.
pub struct UpdateState {
    checking: tokio::sync::Mutex<()>,
    checked: Mutex<Option<CheckedUpdate>>,
    pub(crate) prepared: Mutex<Option<PreparedUpdate>>,
    pub(crate) armed: Mutex<Option<PreparedUpdate>>,
    cancel: tokio::sync::watch::Sender<u64>,
}
impl Default for UpdateState {
    fn default() -> Self {
        Self {
            checking: Default::default(),
            checked: Default::default(),
            prepared: Default::default(),
            armed: Default::default(),
            cancel: tokio::sync::watch::channel(0).0,
        }
    }
}
pub(crate) async fn cancel_and_drain(app: &tauri::AppHandle) {
    let state = app.state::<UpdateState>();
    state
        .cancel
        .send_modify(|generation| *generation = generation.wrapping_add(1));
    let _idle = state.checking.lock().await;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    author: &'static str,
    license: &'static str,
    repository_url: &'static str,
    upstream_url: &'static str,
    releases_url: String,
}

#[tauri::command]
pub fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        name: "Copy Creator".into(),
        version: app.package_info().version.to_string(),
        author: "baihejiangnan",
        license: "MIT",
        repository_url: REPOSITORY,
        upstream_url: "https://github.com/hu-qi-jia/copy-creator",
        releases_url: format!("{REPOSITORY}/releases"),
    }
}

#[derive(Clone, Deserialize)]
struct UpdateMetadata {
    version: String,
    // Existing personal release tags differ from the compiled base version.
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    pub_date: String,
    #[serde(default)]
    platforms: HashMap<String, Artifact>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    status: &'static str,
    latest_version: Option<String>,
    release_url: Option<String>,
    notes: Option<String>,
    mode: &'static str,
    can_download: bool,
    download_error: Option<String>,
    asset_size: Option<u64>,
}

fn evaluate_metadata(current: &Version, metadata: UpdateMetadata) -> Result<UpdateResult, String> {
    let latest = Version::parse(metadata.version.trim().trim_start_matches(['v', 'V']))
        .map_err(|_| "updates.invalidRelease")?;
    chrono::DateTime::parse_from_rfc3339(&metadata.pub_date)
        .map_err(|_| "updates.invalidRelease")?;
    let tag = metadata.tag.unwrap_or_else(|| format!("v{latest}"));
    let tagged =
        Version::parse(tag.trim_start_matches(['v', 'V'])).map_err(|_| "updates.invalidRelease")?;
    let personal_prefix = format!("v{latest}-baihejiangnan.");
    let personal = latest.pre.is_empty()
        && tag
            .strip_prefix(&personal_prefix)
            .is_some_and(|suffix| suffix.parse::<u32>().is_ok_and(|number| number > 0));
    if (tagged != latest && !personal)
        || tag.contains(['/', '?', '#', '%', '\\'])
        || tag.chars().any(char::is_whitespace)
    {
        return Err("updates.invalidRelease".into());
    }
    Ok(UpdateResult {
        // Build metadata does not affect semantic version precedence.
        status: if latest.cmp_precedence(current).is_gt() {
            "available"
        } else {
            "upToDate"
        },
        latest_version: Some(latest.to_string()),
        release_url: Some(format!("{REPOSITORY}/releases/tag/{tag}")),
        notes: metadata.notes.filter(|notes| !notes.trim().is_empty()),
        mode: "unsupported",
        can_download: false,
        download_error: None,
        asset_size: None,
    })
}

fn parse_metadata(bytes: &[u8]) -> Result<UpdateMetadata, String> {
    if bytes.len() > MAX_METADATA_BYTES {
        return Err("updates.metadataTooLarge".into());
    }
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    serde_json::from_slice(bytes).map_err(|_| "updates.invalidRelease".into())
}

fn automatic_check_due(last_attempt: Option<u64>, now: u64) -> bool {
    // Clock rollback cannot disable automatic checks indefinitely.
    last_attempt.is_none_or(|last| last > now || now - last >= AUTO_CHECK_INTERVAL_MS)
}

fn require_same_package(checked: &CheckedUpdate, current: &CheckedUpdate) -> Result<(), String> {
    if current.version != checked.version
        || current.artifact != checked.artifact
        || current.mode != checked.mode
    {
        Err("updates.latestChanged".into())
    } else {
        Ok(())
    }
}

pub(crate) fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "updates.timeout"
    } else {
        "updates.networkError"
    }
    .into()
}

pub(crate) fn require_http_success(status: StatusCode, metadata: bool) -> Result<(), String> {
    match status {
        StatusCode::NOT_FOUND if metadata => Err("updates.metadataMissing".into()),
        StatusCode::FORBIDDEN | StatusCode::TOO_MANY_REQUESTS => Err("updates.rateLimited".into()),
        status if !status.is_success() => {
            Err(format!("updates.serverError|HTTP {}", status.as_u16()))
        }
        _ => Ok(()),
    }
}

fn network_client(app: &tauri::AppHandle, timeout: u64) -> Result<reqwest::Client, String> {
    // Both requests use this builder: explicit translation proxy if set,
    // otherwise reqwest's system/environment proxy detection. Never log it.
    let proxy = crate::db::get_setting_sync(app, "translate_proxy").unwrap_or_default();
    let mut builder = reqwest::Client::builder()
        .user_agent(format!("Copy-Creator/{}", app.package_info().version))
        .timeout(Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::limited(5))
        .https_only(true);
    if !proxy.trim().is_empty() {
        builder =
            builder.proxy(reqwest::Proxy::all(proxy.trim()).map_err(|_| "updates.proxyError")?);
    }
    builder.build().map_err(|_| "updates.networkError".into())
}

async fn fetch_metadata(
    client: &reqwest::Client,
    endpoint: &str,
) -> Result<UpdateMetadata, String> {
    let mut response = client.get(endpoint).send().await.map_err(network_error)?;
    require_http_success(response.status(), true)?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_METADATA_BYTES as u64)
    {
        return Err("updates.metadataTooLarge".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if chunk.len() > MAX_METADATA_BYTES - bytes.len() {
            return Err("updates.metadataTooLarge".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    parse_metadata(&bytes)
}

#[tauri::command]
pub async fn check_for_updates(
    app: tauri::AppHandle,
    automatic: Option<bool>,
) -> Result<Option<UpdateResult>, String> {
    let state = app.state::<UpdateState>();
    let _checking = state.checking.try_lock().map_err(|_| "updates.busy")?;
    crate::lifecycle::allow_write(&app)?;
    let mut cancel = state.cancel.subscribe();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "updates.checkError")?
        .as_millis() as u64;
    let attempt_path = app
        .path()
        .app_config_dir()
        .map_err(|_| "updates.checkError")?
        .join("update-check-attempt.json");
    let last_attempt = std::fs::File::open(&attempt_path).ok().and_then(|file| {
        use std::io::Read;
        let mut bytes = Vec::new();
        file.take(65).read_to_end(&mut bytes).ok()?;
        if bytes.len() > 64 {
            None
        } else {
            serde_json::from_slice::<u64>(&bytes).ok()
        }
    });
    if automatic == Some(true) && !automatic_check_due(last_attempt, now) {
        return Ok(None);
    }
    // Count failed attempts too. A write failure still permits manual checks.
    if let Some(parent) = attempt_path.parent() {
        if std::fs::create_dir_all(parent)
            .and_then(|_| std::fs::write(&attempt_path, now.to_string()))
            .is_err()
        {
            log::warn!("Could not persist update check attempt time");
        }
    }
    *state.checked.lock().map_err(|_| "updates.checkError")? = None;
    let client = network_client(&app, 15)?;
    let metadata = tokio::select! {
        result = fetch_metadata(&client, UPDATE_METADATA) => result?,
        _ = cancel.changed() => return Err("updates.cancelled".into()),
    };
    let mode = update_package::current_mode(&app);
    let package = select_package(&metadata, mode);
    let mut result = evaluate_metadata(&app.package_info().version, metadata)?;
    result.mode = mode;
    match package {
        Ok(package) => {
            result.can_download = result.status == "available";
            result.asset_size = package.artifact.size;
            *state.checked.lock().map_err(|_| "updates.checkError")? = Some(package);
        }
        Err(error) => result.download_error = Some(error),
    }
    Ok(Some(result))
}

fn select_package(metadata: &UpdateMetadata, mode: &'static str) -> Result<CheckedUpdate, String> {
    let version = Version::parse(metadata.version.trim().trim_start_matches(['v', 'V']))
        .map_err(|_| "updates.invalidRelease")?
        .to_string();
    let tag = metadata
        .tag
        .clone()
        .unwrap_or_else(|| format!("v{version}"));
    update_package::artifact_name(&version, mode)?;
    let key = if mode == "installed" {
        "windows-x86_64"
    } else {
        "windows-x86_64-portable"
    };
    let artifact = metadata
        .platforms
        .get(key)
        .ok_or("updates.packageMissing")?
        .clone();
    update_package::validate_artifact(&artifact, &version, &tag, mode)?;
    Ok(CheckedUpdate {
        version,
        mode,
        artifact,
    })
}

#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    expected_version: String,
    progress: tauri::ipc::Channel<update_package::DownloadProgress>,
) -> Result<update_package::DownloadedUpdate, String> {
    if window.label() != "main" {
        return Err("updates.platformUnsupported".into());
    }
    let state = app.state::<UpdateState>();
    let _checking = state.checking.try_lock().map_err(|_| "updates.busy")?;
    crate::lifecycle::allow_write(&app)?;
    let mut cancel = state.cancel.subscribe();
    let checked = state
        .checked
        .lock()
        .map_err(|_| "updates.checkError")?
        .clone()
        .ok_or("updates.downloadRequired")?;
    if checked.version != expected_version
        || !Version::parse(&expected_version)
            .map_err(|_| "updates.invalidRelease")?
            .cmp_precedence(&app.package_info().version)
            .is_gt()
    {
        return Err("updates.latestChanged".into());
    }
    let check_client = network_client(&app, 15)?;
    let metadata = tokio::select! {
        result = fetch_metadata(&check_client, UPDATE_METADATA) => result?,
        _ = cancel.changed() => return Err("updates.cancelled".into()),
    };
    // Validate tag/date as well as the exact package the user saw.
    evaluate_metadata(&app.package_info().version, metadata.clone())?;
    let current = select_package(&metadata, checked.mode)?;
    require_same_package(&checked, &current)?;
    let prepared = update_package::download(
        &app,
        &network_client(&app, 180)?,
        current,
        progress,
        &mut cancel,
    )
    .await?;
    let result = update_package::DownloadedUpdate {
        version: prepared.checked.version.clone(),
        mode: prepared.checked.mode,
        path: prepared.path.to_string_lossy().into_owned(),
    };
    *state.prepared.lock().map_err(|_| "updates.fileError")? = Some(prepared);
    Ok(result)
}

#[tauri::command]
pub fn launch_update(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    expected_version: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("updates.platformUnsupported".into());
    }
    let state = app.state::<UpdateState>();
    let _checking = state.checking.try_lock().map_err(|_| "updates.busy")?;
    let prepared = state.prepared.lock().map_err(|_| "updates.fileError")?;
    if prepared
        .as_ref()
        .is_none_or(|prepared| prepared.checked.version != expected_version)
    {
        return Err("updates.downloadRequired".into());
    }
    let prepared = prepared.clone().ok_or("updates.downloadRequired")?;
    crate::lifecycle::request_update(&app, prepared)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn metadata(version: &str) -> UpdateMetadata {
        UpdateMetadata {
            version: version.into(),
            tag: None,
            notes: Some("Release notes".into()),
            pub_date: "2026-10-09T00:00:00Z".into(),
            platforms: HashMap::new(),
        }
    }

    #[test]
    fn compares_semantic_versions_without_downgrading() {
        let current = Version::parse("0.2.24").unwrap();
        for (tag, expected) in [
            ("v0.2.25", "available"),
            ("v0.10.0", "available"),
            ("v0.2.24", "upToDate"),
            ("v0.2.9", "upToDate"),
            ("v0.2.24+build.2", "upToDate"),
            ("v0.2.24-baihejiangnan.1", "upToDate"),
            ("v0.2.25-baihejiangnan.1", "available"),
        ] {
            assert_eq!(
                evaluate_metadata(&current, metadata(tag)).unwrap().status,
                expected
            );
        }
        let preview = Version::parse("0.3.0-beta.1").unwrap();
        let installed = Version::parse("0.2.25").unwrap();
        assert_eq!(
            evaluate_metadata(&installed, metadata("v0.2.25-baihejiangnan.1"))
                .unwrap()
                .status,
            "upToDate"
        );
        assert_eq!(
            evaluate_metadata(&preview, metadata("v0.3.0"))
                .unwrap()
                .status,
            "available"
        );
    }

    #[test]
    fn rejects_malformed_versions_and_tags() {
        let current = Version::parse("0.2.24").unwrap();
        for tag in ["latest", "v0.3"] {
            assert!(evaluate_metadata(&current, metadata(tag)).is_err());
        }
        for tag in [
            "https://example.com/v0.3.0",
            "v0.3.0/other",
            "v0.3.0?x",
            "v0.3.0#x",
            "v0.3.0%2f",
            "v0.3.0 ",
            "v0.4.0",
        ] {
            let mut invalid = metadata("0.3.0");
            invalid.tag = Some(tag.into());
            assert!(evaluate_metadata(&current, invalid).is_err());
        }
    }

    #[test]
    fn metadata_accepts_bom_and_rejects_oversize_invalid_json_date_and_notes() {
        let plain = br#"{"version":"0.3.0","pub_date":"2026-10-09T00:00:00Z","notes":"test"}"#;
        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend_from_slice(plain);
        assert_eq!(
            parse_metadata(plain).unwrap().version,
            parse_metadata(&bom).unwrap().version
        );
        assert!(parse_metadata(&vec![b' '; MAX_METADATA_BYTES + 1]).is_err());
        for invalid in [
            b"{".as_slice(),
            b"\xff",
            br#"{"version":"0.3.0","pub_date":"x","notes":{}}"#,
        ] {
            assert!(parse_metadata(invalid).is_err());
        }
        let mut invalid = metadata("0.3.0");
        invalid.pub_date = "not-a-date".into();
        assert!(evaluate_metadata(&Version::parse("0.2.25").unwrap(), invalid).is_err());
    }

    #[test]
    fn base_version_and_personal_tag_are_independent() {
        let mut release = metadata("0.3.0");
        release.tag = Some("v0.3.0-baihejiangnan.1".into());
        let result = evaluate_metadata(&Version::parse("0.2.25").unwrap(), release).unwrap();
        assert_eq!(result.latest_version.as_deref(), Some("0.3.0"));
        assert_eq!(
            result.release_url.as_deref(),
            Some(
                "https://github.com/baihejiangnan/copy-creator/releases/tag/v0.3.0-baihejiangnan.1"
            )
        );
    }

    #[test]
    fn attempts_are_throttled_including_failures_and_clock_rollback() {
        let now = AUTO_CHECK_INTERVAL_MS * 2;
        assert!(automatic_check_due(None, now));
        assert!(!automatic_check_due(Some(now), now));
        assert!(!automatic_check_due(
            Some(now - AUTO_CHECK_INTERVAL_MS + 1),
            now
        ));
        assert!(automatic_check_due(Some(now - AUTO_CHECK_INTERVAL_MS), now));
        assert!(automatic_check_due(Some(now + 1), now));
    }

    #[test]
    fn latest_package_recheck_rejects_version_url_size_and_signature_changes() {
        let checked = CheckedUpdate {
            version: "0.3.0".into(),
            mode: "portable",
            artifact: Artifact {
                url: "fixed".into(),
                signature: "signature".into(),
                size: Some(1),
            },
        };
        assert!(require_same_package(&checked, &checked).is_ok());
        for field in ["version", "url", "size", "signature", "mode"] {
            let mut current = checked.clone();
            match field {
                "version" => current.version = "0.3.1".into(),
                "url" => current.artifact.url = "different".into(),
                "size" => current.artifact.size = Some(2),
                "signature" => current.artifact.signature = "different".into(),
                _ => current.mode = "installed",
            }
            assert_eq!(
                require_same_package(&checked, &current).unwrap_err(),
                "updates.latestChanged"
            );
        }
    }

    pub(crate) fn serve(response: Vec<u8>, delay_ms: u64) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut buffer = [0; 8192];
            let _ = stream.read(&mut buffer);
            std::thread::sleep(Duration::from_millis(delay_ms));
            let _ = stream.write_all(&response);
        });
        format!("http://{address}/fixture")
    }

    #[tokio::test]
    async fn metadata_transport_reports_http_timeout_interruptions_and_limits() {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        for (status, expected) in [
            (404, "updates.metadataMissing"),
            (429, "updates.rateLimited"),
            (503, "updates.serverError|HTTP 503"),
        ] {
            let endpoint = serve(
                format!("HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .into_bytes(),
                0,
            );
            assert_eq!(
                fetch_metadata(&client, &endpoint).await.err().unwrap(),
                expected
            );
        }
        let endpoint = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2000000\r\nConnection: close\r\n\r\n".to_vec(),
            0,
        );
        assert_eq!(
            fetch_metadata(&client, &endpoint).await.err().unwrap(),
            "updates.metadataTooLarge"
        );
        let mut response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        response.extend(vec![b' '; MAX_METADATA_BYTES + 1]);
        assert_eq!(
            fetch_metadata(&client, &serve(response, 0))
                .await
                .err()
                .unwrap(),
            "updates.metadataTooLarge"
        );
        let endpoint = serve(
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{".to_vec(),
            0,
        );
        assert_eq!(
            fetch_metadata(&client, &endpoint).await.err().unwrap(),
            "updates.networkError"
        );
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(20))
            .build()
            .unwrap();
        assert_eq!(
            fetch_metadata(&client, &serve(Vec::new(), 100))
                .await
                .err()
                .unwrap(),
            "updates.timeout"
        );
    }
}
