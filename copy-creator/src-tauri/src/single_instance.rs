//! Windows single instance per user, interactive session and application identifier.
//! The kernel lock is acquired before Tauri initialization. A single auto-reset
//! event retains a manual launch during startup without storing arguments/content.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::Manager;
use windows::{
    core::{PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, HANDLE, HLOCAL,
            WAIT_OBJECT_0,
        },
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                SDDL_REVISION_1,
            },
            GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
            TOKEN_USER,
        },
        System::Threading::{
            CreateEventW, CreateMutexW, GetCurrentProcess, OpenProcessToken, SetEvent,
            WaitForSingleObject,
        },
        UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY},
    },
};

struct OwnedHandle(HANDLE);
// Kernel handles are process-wide. This wrapper only waits/signals/closes them;
// it never owns a thread-affine mutex (CreateMutexW uses initial_owner=false).
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

struct LocalAllocation(*mut core::ffi::c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            let _ = LocalFree(HLOCAL(self.0));
        }
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn user_sid() -> windows::core::Result<String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)?;
        let token = OwnedHandle(token);
        let mut length = 0;
        let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut length);
        if length == 0 {
            return Err(windows::core::Error::from_win32());
        }
        // TOKEN_USER contains pointers; keep the returned buffer pointer-aligned.
        let mut buffer = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
        GetTokenInformation(
            token.0,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            length,
            &mut length,
        )?;
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        let mut sid = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut sid)?;
        let _allocation = LocalAllocation(sid.0.cast());
        Ok(sid.to_string()?)
    }
}

pub(crate) struct Instance {
    lock: Mutex<Option<OwnedHandle>>,
    wake: Arc<OwnedHandle>,
}

impl Instance {
    /// None means an existing instance owns the lock, even if it is still starting.
    pub(crate) fn acquire(identifier: &str, activate: bool) -> windows::core::Result<Option<Self>> {
        use sha2::{Digest, Sha256};
        let sid = user_sid()?;
        let digest = format!("{:x}", Sha256::digest(format!("{sid}\0{identifier}")));
        // Local namespaces distinguish logon sessions. SID distinguishes users;
        // identifier distinguishes QA from production, independently of path/version.
        let event_name = wide(&format!("Local\\CopyCreator-{digest}-wake"));
        let lock_name = wide(&format!("Local\\CopyCreator-{digest}-instance"));
        // Permit only this Windows user. Preserve Windows integrity protection;
        // denied IPC must fail closed, never fall through to a second instance.
        // No command or credential is exchanged.
        let sddl = wide(&format!("D:(A;;GA;;;{sid})"));
        unsafe {
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )?;
            let _allocation = LocalAllocation(descriptor.0);
            let attributes = SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: false.into(),
            };
            // Create/open the event first: a concurrent secondary can signal it
            // before the owner has installed its listener. Signals coalesce.
            let wake = OwnedHandle(CreateEventW(
                Some(&attributes),
                false,
                false,
                PCWSTR(event_name.as_ptr()),
            )?);
            let lock = OwnedHandle(CreateMutexW(
                Some(&attributes),
                false,
                PCWSTR(lock_name.as_ptr()),
            )?);
            let exists = GetLastError() == ERROR_ALREADY_EXISTS;
            if exists {
                if activate {
                    // Transfer the launcher input permission, as in the existing
                    // shortcut path. Windows may revoke it on subsequent input.
                    let _ = AllowSetForegroundWindow(ASFW_ANY);
                    SetEvent(wake.0)?;
                }
                return Ok(None);
            }
            Ok(Some(Self {
                lock: Mutex::new(Some(lock)),
                wake: Arc::new(wake),
            }))
        }
    }

    pub(crate) fn listen(&self, app: &tauri::AppHandle) -> std::io::Result<()> {
        let wake = self.wake.clone();
        let app = app.clone();
        std::thread::Builder::new()
            .name("instance-activation".into())
            .spawn(move || {
                let queued = Arc::new(AtomicBool::new(false));
                loop {
                    // One sleeping worker; no polling, unbounded argument queue or
                    // blocking SendMessage to a stalled WebView/main thread.
                    if unsafe { WaitForSingleObject(wake.0, u32::MAX) } != WAIT_OBJECT_0 {
                        break;
                    }
                    if queued.swap(true, Ordering::SeqCst) {
                        continue;
                    }
                    let activated = app.clone();
                    let done = queued.clone();
                    if app
                        .run_on_main_thread(move || {
                            if let Some(window) = activated.get_webview_window("main") {
                                // Always show, never toggle/hide an already-visible app.
                                crate::paste::save_foreground_window();
                                let _ = window.unminimize();
                                let _ = crate::lifecycle::show_main(&window);
                                let _ = window.set_focus();
                            }
                            done.store(false, Ordering::SeqCst);
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            })?;
        Ok(())
    }

    pub(crate) fn release_for_restart(&self) {
        // Called only on the main thread after the approved save/drain barrier.
        if let Ok(mut lock) = self.lock.lock() {
            lock.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use windows::Win32::Foundation::WAIT_TIMEOUT;

    fn id() -> String {
        format!("com.copycreator.test.{}", uuid::Uuid::new_v4())
    }
    fn secondary(identifier: &str, activate: bool) -> std::process::Child {
        Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "single_instance::tests::secondary_process",
                "--ignored",
            ])
            .env("COPY_CREATOR_TEST_INSTANCE", identifier)
            .env(
                "COPY_CREATOR_TEST_ACTIVATE",
                if activate { "1" } else { "0" },
            )
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    fn finish(child: &mut std::process::Child) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                return;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("secondary exceeded its exit deadline");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    // Dedicated subprocess fixture; it never creates a Tauri app or reads storage/clipboard.
    #[test]
    #[ignore = "subprocess fixture invoked by single-instance tests"]
    fn secondary_process() {
        let identifier = std::env::var("COPY_CREATOR_TEST_INSTANCE").unwrap();
        if let Ok(marker) = std::env::var("COPY_CREATOR_TEST_HOLDER") {
            let _owner = Instance::acquire(&identifier, false).unwrap().unwrap();
            std::fs::write(marker, "ready").unwrap();
            let mut line = String::new();
            std::io::stdin().read_line(&mut line).unwrap();
            return;
        }
        assert!(Instance::acquire(
            &identifier,
            std::env::var("COPY_CREATOR_TEST_ACTIVATE").unwrap() == "1"
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn secondary_launch_signals_owner_before_listener_is_ready() {
        let identifier = id();
        let owner = Instance::acquire(&identifier, false).unwrap().unwrap();
        finish(&mut secondary(&identifier, true));
        assert_eq!(
            unsafe { WaitForSingleObject(owner.wake.0, 0) },
            WAIT_OBJECT_0
        );
        assert_eq!(
            unsafe { WaitForSingleObject(owner.wake.0, 0) },
            WAIT_TIMEOUT
        );
    }

    #[test]
    fn hidden_secondary_never_activates_owner() {
        let identifier = id();
        let owner = Instance::acquire(&identifier, false).unwrap().unwrap();
        finish(&mut secondary(&identifier, false));
        assert_eq!(
            unsafe { WaitForSingleObject(owner.wake.0, 0) },
            WAIT_TIMEOUT
        );
    }

    #[test]
    fn simultaneous_secondary_launches_keep_one_owner_and_coalesce_signals() {
        let identifier = id();
        let owner = Instance::acquire(&identifier, false).unwrap().unwrap();
        let mut children: Vec<_> = (0..12).map(|_| secondary(&identifier, true)).collect();
        for child in &mut children {
            finish(child);
        }
        assert_eq!(
            unsafe { WaitForSingleObject(owner.wake.0, 0) },
            WAIT_OBJECT_0
        );
        assert_eq!(
            unsafe { WaitForSingleObject(owner.wake.0, 0) },
            WAIT_TIMEOUT
        );
        assert!(Instance::acquire(&identifier, false).unwrap().is_none());
    }

    #[test]
    fn different_identifiers_and_owner_exit_allow_independent_startup() {
        let identifier = id();
        let owner = Instance::acquire(&identifier, false).unwrap().unwrap();
        let other = Instance::acquire(&id(), false).unwrap().unwrap();
        assert!(Instance::acquire(&identifier, false).unwrap().is_none());
        drop(owner);
        assert!(Instance::acquire(&identifier, false).unwrap().is_some());
        drop(other);
    }

    #[test]
    fn approved_restart_releases_lock_while_parent_is_still_alive() {
        let identifier = id();
        let owner = Instance::acquire(&identifier, false).unwrap().unwrap();
        owner.release_for_restart();
        let successor = Instance::acquire(&identifier, false).unwrap().unwrap();
        assert!(Instance::acquire(&identifier, false).unwrap().is_none());
        drop(owner);
        assert!(Instance::acquire(&identifier, false).unwrap().is_none());
        drop(successor);
    }

    #[test]
    fn abrupt_owner_exit_releases_kernel_lock() {
        let identifier = id();
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("owner-ready");
        // Ensure even a failed assertion cannot leave a fixture process alive.
        struct Holder(std::process::Child);
        impl Drop for Holder {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut child = Holder(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "single_instance::tests::secondary_process",
                    "--ignored",
                ])
                .env("COPY_CREATOR_TEST_INSTANCE", &identifier)
                .env("COPY_CREATOR_TEST_HOLDER", &marker)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !marker.exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "owner fixture exited before readiness"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "owner readiness deadline exceeded"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(Instance::acquire(&identifier, false).unwrap().is_none());
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        assert!(Instance::acquire(&identifier, false).unwrap().is_some());
    }
}
