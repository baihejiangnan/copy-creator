//! Clipboard messages only wake the existing worker. No contents or unbounded queue.
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

const WATCHDOG: Duration = Duration::from_millis(800);

#[cfg(target_os = "linux")]
static GENERATION: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
#[cfg(target_os = "linux")]
static LISTENING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "linux")]
pub(crate) fn generation() -> Option<isize> {
    use std::sync::atomic::Ordering;
    LISTENING.load(Ordering::SeqCst).then(|| GENERATION.load(Ordering::SeqCst))
}

pub(crate) struct ClipboardWake(Option<Receiver<()>>);

impl ClipboardWake {
    pub(crate) fn new(_app: &tauri::AppHandle) -> Self {
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
        #[cfg(target_os = "linux")]
        {
            let (sender, receiver) = mpsc::sync_channel(1);
            if _app.run_on_main_thread(move || {
                use gtk::glib::prelude::ObjectExt;
                use std::sync::atomic::Ordering;
                let Some(display) = gtk::gdk::Display::default() else { return; };
                let Some(board) = gtk::Clipboard::default(&display) else { return; };
                // GTK forwards native selection-owner changes. The callback
                // never reads contents, acquires storage locks, or blocks the UI.
                board.connect_local("owner-change", false, move |_| {
                    GENERATION.fetch_add(1, Ordering::SeqCst);
                    let _ = sender.try_send(());
                    None
                });
                LISTENING.store(true, Ordering::SeqCst);
            }).is_ok() {
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
