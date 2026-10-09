//! Clipboard messages only wake the existing worker. No contents or unbounded queue.
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

const WATCHDOG: Duration = Duration::from_millis(800);

pub(crate) struct ClipboardWake(Option<Receiver<()>>);

impl ClipboardWake {
    pub(crate) fn new() -> Self {
        #[cfg(target_os = "windows")]
        {
            let (sender, receiver) = mpsc::sync_channel(1);
            if std::thread::Builder::new()
                .name("clipboard-events".into())
                .spawn(move || {
                    if let Err(error) = windows_listener::run(sender) {
                        log::warn!("clipboard event listener unavailable; using watchdog: {error}");
                    }
                })
                .is_ok()
            {
                return Self(Some(receiver));
            }
        }
        Self(None)
    }

    pub(crate) fn wait(&mut self) {
        if let Some(receiver) = &self.0 {
            match receiver.recv_timeout(WATCHDOG) {
                Ok(()) | Err(RecvTimeoutError::Timeout) => return,
                // Registration/pump failure must not cause a disconnected-channel spin.
                Err(RecvTimeoutError::Disconnected) => self.0 = None,
            }
        }
        std::thread::sleep(WATCHDOG);
    }
}

#[cfg(target_os = "windows")]
mod windows_listener {
    use std::{cell::RefCell, sync::mpsc::SyncSender};
    use windows::{
        core::w,
        Win32::{
            Foundation::{HWND, LPARAM, LRESULT, WPARAM},
            System::{
                DataExchange::{AddClipboardFormatListener, RemoveClipboardFormatListener},
                LibraryLoader::GetModuleHandleW,
            },
            UI::WindowsAndMessaging::*,
        },
    };

    thread_local! { static WAKE: RefCell<Option<SyncSender<()>>> = const { RefCell::new(None) }; }

    unsafe extern "system" fn procedure(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if message == WM_CLIPBOARDUPDATE {
            WAKE.with(|wake| {
                if let Some(sender) = wake.borrow().as_ref() {
                    let _ = sender.try_send(());
                }
            });
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, message, wparam, lparam)
    }

    pub(super) fn run(sender: SyncSender<()>) -> windows::core::Result<()> {
        unsafe {
            let instance = GetModuleHandleW(None)?.into();
            let class = w!("CopyCreatorClipboardWake");
            let definition = WNDCLASSW {
                lpfnWndProc: Some(procedure),
                hInstance: instance,
                lpszClassName: class,
                ..Default::default()
            };
            if RegisterClassW(&definition) == 0 {
                return Err(windows::core::Error::from_win32());
            }
            let result = (|| {
                // Message-only window: no focus, taskbar entry or extra WebView.
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    class,
                    w!(""),
                    WINDOW_STYLE::default(),
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    None,
                    instance,
                    None,
                )?;
                let result = (|| {
                    AddClipboardFormatListener(hwnd)?;
                    WAKE.with(|wake| *wake.borrow_mut() = Some(sender));
                    let mut message = MSG::default();
                    let result = loop {
                        let received = GetMessageW(&mut message, None, 0, 0).0;
                        if received == -1 {
                            break Err(windows::core::Error::from_win32());
                        }
                        if received == 0 {
                            break Ok(());
                        }
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    };
                    let _ = RemoveClipboardFormatListener(hwnd);
                    WAKE.with(|wake| *wake.borrow_mut() = None);
                    result
                })();
                let _ = DestroyWindow(hwnd);
                result
            })();
            let _ = UnregisterClassW(class, instance);
            result
        }
    }
}
