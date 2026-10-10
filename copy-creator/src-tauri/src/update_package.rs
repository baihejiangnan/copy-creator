//! Signed Windows packages; paths and trust never come from the WebView.
use crate::update_signature::{decode_signature, verify_file, MAX_UPDATE_BYTES};
use serde::{Deserialize, Serialize};
use std::{ffi::{OsStr, OsString}, io::Write, path::{Path, PathBuf}, time::Duration};
use tauri::Manager;

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Artifact {
    pub url: String,
    #[serde(default)]
    pub signature: String,
    pub size: Option<u64>,
}
#[derive(Clone)]
pub struct CheckedUpdate {
    pub version: String,
    pub mode: &'static str,
    pub artifact: Artifact,
}
#[derive(Clone)]
pub struct PreparedUpdate {
    pub checked: CheckedUpdate,
    pub path: PathBuf,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedUpdate {
    pub version: String,
    pub mode: &'static str,
    pub path: String,
}
#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

pub fn current_mode(app: &tauri::AppHandle) -> &'static str {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        use winreg::{
            enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY},
            RegKey,
        };
        let Ok(exe) = std::env::current_exe().and_then(std::fs::canonicalize) else {
            return "unsupported";
        };
        // Written and removed by the MSI component, including custom install
        // directories. A copied portable EXE does not inherit installed mode.
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            if let Ok(key) = RegKey::predef(hive).open_subkey_with_flags(
                format!("Software\\{}\\Update", app.config().identifier),
                KEY_READ | KEY_WOW64_64KEY,
            ) {
                if let Ok(path) = key.get_value::<String, _>("ExecutablePath") {
                    if std::fs::canonicalize(path).is_ok_and(|installed| {
                        installed
                            .to_string_lossy()
                            .eq_ignore_ascii_case(&exe.to_string_lossy())
                    }) {
                        return "installed";
                    }
                }
            }
        }
        // Existing NSIS installs have no MSI upgrade contract. Do not silently
        // install a second product or guess from Program Files/writability.
        if exe
            .parent()
            .is_some_and(|dir| dir.join("uninstall.exe").is_file())
        {
            return "nsis";
        }
        "portable"
    }
    #[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
    {
        let _ = app;
        "unsupported"
    }
}

pub fn artifact_name(version: &str, mode: &str) -> Result<String, String> {
    match mode {
        "portable" | "installed" => Ok(format!("Copy-Creator_{version}_x64.msi")),
        "nsis" => Err("updates.installerUnsupported".into()),
        _ => Err("updates.platformUnsupported".into()),
    }
}

pub fn validate_artifact(
    artifact: &Artifact,
    version: &str,
    tag: &str,
    mode: &str,
) -> Result<(), String> {
    let name = artifact_name(version, mode)?;
    let expected =
        format!("https://github.com/baihejiangnan/copy-creator/releases/download/{tag}/{name}");
    // Exact equality rejects foreign repositories, credentials, queries,
    // fragments, encoded paths, and swapping the two platform signatures.
    if artifact.url != expected {
        return Err("updates.invalidAsset".into());
    }
    if artifact
        .size
        .is_some_and(|size| size == 0 || size > MAX_UPDATE_BYTES)
    {
        return Err("updates.packageTooLarge".into());
    }
    decode_signature(&artifact.signature)?;
    Ok(())
}

fn destination(app: &tauri::AppHandle, checked: &CheckedUpdate) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|_| "updates.fileError")?
        .join("updates")
        .join(artifact_name(&checked.version, checked.mode)?))
}

// msiexec parses PROPERTY="value with spaces", not the CRT form
// "PROPERTY=value with spaces" produced by Command::args. Paths and values
// below are native-owned; reject delimiters instead of accepting raw syntax.
fn msi_quoted_value(value: &OsStr) -> Result<OsString, String> {
    if value.to_string_lossy().contains(['"', '\0', '\r', '\n']) {
        return Err("updates.launchError".into());
    }
    let mut quoted = OsString::from("\"");
    quoted.push(value);
    quoted.push("\"");
    Ok(quoted)
}

fn msi_install_arguments(
    package: &Path,
    mode: &str,
    current_exe: &Path,
    parent_pid: u32,
) -> Result<Vec<OsString>, String> {
    match mode {
        "portable" | "installed" => {}
        "nsis" => return Err("updates.installerUnsupported".into()),
        _ => return Err("updates.platformUnsupported".into()),
    }
    let mut args = vec![
        OsString::from("/i"),
        msi_quoted_value(package.as_os_str())?,
        OsString::from("/norestart"),
        OsString::from(format!("LAUNCHAPPARGS=\"--copy-creator-update-parent {parent_pid}\"")),
    ];
    if mode == "installed" {
        // The registry marker already proved this is the installed executable.
        // Preserve its directory even when the MSI's default registry search
        // cannot find an installation owned by a different installer context.
        let directory = current_exe.parent().ok_or("updates.launchError")?;
        let mut install_dir = OsString::from("INSTALLDIR=");
        install_dir.push(msi_quoted_value(directory.as_os_str())?);
        args.extend([OsString::from("/passive"), install_dir, OsString::from("AUTOLAUNCHAPP=1")]);
    }
    // First installation from a portable EXE retains the directory-selection
    // wizard and its default launch checkbox (no second automatic launch).
    // The MSI's launch action starts the installed executable, never
    // a newly downloaded portable EXE.
    Ok(args)
}

#[cfg(target_os = "windows")]
fn msi_install_command(
    program: &Path,
    package: &Path,
    mode: &str,
    current_exe: &Path,
    parent_pid: u32,
) -> Result<std::process::Command, String> {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new(program);
    for argument in msi_install_arguments(package, mode, current_exe, parent_pid)? {
        command.raw_arg(argument);
    }
    command.creation_flags(0x08000000);
    Ok(command)
}

pub async fn download(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    checked: CheckedUpdate,
    progress: tauri::ipc::Channel<DownloadProgress>,
    cancel: &mut tokio::sync::watch::Receiver<u64>,
) -> Result<PreparedUpdate, String> {
    let path = destination(app, &checked)?;
    download_to_path(client, checked, path, progress, cancel).await
}

pub(crate) async fn download_to_path(
    client: &reqwest::Client,
    checked: CheckedUpdate,
    path: PathBuf,
    progress: tauri::ipc::Channel<DownloadProgress>,
    cancel: &mut tokio::sync::watch::Receiver<u64>,
) -> Result<PreparedUpdate, String> {
    if path.exists() {
        let existing_path = path.clone();
        let artifact = checked.artifact.clone();
        tauri::async_runtime::spawn_blocking(move || {
            verify_file(&existing_path, &artifact.signature, artifact.size)
        })
        .await
        .map_err(|_| "updates.fileError")?
        .map_err(|_| "updates.fileExists")?;
        return Ok(PreparedUpdate { checked, path });
    }
    let parent = path.parent().ok_or("updates.fileError")?;
    std::fs::create_dir_all(parent).map_err(|_| "updates.fileError")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| "updates.fileError")?;
    let mut response = tokio::select! {
        result = client.get(&checked.artifact.url).send() => result.map_err(super::updates::network_error)?,
        _ = cancel.changed() => return Err("updates.cancelled".into()),
    };
    super::updates::require_http_success(response.status(), false)?;
    let declared = response.content_length();
    if declared.is_some_and(|size| size == 0 || size > MAX_UPDATE_BYTES) {
        return Err("updates.packageTooLarge".into());
    }
    if let (Some(header), Some(size)) = (declared, checked.artifact.size) {
        if header != size {
            return Err("updates.sizeMismatch".into());
        }
    }
    let total = checked.artifact.size.or(declared);
    let mut downloaded = 0u64;
    let mut last_progress = std::time::Instant::now();
    let _ = progress.send(DownloadProgress { downloaded, total });
    loop {
        let chunk = tokio::select! {
            result = response.chunk() => result.map_err(super::updates::network_error)?,
            _ = cancel.changed() => return Err("updates.cancelled".into()),
        };
        let Some(chunk) = chunk else {
            break;
        };
        downloaded = downloaded
            .checked_add(chunk.len() as u64)
            .ok_or("updates.packageTooLarge")?;
        if downloaded > MAX_UPDATE_BYTES {
            return Err("updates.packageTooLarge".into());
        }
        if total.is_some_and(|size| downloaded > size) {
            return Err("updates.sizeMismatch".into());
        }
        temporary
            .write_all(&chunk)
            .map_err(|_| "updates.fileError")?;
        if last_progress.elapsed() >= Duration::from_millis(100) {
            let _ = progress.send(DownloadProgress { downloaded, total });
            last_progress = std::time::Instant::now();
        }
    }
    if total.is_some_and(|size| downloaded != size) {
        return Err("updates.sizeMismatch".into());
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| "updates.fileError")?;
    // Close the writable handle before reopening with Windows deny-write
    // sharing. Keep the TempPath guard for cleanup on verification failure.
    let temporary = temporary.into_temp_path();
    let artifact = checked.artifact.clone();
    // Verification and final persistence run off the async worker. The
    // tempfile guard removes incomplete or failed packages on every error.
    let path_copy = path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        drop(verify_file(&temporary, &artifact.signature, artifact.size)?);
        temporary
            .persist_noclobber(&path_copy)
            .map_err(|_| "updates.fileExists")?;
        Ok(())
    })
    .await
    .map_err(|_| "updates.fileError")??;
    let _ = progress.send(DownloadProgress {
        downloaded,
        total: Some(downloaded),
    });
    Ok(PreparedUpdate { checked, path })
}

pub fn launch_verified(app: &tauri::AppHandle) -> Result<(), String> {
    let prepared = app
        .state::<super::updates::UpdateState>()
        .armed
        .lock()
        .map_err(|_| "updates.fileError")?
        .clone()
        .ok_or("updates.downloadRequired")?;
    if current_mode(app) != prepared.checked.mode {
        return Err("updates.platformUnsupported".into());
    }
    let _file = verify_file(
        &prepared.path,
        &prepared.checked.artifact.signature,
        prepared.checked.artifact.size,
    )?;
    #[cfg(target_os = "windows")]
    {
        let system = std::env::var_os("SystemRoot").ok_or("updates.launchError")?;
        let exe = std::env::current_exe().map_err(|_| "updates.launchError")?;
        msi_install_command(&PathBuf::from(system).join("System32/msiexec.exe"),
            &prepared.path, prepared.checked.mode, &exe, std::process::id())?
            .spawn()
            .map_err(|_| "updates.launchError")?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("updates.platformUnsupported".into())
    }
}

pub fn wait_for_update_parent() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--copy-creator-update-parent" {
            let pid = args.next().and_then(|arg| arg.to_str().and_then(|arg| arg.parse::<u32>().ok()))
                .filter(|pid| *pid != 0 && *pid != std::process::id())
                .ok_or("updates.launchError")?;
            #[cfg(target_os = "windows")]
            return wait_for_process(pid, 30_000);
            #[cfg(not(target_os = "windows"))]
            { let _ = pid; return Err("updates.platformUnsupported".into()); }
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn wait_for_process(pid: u32, timeout_ms: u32) -> Result<(), String> {
    use windows::Win32::{Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}};
    let handle = match unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
        Ok(handle) => handle,
        // The predecessor may already have exited before the child starts.
        Err(error) if error.code() == windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0) => return Ok(()),
        Err(_) => return Err("updates.launchError".into()),
    };
    let result = unsafe { WaitForSingleObject(handle, timeout_ms) };
    let _ = unsafe { CloseHandle(handle) };
    if result == WAIT_OBJECT_0 { Ok(()) } else { Err("updates.launchError".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    const DATA: &[u8] = include_bytes!("../tests/fixtures/update-package.txt");
    const SIGNATURE: &str = include_str!("../tests/fixtures/update-package.txt.sig");

    #[cfg(target_os = "windows")]
    #[test]
    fn installed_upgrade_preserves_directory_and_relaunches_after_parent_exit() {
        let args = msi_install_arguments(
            Path::new(r"C:\缓存\updates\new.msi"), "installed",
            Path::new(r"D:\自定义目录\Copy Creator\copy-creator.exe"), 1234,
        ).unwrap();
        assert_eq!(args, [
            "/i", r#""C:\缓存\updates\new.msi""#, "/norestart",
            "LAUNCHAPPARGS=\"--copy-creator-update-parent 1234\"", "/passive",
            r#"INSTALLDIR="D:\自定义目录\Copy Creator""#, "AUTOLAUNCHAPP=1",
        ].map(OsString::from));
    }

    #[test]
    fn portable_transition_uses_first_install_wizard_without_duplicate_launch() {
        let args = msi_install_arguments(Path::new("new.msi"), "portable", Path::new("old.exe"), 42).unwrap();
        assert_eq!(args, ["/i", "\"new.msi\"", "/norestart", "LAUNCHAPPARGS=\"--copy-creator-update-parent 42\""].map(OsString::from));
        for (mode, error) in [("nsis", "updates.installerUnsupported"), ("unsupported", "updates.platformUnsupported")] {
            assert_eq!(msi_install_arguments(Path::new("new.msi"), mode, Path::new("old.exe"), 42).unwrap_err(), error);
        }
    }

    #[test]
    fn msi_values_reject_command_line_delimiters() {
        for invalid in ["bad\"path", "bad\0path", "bad\rpath", "bad\npath"] {
            assert_eq!(msi_quoted_value(OsStr::new(invalid)).unwrap_err(), "updates.launchError");
            assert_eq!(msi_install_arguments(Path::new(invalid), "portable", Path::new("old.exe"), 42).unwrap_err(), "updates.launchError");
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn msi_command_preserves_value_quotes_in_actual_windows_command_line() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("合成 command capture");
        std::fs::create_dir(&directory).unwrap();
        let program = directory.join("capture.exe");
        let build = std::process::Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()))
            .args(["--edition=2021", "--crate-name", "windows_command_line"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/windows-command-line.rs"))
            .arg("-o").arg(&program).output().unwrap();
        assert!(build.status.success(), "{}", String::from_utf8_lossy(&build.stderr));
        for (mode, exe, expected) in [
            ("portable", r"D:\旧便携\old.exe",
                r#" /i "C:\合成 缓存\update.msi" /norestart LAUNCHAPPARGS="--copy-creator-update-parent 42""#),
            ("installed", r"D:\自定义 目录\Copy Creator\old.exe",
                r#" /i "C:\合成 缓存\update.msi" /norestart LAUNCHAPPARGS="--copy-creator-update-parent 42" /passive INSTALLDIR="D:\自定义 目录\Copy Creator" AUTOLAUNCHAPP=1"#),
            ("installed", r"D:\old.exe",
                r#" /i "C:\合成 缓存\update.msi" /norestart LAUNCHAPPARGS="--copy-creator-update-parent 42" /passive INSTALLDIR="D:\" AUTOLAUNCHAPP=1"#),
        ] {
            let output = msi_install_command(&program, Path::new(r"C:\合成 缓存\update.msi"), mode, Path::new(exe), 42)
                .unwrap().output().unwrap();
            assert!(output.status.success());
            let units: Vec<u16> = serde_json::from_slice(&output.stdout).unwrap();
            let raw = String::from_utf16(&units).unwrap();
            assert!(raw.ends_with(expected), "{mode}: actual raw command line: {raw}");
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "requires Windows Installer service access from the native test executable; run explicitly in isolated desktop QA"]
    fn real_msiexec_accepts_quoted_properties_without_installing_a_package() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("合成 missing package.msi");
        assert!(!missing.exists());
        let system = std::env::var_os("SystemRoot").unwrap();
        for mode in ["portable", "installed"] {
            let mut child = msi_install_command(&PathBuf::from(&system).join("System32/msiexec.exe"),
                &missing, mode, Path::new(r"D:\合成 目录\old.exe"), 42).unwrap()
                .arg("/qn").spawn().unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let status = loop {
                if let Some(status) = child.try_wait().unwrap() { break status; }
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill(); let _ = child.wait();
                    panic!("{mode}: msiexec did not reject the nonexistent synthetic package in time");
                }
                std::thread::sleep(Duration::from_millis(20));
            };
            // 1619: command line parsed, package could not be opened. The
            // nonexistent file guarantees no installation/registry mutation.
            assert_eq!(status.code(), Some(1619), "{mode}");
        }
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn portable_successor_waits_for_predecessor_and_rejects_timeout() {
        use std::os::windows::process::CommandExt;
        let mut child = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 150"])
            .creation_flags(0x08000000).spawn().unwrap();
        let timeout = wait_for_process(child.id(), 0);
        let completed = wait_for_process(child.id(), 10_000);
        let _ = child.kill(); let _ = child.wait();
        assert_eq!(timeout.unwrap_err(), "updates.launchError");
        completed.unwrap();
    }
    fn checked(mode: &'static str) -> CheckedUpdate {
        CheckedUpdate {version:"0.3.0".into(),mode,artifact:Artifact {
            url:format!("https://github.com/baihejiangnan/copy-creator/releases/download/v0.3.0-baihejiangnan.1/{}",artifact_name("0.3.0",mode).unwrap()),
            signature:SIGNATURE.into(),size:Some(DATA.len() as u64),
        }}
    }

    #[test]
    fn msi_packages_require_exact_repository_tag_and_filename() {
        for mode in ["installed", "portable"] {
            let good = checked(mode);
            validate_artifact(
                &good.artifact,
                &good.version,
                "v0.3.0-baihejiangnan.1",
                mode,
            )
            .unwrap();
            for url in [
                good.artifact.url.replace("github.com", "example.com"),
                good.artifact.url.clone() + "?x",
                good.artifact
                    .url
                    .replace("v0.3.0-baihejiangnan.1", "v0.3.1"),
                good.artifact.url.replace("Copy-Creator_0.3.0_x64.msi", "Copy-Creator-0.3.0-portable.exe"),
            ] {
                let mut bad = good.artifact.clone();
                bad.url = url;
                assert_eq!(
                    validate_artifact(&bad, &good.version, "v0.3.0-baihejiangnan.1", mode)
                        .unwrap_err(),
                    "updates.invalidAsset"
                );
            }
            let mut bad = good.artifact.clone();
            bad.signature.clear();
            assert_eq!(
                validate_artifact(&bad, &good.version, "v0.3.0-baihejiangnan.1", mode).unwrap_err(),
                "updates.signatureMissing"
            );
            bad.signature = "broken".into();
            assert!(
                validate_artifact(&bad, &good.version, "v0.3.0-baihejiangnan.1", mode).is_err()
            );
            bad = good.artifact.clone();
            bad.size = Some(MAX_UPDATE_BYTES + 1);
            assert!(
                validate_artifact(&bad, &good.version, "v0.3.0-baihejiangnan.1", mode).is_err()
            );
        }
        assert!(artifact_name("0.3.0", "nsis").is_err());
        assert!(artifact_name("0.3.0", "unsupported").is_err());
    }

    #[test]
    fn actual_client_verifier_accepts_signed_bytes_rejects_tampering_and_size_mismatch() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("fixture");
        std::fs::write(&path, DATA).unwrap();
        drop(verify_file(&path, SIGNATURE, Some(DATA.len() as u64)).unwrap());
        assert_eq!(
            verify_file(&path, SIGNATURE, Some(1)).err().unwrap(),
            "updates.sizeMismatch"
        );
        let mut bad = DATA.to_vec();
        bad[0] ^= 1;
        std::fs::write(&path, bad).unwrap();
        assert_eq!(
            verify_file(&path, SIGNATURE, None).err().unwrap(),
            "updates.signatureInvalid"
        );
    }

    fn response(data: &[u8], length: u64) -> Vec<u8> {
        let mut response =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n")
                .into_bytes();
        response.extend_from_slice(data);
        response
    }
    #[tokio::test]
    async fn download_verifies_then_persists_and_reuses_valid_file_without_overwrite() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("new.exe");
        let mut checked = checked("portable");
        checked.artifact.url = crate::updates::tests::serve(response(DATA, DATA.len() as u64), 0);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let (_send, mut cancel) = tokio::sync::watch::channel(0);
        let progress = || tauri::ipc::Channel::new(|_| Ok(()));
        download_to_path(
            &client,
            checked.clone(),
            path.clone(),
            progress(),
            &mut cancel,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), DATA);
        checked.artifact.url = "http://127.0.0.1:9".into();
        download_to_path(&client, checked, path.clone(), progress(), &mut cancel)
            .await
            .unwrap();
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn bad_size_signature_transport_and_cancellation_leave_no_package_or_tempfile() {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        for kind in ["signature", "size", "interrupted", "oversize", "cancel"] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("new.exe");
            let mut checked = checked("portable");
            let (send, mut cancel) = tokio::sync::watch::channel(0);
            let mut data = DATA.to_vec();
            if kind == "signature" {
                data[0] ^= 1;
            }
            let length = if kind == "size" {
                data.len() as u64 + 1
            } else if kind == "oversize" {
                MAX_UPDATE_BYTES + 1
            } else {
                data.len() as u64
            };
            if kind == "interrupted" {
                data.truncate(1);
            }
            checked.artifact.url = crate::updates::tests::serve(
                response(&data, length),
                if kind == "cancel" { 100 } else { 0 },
            );
            if kind == "cancel" {
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    send.send(1).unwrap();
                });
            }
            let error = download_to_path(
                &client,
                checked,
                path.clone(),
                tauri::ipc::Channel::new(|_| Ok(())),
                &mut cancel,
            )
            .await
            .err()
            .unwrap();
            assert_eq!(
                error,
                match kind {
                    "signature" => "updates.signatureInvalid",
                    "size" => "updates.sizeMismatch",
                    "interrupted" => "updates.networkError",
                    "oversize" => "updates.packageTooLarge",
                    _ => "updates.cancelled",
                }
            );
            assert!(!path.exists());
            assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        }
    }
}
