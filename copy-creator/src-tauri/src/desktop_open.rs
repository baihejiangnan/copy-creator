//! Desktop launch arguments are passed directly, without a command shell.
use std::{
    ffi::OsStr,
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn run(program: &str, arguments: &[&OsStr]) -> Result<(), ()> {
    let mut child = Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| ())?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return if status.success() { Ok(()) } else { Err(()) },
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(());
            }
        }
    }
}

pub(crate) fn open_link(url: &str) -> Result<(), ()> {
    #[cfg(target_os = "macos")]
    {
        run("open", &[OsStr::new(url)])
    }
    #[cfg(target_os = "linux")]
    {
        run("xdg-open", &[OsStr::new(url)])
    }
}

pub(crate) fn reveal_path(path: &Path, is_directory: bool) -> Result<(), ()> {
    #[cfg(target_os = "macos")]
    {
        if is_directory {
            run("open", &[path.as_os_str()])
        } else {
            run("open", &[OsStr::new("-R"), path.as_os_str()])
        }
    }
    #[cfg(target_os = "linux")]
    {
        if !is_directory {
            let uri = reqwest::Url::from_file_path(path).map_err(|_| ())?;
            if let Ok(bus) = dbus::blocking::Connection::new_session() {
                let proxy = bus.with_proxy(
                    "org.freedesktop.FileManager1",
                    "/org/freedesktop/FileManager1",
                    Duration::from_secs(3),
                );
                let result: Result<(), dbus::Error> = proxy.method_call(
                    "org.freedesktop.FileManager1",
                    "ShowItems",
                    (vec![uri.as_str()], ""),
                );
                if result.is_ok() {
                    return Ok(());
                }
            }
        }
        // Minimal file managers may not implement ShowItems; open the parent
        // directory instead of executing the referenced file.
        let directory = if is_directory {
            path
        } else {
            path.parent().ok_or(())?
        };
        run("xdg-open", &[directory.as_os_str()])
    }
}
