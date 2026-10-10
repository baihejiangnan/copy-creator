// Synthetic child for testing the real CreateProcessW command line, before
// any CRT argument splitting. It never reads application data or installs.
#[link(name = "kernel32")]
extern "system" {
    fn GetCommandLineW() -> *const u16;
}

fn main() {
    let pointer = unsafe { GetCommandLineW() };
    let mut units = Vec::new();
    for index in 0..32768 {
        let unit = unsafe { *pointer.add(index) };
        if unit == 0 {
            println!("{units:?}");
            return;
        }
        units.push(unit);
    }
    panic!("Unterminated Windows command line");
}
