//! Native file lists. URI parsing never opens a URL or accesses external files.
const MAX_FILES: usize = 512;
const MAX_BYTES: usize = 1024 * 1024;
const MAX_PATH_BYTES: usize = 16 * 1024;

fn path_to_uri(path: &str) -> Result<String, ()> {
    if !path.starts_with('/') || path.contains('\0') || path.len() > MAX_PATH_BYTES {
        return Err(());
    }
    const ENCODE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'/')
        .remove(b'-')
        .remove(b'.')
        .remove(b'_')
        .remove(b'~');
    Ok(format!(
        "file://{}",
        percent_encoding::utf8_percent_encode(path, ENCODE)
    ))
}

fn uri_to_path(uri: &str) -> Result<String, ()> {
    if uri.len() > MAX_PATH_BYTES * 3 + 32 {
        return Err(());
    }
    if !uri.starts_with("file:///") && !uri.to_ascii_lowercase().starts_with("file://localhost/") {
        return Err(());
    }
    // percent_decode_str deliberately tolerates invalid escapes; reject them first.
    let bytes = uri.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'%'
            && (i + 2 >= bytes.len()
                || !bytes[i + 1].is_ascii_hexdigit()
                || !bytes[i + 2].is_ascii_hexdigit())
        {
            return Err(());
        }
    }
    let uri = url::Url::parse(uri).map_err(|_| ())?;
    if uri.scheme() != "file"
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.port().is_some()
        || uri.query().is_some()
        || uri.fragment().is_some()
        || uri
            .host_str()
            .is_some_and(|host| !host.eq_ignore_ascii_case("localhost"))
    {
        return Err(());
    }
    let path = percent_encoding::percent_decode_str(uri.path())
        .decode_utf8()
        .map_err(|_| ())?;
    if !path.starts_with('/') || path.contains('\0') || path.len() > MAX_PATH_BYTES {
        return Err(());
    }
    Ok(path.into_owned())
}

fn decode_list(data: &[u8], gnome: bool) -> Result<Option<Vec<String>>, ()> {
    if data.len() > MAX_BYTES {
        return Err(());
    }
    let text = std::str::from_utf8(data).map_err(|_| ())?;
    let mut lines = text.lines();
    if gnome && !matches!(lines.next(), Some("copy" | "cut")) {
        return Err(());
    }
    let mut files = Vec::new();
    for line in lines {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if files.len() == MAX_FILES {
            return Err(());
        }
        files.push(uri_to_path(line)?);
    }
    Ok((!files.is_empty()).then_some(files))
}

fn encode_list(paths: &[String]) -> Result<String, ()> {
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(());
    }
    let mut result = String::new();
    for path in paths {
        let uri = path_to_uri(path)?;
        if result.len() + uri.len() + 2 > MAX_BYTES {
            return Err(());
        }
        result.push_str(&uri);
        result.push_str("\r\n");
    }
    Ok(result)
}

#[cfg(target_os = "macos")]
pub(crate) fn write(_app: &tauri::AppHandle, paths: &[String]) -> Result<(), ()> {
    write_mac_board(&objc2_app_kit::NSPasteboard::generalPasteboard(), paths)
}

#[cfg(target_os = "macos")]
fn write_mac_board(board: &objc2_app_kit::NSPasteboard, paths: &[String]) -> Result<(), ()> {
    use objc2::{rc::autoreleasepool, runtime::ProtocolObject};
    use objc2_app_kit::{NSPasteboardItem, NSPasteboardTypeFileURL};
    use objc2_foundation::{NSArray, NSString};
    let uris = encode_list(paths)?;
    autoreleasepool(|_| {
        let mut items = Vec::new();
        for uri in uris.lines() {
            let item = NSPasteboardItem::new();
            if !item.setString_forType(&NSString::from_str(uri), unsafe { NSPasteboardTypeFileURL })
            {
                return Err(());
            }
            items.push(ProtocolObject::from_retained(item));
        }
        let objects = NSArray::from_retained_slice(&items);
        board.clearContents();
        if board.writeObjects(&objects) {
            Ok(())
        } else {
            Err(())
        }
    })
}

#[cfg(target_os = "macos")]
pub(crate) fn read(_app: &tauri::AppHandle) -> Result<Option<Vec<String>>, ()> {
    read_mac_board(&objc2_app_kit::NSPasteboard::generalPasteboard())
}

#[cfg(target_os = "macos")]
fn read_mac_board(board: &objc2_app_kit::NSPasteboard) -> Result<Option<Vec<String>>, ()> {
    use objc2::rc::autoreleasepool;
    use objc2_app_kit::NSPasteboardTypeFileURL;
    autoreleasepool(|_| {
        let Some(items) = board.pasteboardItems() else {
            return Ok(None);
        };
        if items.len() > MAX_FILES {
            return Err(());
        }
        let mut payload = String::new();
        for item in items.iter() {
            if let Some(uri) = item.stringForType(unsafe { NSPasteboardTypeFileURL }) {
                if uri.length() > MAX_BYTES {
                    return Err(());
                }
                let uri = uri.to_string();
                if payload.len() + uri.len() + 2 > MAX_BYTES {
                    return Err(());
                }
                payload.push_str(&uri);
                payload.push_str("\r\n");
            }
        }
        decode_list(payload.as_bytes(), false)
    })
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::{Duration, Instant};

    const TIMEOUT: Duration = Duration::from_millis(750);
    // A timed-out GTK request can finish later. Keep at most one outstanding
    // request rather than accumulating callbacks once every watchdog tick.
    static READING: AtomicBool = AtomicBool::new(false);
    struct ReadGuard;
    impl Drop for ReadGuard {
        fn drop(&mut self) {
            READING.store(false, Ordering::SeqCst);
        }
    }

    fn clipboard() -> Option<gtk::Clipboard> {
        gtk::gdk::Display::default().and_then(|display| gtk::Clipboard::default(&display))
    }

    fn request(
        board: &gtk::Clipboard,
        gnome: bool,
        guard: ReadGuard,
        sender: mpsc::SyncSender<Result<Option<Vec<String>>, ()>>,
    ) {
        let mime = if gnome {
            "x-special/gnome-copied-files"
        } else {
            "text/uri-list"
        };
        board.request_contents(&gtk::gdk::Atom::intern(mime), move |board, data| {
            if data.length() < 0 && !gnome {
                request(board, true, guard, sender);
                return;
            }
            let _guard = guard;
            let result = if data.length() < 0 {
                Ok(None)
            } else if data.length() as usize > MAX_BYTES {
                Err(())
            } else {
                decode_list(&data.data(), gnome)
            };
            let _ = sender.try_send(result);
        });
    }

    pub(super) fn read(app: &tauri::AppHandle) -> Result<Option<Vec<String>>, ()> {
        // The startup cache is primed on GTK's main thread. Never wait for an
        // asynchronous main-loop callback there; the monitor retries off-thread.
        if gtk::is_initialized_main_thread() || READING.swap(true, Ordering::SeqCst) {
            return Err(());
        }
        let guard = ReadGuard;
        let (sender, receiver) = mpsc::sync_channel(1);
        let deadline = Instant::now() + TIMEOUT;
        app.run_on_main_thread(move || {
            if Instant::now() >= deadline {
                return;
            }
            if let Some(board) = clipboard() {
                request(&board, false, guard, sender);
            }
        })
        .map_err(|_| ())?;
        receiver.recv_timeout(TIMEOUT).map_err(|_| ())?
    }

    fn write_to_board(board: &gtk::Clipboard, uris: String) -> bool {
        let gnome = format!("copy\n{}", uris.replace("\r\n", "\n"));
        let targets = [
            gtk::TargetEntry::new("text/uri-list", gtk::TargetFlags::empty(), 0),
            gtk::TargetEntry::new("x-special/gnome-copied-files", gtk::TargetFlags::empty(), 1),
        ];
        board.set_with_data(&targets, move |_, selection, info| {
            let (mime, payload) = if info == 0 {
                ("text/uri-list", &uris)
            } else {
                ("x-special/gnome-copied-files", &gnome)
            };
            selection.set(&gtk::gdk::Atom::intern(mime), 8, payload.as_bytes());
        })
    }

    pub(super) fn write(app: &tauri::AppHandle, paths: &[String]) -> Result<(), ()> {
        let uris = encode_list(paths)?;
        let (sender, receiver) = mpsc::sync_channel(1);
        let deadline = Instant::now() + TIMEOUT;
        app.run_on_main_thread(move || {
            if Instant::now() >= deadline {
                return;
            }
            let Some(board) = clipboard() else {
                return;
            };
            let success = write_to_board(&board, uris);
            let _ = sender.try_send(if success { Ok(()) } else { Err(()) });
        })
        .map_err(|_| ())?;
        receiver.recv_timeout(TIMEOUT).map_err(|_| ())?
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use gtk::glib::prelude::ObjectExt;
        use std::{cell::Cell, rc::Rc};

        fn pump_until(mut complete: impl FnMut() -> bool) {
            let context = gtk::glib::MainContext::default();
            let deadline = Instant::now() + Duration::from_secs(3);
            while !complete() {
                assert!(
                    Instant::now() < deadline,
                    "isolated GTK operation timed out"
                );
                while context.pending() {
                    context.iteration(false);
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }

        #[test]
        #[ignore = "requires an isolated X11 display; run explicitly under xvfb-run"]
        fn native_file_formats_and_identical_recopy() {
            gtk::init().unwrap();
            let selection =
                gtk::gdk::Atom::intern(&format!("COPY_CREATOR_QA_FILES_{}", std::process::id()));
            let board = gtk::Clipboard::get(&selection);
            let changes = Rc::new(Cell::new(0usize));
            let observed = changes.clone();
            board.connect_local("owner-change", false, move |_| {
                observed.set(observed.get() + 1);
                None
            });
            let files = vec!["/tmp/中文 空格#%20.txt".into(), "/tmp/other.txt".into()];
            let uris = encode_list(&files).unwrap();
            assert!(write_to_board(&board, uris.clone()));
            pump_until(|| changes.get() > 0);
            for gnome in [false, true] {
                let (sender, receiver) = mpsc::sync_channel(1);
                request(&board, gnome, ReadGuard, sender);
                let mut result = None;
                pump_until(|| {
                    result = receiver.try_recv().ok();
                    result.is_some()
                });
                assert_eq!(result.unwrap().unwrap(), Some(files.clone()));
            }
            let previous = changes.get();
            assert!(write_to_board(&board, uris));
            pump_until(|| changes.get() > previous);
            board.clear();
        }
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn read(app: &tauri::AppHandle) -> Result<Option<Vec<String>>, ()> {
    linux::read(app)
}
#[cfg(target_os = "linux")]
pub(crate) fn write(app: &tauri::AppHandle, paths: &[String]) -> Result<(), ()> {
    linux::write(app, paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires macOS pasteboard service; uses a private named pasteboard"]
    fn native_mac_file_formats_and_identical_recopy() {
        let board = objc2_app_kit::NSPasteboard::pasteboardWithUniqueName();
        let files = vec!["/tmp/中文 空格#%20.txt".into(), "/tmp/other.txt".into()];
        write_mac_board(&board, &files).unwrap();
        assert_eq!(read_mac_board(&board).unwrap(), Some(files.clone()));
        let before = board.changeCount();
        write_mac_board(&board, &files).unwrap();
        assert_ne!(board.changeCount(), before);
        assert_eq!(read_mac_board(&board).unwrap(), Some(files));
        board.clearContents();
    }
    #[test]
    fn file_uri_roundtrip_preserves_special_characters() {
        let files = vec!["/tmp/中文 空格#?%20.txt".into(), "/tmp/a\nb\rc.txt".into()];
        let payload = encode_list(&files).unwrap();
        assert!(payload.contains("%2520"));
        assert!(payload.contains("%0A"));
        assert_eq!(decode_list(payload.as_bytes(), false).unwrap(), Some(files));
    }
    #[test]
    fn accepts_uri_comments_crlf_localhost_and_gnome_copy_or_cut() {
        assert_eq!(
            decode_list(b"#comment\r\nfile://localhost/tmp/a%20b\r\n", false).unwrap(),
            Some(vec!["/tmp/a b".into()])
        );
        for operation in ["copy", "cut"] {
            assert_eq!(
                decode_list(format!("{operation}\nfile:///tmp/a\n").as_bytes(), true).unwrap(),
                Some(vec!["/tmp/a".into()])
            );
        }
        assert!(decode_list(b"move\nfile:///tmp/a", true).is_err());
    }
    #[test]
    fn rejects_nonlocal_invalid_and_ambiguous_uris() {
        for uri in [
            "file:relative",
            "file:/tmp/a",
            "https://example.com/a",
            "file://remote/tmp/a",
            "file:///tmp/a?query",
            "file:///tmp/a#fragment",
            "file:///tmp/%00",
            "file:///tmp/%FF",
            "file:///tmp/%x0",
            "file:///tmp/%",
            "file://user@localhost/tmp/a",
        ] {
            assert!(uri_to_path(uri).is_err(), "{uri}");
        }
        assert!(path_to_uri("relative").is_err());
        assert!(path_to_uri("/tmp/\0x").is_err());
    }
    #[test]
    fn bounds_file_count_path_and_payload_before_encoding() {
        assert!(encode_list(&[]).is_err());
        assert!(encode_list(&vec!["/a".into(); MAX_FILES + 1]).is_err());
        assert!(encode_list(&vec![format!("/{}", "a".repeat(MAX_PATH_BYTES))]).is_err());
        assert!(decode_list(&vec![b'a'; MAX_BYTES + 1], false).is_err());
        assert!(decode_list("file:///a\n".repeat(MAX_FILES + 1).as_bytes(), false).is_err());
        assert_eq!(decode_list(b"# only comment\r\n", false).unwrap(), None);
    }
}
