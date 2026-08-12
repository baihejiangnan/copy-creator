use std::io::Write;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

fn is_url(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.chars().any(char::is_control) {
        return false;
    }

    let lower = trimmed.to_lowercase();
    for prefix in ["http://", "https://", "ftp://", "ftps://"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            return !rest.trim().is_empty();
        }
    }
    false
}

pub(crate) fn is_explorer_address(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_control) {
        return false;
    }

    let candidate = trimmed
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(trimmed);
    let bytes = candidate.as_bytes();
    let drive_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    let unc = candidate
        .strip_prefix(r"\\")
        .is_some_and(|rest| rest.split('\\').any(|part| !part.is_empty()));
    let lower = candidate.to_ascii_lowercase();
    let shell_address = lower
        .strip_prefix("shell:")
        .is_some_and(|rest| !rest.trim().is_empty());
    let explorer_clsid =
        candidate.starts_with("::{") && candidate.ends_with('}') && candidate.len() > 4;

    drive_absolute || unc || shell_address || explorer_clsid
}

fn classify_text_record(text: &str) -> &'static str {
    if is_url(text) {
        "link"
    } else if is_explorer_address(text) {
        "explorer"
    } else {
        "text"
    }
}

fn is_tabular_clipboard_text(text: &str) -> bool {
    text.contains('\t') && text.chars().any(|character| !character.is_whitespace())
}

fn normalize_clipboard_text(text: &str, preserve_table_layout: bool) -> String {
    if preserve_table_layout || is_tabular_clipboard_text(text) {
        text.trim_end_matches(['\r', '\n']).to_string()
    } else {
        text.trim().to_string()
    }
}

fn should_prefer_text_over_image(text: &str, has_spreadsheet_format: bool) -> bool {
    !text.is_empty() && (has_spreadsheet_format || is_tabular_clipboard_text(text))
}

#[cfg(test)]
mod url_tests {
    use super::{
        classify_text_record, is_explorer_address, is_tabular_clipboard_text, is_url,
        normalize_clipboard_text, should_prefer_text_over_image,
    };

    #[test]
    fn accepts_links_with_default_handlers() {
        for url in [
            "https://example.com/path",
            "HTTP://EXAMPLE.COM",
            "ftp://files.example.com/archive.zip",
            " ftps://files.example.com ",
        ] {
            assert!(is_url(url), "expected a supported URL: {url}");
        }
    }

    #[test]
    fn rejects_unsupported_or_malformed_links() {
        for value in [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "https://",
            "https://example.com\nfile:///C:/secret.txt",
        ] {
            assert!(!is_url(value), "expected URL rejection: {value}");
        }
    }

    #[test]
    fn recognizes_windows_explorer_addresses() {
        for value in [
            r"C:\Users\Public\Documents",
            "D:/work/project",
            r"\\server\share\folder",
            r"\\?\C:\very-long-path",
            "shell:Downloads",
            "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}",
            r#""C:\Program Files""#,
        ] {
            assert!(
                is_explorer_address(value),
                "expected an Explorer address: {value}"
            );
        }
    }

    #[test]
    fn rejects_relative_or_non_explorer_text() {
        for value in [
            "C:relative-path",
            r"folder\child",
            r"\\",
            "https://example.com/path",
            "notes about C:\\Windows",
            "C:\\Windows\nD:\\Data",
        ] {
            assert!(
                !is_explorer_address(value),
                "expected ordinary text: {value}"
            );
        }
    }

    #[test]
    fn classifies_links_before_explorer_addresses() {
        assert_eq!(classify_text_record("https://example.com"), "link");
        assert_eq!(classify_text_record(r"C:\Users\Public"), "explorer");
        assert_eq!(classify_text_record("plain text"), "text");
    }

    #[test]
    fn recognizes_tabular_clipboard_text() {
        assert!(is_tabular_clipboard_text("Name\tScore\r\nAlice\t10\r\n"));
        assert!(should_prefer_text_over_image(
            "Name\tScore\r\nAlice\t10\r\n",
            false
        ));
        assert!(should_prefer_text_over_image("single cell", true));
        assert!(!should_prefer_text_over_image("plain text", false));
        assert!(!should_prefer_text_over_image("", true));
    }

    #[test]
    fn preserves_table_cell_boundaries_when_normalizing() {
        assert_eq!(
            normalize_clipboard_text("\tHeader\t\r\nValue\t\t\r\n", true),
            "\tHeader\t\r\nValue\t\t"
        );
        assert_eq!(
            normalize_clipboard_text("  ordinary text  ", false),
            "ordinary text"
        );
    }
}

#[cfg(target_os = "windows")]
const MAX_CLIPBOARD_FORMAT_BYTES: usize = 512 * 1024 * 1024;
#[cfg(target_os = "windows")]
const MAX_CLIPBOARD_RGBA_BYTES: usize = 256 * 1024 * 1024;
#[cfg(target_os = "windows")]
const MAX_CLIPBOARD_IMAGE_DIMENSION: u32 = 20_000;

#[cfg(target_os = "windows")]
struct ClipboardSession;

#[cfg(target_os = "windows")]
impl ClipboardSession {
    fn open() -> Option<Self> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::System::DataExchange::OpenClipboard;

        unsafe { OpenClipboard(HWND::default()).ok()? };
        Some(Self)
    }
}

#[cfg(target_os = "windows")]
impl Drop for ClipboardSession {
    fn drop(&mut self) {
        use windows::Win32::System::DataExchange::CloseClipboard;

        let _ = unsafe { CloseClipboard() };
    }
}

#[cfg(target_os = "windows")]
struct LockedGlobalMemory {
    handle: windows::Win32::Foundation::HGLOBAL,
    pointer: *const u8,
    len: usize,
}

#[cfg(target_os = "windows")]
impl LockedGlobalMemory {
    fn lock(handle: windows::Win32::Foundation::HANDLE) -> Option<Self> {
        use windows::Win32::Foundation::HGLOBAL;
        use windows::Win32::System::Memory::{GlobalLock, GlobalSize};

        let handle = HGLOBAL(handle.0);
        let len = unsafe { GlobalSize(handle) };
        if len == 0 || len > MAX_CLIPBOARD_FORMAT_BYTES {
            return None;
        }

        let pointer = unsafe { GlobalLock(handle) } as *const u8;
        if pointer.is_null() {
            return None;
        }

        Some(Self {
            handle,
            pointer,
            len,
        })
    }

    fn bytes(&self) -> &[u8] {
        unsafe { std::slice::from_raw_parts(self.pointer, self.len) }
    }
}

#[cfg(target_os = "windows")]
impl Drop for LockedGlobalMemory {
    fn drop(&mut self) {
        use windows::Win32::System::Memory::GlobalUnlock;

        let _ = unsafe { GlobalUnlock(self.handle) };
    }
}

#[cfg(target_os = "windows")]
fn read_u16_le(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
    ))
}

#[cfg(target_os = "windows")]
fn read_u32_le(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

#[cfg(target_os = "windows")]
fn read_i32_le(bytes: &[u8], offset: usize) -> Option<i32> {
    Some(i32::from_le_bytes(
        bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

#[cfg(target_os = "windows")]
fn checked_rgba_len(width: u32, height: u32) -> Option<usize> {
    if width == 0
        || height == 0
        || width >= MAX_CLIPBOARD_IMAGE_DIMENSION
        || height >= MAX_CLIPBOARD_IMAGE_DIMENSION
    {
        return None;
    }

    let len = (width as usize)
        .checked_mul(height as usize)?
        .checked_mul(4)?;
    (len <= MAX_CLIPBOARD_RGBA_BYTES).then_some(len)
}

#[cfg(target_os = "windows")]
fn copy_clipboard_format(format: u32) -> Option<Vec<u8>> {
    use windows::Win32::System::DataExchange::{GetClipboardData, IsClipboardFormatAvailable};

    let _clipboard = ClipboardSession::open()?;
    unsafe { IsClipboardFormatAvailable(format).ok()? };
    let handle = unsafe { GetClipboardData(format).ok()? };
    let memory = LockedGlobalMemory::lock(handle)?;
    Some(memory.bytes().to_vec())
}

#[cfg(target_os = "windows")]
fn decode_clipboard_png(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

    if bytes.get(..PNG_SIGNATURE.len())? != PNG_SIGNATURE {
        return None;
    }

    let width = u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?);
    let height = u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?);
    let expected_len = checked_rgba_len(width, height)?;
    let image = image::load_from_memory_with_format(bytes, image::ImageFormat::Png).ok()?;
    if image.width() != width || image.height() != height {
        return None;
    }

    let rgba = image.into_rgba8().into_raw();
    (rgba.len() == expected_len).then_some((rgba, width, height))
}

#[cfg(target_os = "windows")]
fn decode_clipboard_dib(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    const BI_RGB: u32 = 0;
    const BI_BITFIELDS: u32 = 3;
    const BI_ALPHABITFIELDS: u32 = 6;

    let header_size = read_u32_le(bytes, 0)? as usize;
    if !matches!(header_size, 40 | 52 | 56 | 108 | 124) || header_size > bytes.len() {
        return None;
    }

    let signed_width = read_i32_le(bytes, 4)?;
    let signed_height = read_i32_le(bytes, 8)?;
    if signed_width <= 0 || signed_height == 0 {
        return None;
    }
    let width = u32::try_from(signed_width).ok()?;
    let height = signed_height
        .checked_abs()
        .and_then(|value| u32::try_from(value).ok())?;
    let expected_len = checked_rgba_len(width, height)?;

    let planes = read_u16_le(bytes, 12)?;
    let bits_per_pixel = read_u16_le(bytes, 14)?;
    let compression = read_u32_le(bytes, 16)?;
    if planes != 1
        || !matches!(bits_per_pixel, 1 | 4 | 8 | 16 | 24 | 32)
        || !matches!(compression, BI_RGB | BI_BITFIELDS | BI_ALPHABITFIELDS)
        || (matches!(compression, BI_BITFIELDS | BI_ALPHABITFIELDS)
            && !matches!(bits_per_pixel, 16 | 32))
    {
        return None;
    }

    let mask_bytes = if header_size == 40 {
        match compression {
            BI_BITFIELDS => 3usize.checked_mul(4)?,
            BI_ALPHABITFIELDS => 4usize.checked_mul(4)?,
            _ => 0,
        }
    } else {
        0
    };
    let used_colors = read_u32_le(bytes, 32)? as usize;
    let default_colors = if bits_per_pixel <= 8 {
        1usize.checked_shl(bits_per_pixel as u32)?
    } else {
        0
    };
    let palette_entries = if used_colors == 0 {
        default_colors
    } else {
        used_colors
    };
    if default_colors != 0 && palette_entries > default_colors {
        return None;
    }
    let palette_bytes = palette_entries.checked_mul(4)?;
    let pixel_offset = header_size
        .checked_add(mask_bytes)?
        .checked_add(palette_bytes)?;

    let row_bits = (width as usize).checked_mul(bits_per_pixel as usize)?;
    let row_stride = row_bits.checked_add(31)?.checked_div(32)?.checked_mul(4)?;
    let pixel_bytes = row_stride.checked_mul(height as usize)?;
    let pixel_end = pixel_offset.checked_add(pixel_bytes)?;
    if pixel_offset > bytes.len() || pixel_end > bytes.len() {
        return None;
    }

    let file_size = 14usize.checked_add(bytes.len())?;
    let file_size_u32 = u32::try_from(file_size).ok()?;
    let pixel_offset_u32 = u32::try_from(14usize.checked_add(pixel_offset)?).ok()?;
    let mut bmp = Vec::with_capacity(file_size);
    bmp.extend_from_slice(b"BM");
    bmp.extend_from_slice(&file_size_u32.to_le_bytes());
    bmp.extend_from_slice(&0u32.to_le_bytes());
    bmp.extend_from_slice(&pixel_offset_u32.to_le_bytes());
    bmp.extend_from_slice(bytes);

    let image = image::load_from_memory_with_format(&bmp, image::ImageFormat::Bmp).ok()?;
    if image.width() != width || image.height() != height {
        return None;
    }
    let rgba = image.into_rgba8().into_raw();
    (rgba.len() == expected_len).then_some((rgba, width, height))
}

#[cfg(all(test, target_os = "windows"))]
mod dib_tests {
    use super::decode_clipboard_dib;

    fn make_24_bit_dib(width: i32, height: i32, pixels: &[u8]) -> Vec<u8> {
        let mut dib = vec![0u8; 40];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&width.to_le_bytes());
        dib[8..12].copy_from_slice(&height.to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&24u16.to_le_bytes());
        dib[20..24].copy_from_slice(&(pixels.len() as u32).to_le_bytes());
        dib.extend_from_slice(pixels);
        dib
    }

    #[test]
    fn decodes_bottom_up_dib_with_row_padding() {
        let pixels = [
            255, 0, 0, 255, 255, 255, 0, 0, // bottom: blue, white + padding
            0, 0, 255, 0, 255, 0, 0, 0, // top: red, green + padding
        ];
        let (rgba, width, height) =
            decode_clipboard_dib(&make_24_bit_dib(2, 2, &pixels)).expect("valid DIB should decode");

        assert_eq!((width, height), (2, 2));
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255]);
        assert_eq!(&rgba[4..8], &[0, 255, 0, 255]);
        assert_eq!(&rgba[8..12], &[0, 0, 255, 255]);
        assert_eq!(&rgba[12..16], &[255, 255, 255, 255]);
    }

    #[test]
    fn decodes_top_down_32_bit_dib() {
        let mut dib = vec![0u8; 40];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&2i32.to_le_bytes());
        dib[8..12].copy_from_slice(&(-1i32).to_le_bytes());
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        dib[20..24].copy_from_slice(&8u32.to_le_bytes());
        dib.extend_from_slice(&[30, 20, 10, 255, 70, 60, 50, 128]);

        let (rgba, width, height) =
            decode_clipboard_dib(&dib).expect("valid top-down DIB should decode");
        assert_eq!((width, height), (2, 1));
        assert_eq!(&rgba, &[10, 20, 30, 255, 50, 60, 70, 255]);
    }

    #[test]
    fn rejects_truncated_or_invalid_dib_layouts() {
        let pixels = [0u8; 16];
        let valid = make_24_bit_dib(2, 2, &pixels);

        assert!(decode_clipboard_dib(&valid[..valid.len() - 1]).is_none());

        let mut oversized_header = valid.clone();
        oversized_header[0..4].copy_from_slice(&124u32.to_le_bytes());
        assert!(decode_clipboard_dib(&oversized_header).is_none());

        let mut invalid_height = valid;
        invalid_height[8..12].copy_from_slice(&i32::MIN.to_le_bytes());
        assert!(decode_clipboard_dib(&invalid_height).is_none());
    }
}

#[tauri::command]
pub fn open_external_link(url: String) -> Result<(), String> {
    let url = url.trim();
    if !is_url(url) {
        return Err("Unsupported link protocol".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use windows::core::{w, PCWSTR};
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let target: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
        let result = unsafe {
            ShellExecuteW(
                HWND::default(),
                w!("open"),
                PCWSTR(target.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };

        if result.0 as isize <= 32 {
            return Err(format!(
                "Failed to open link (ShellExecuteW code {})",
                result.0 as isize
            ));
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Opening links is currently supported on Windows only".to_string())
    }
}

fn is_previewable_image_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".png")
}

const LARGE_IMAGE_THRESHOLD_BYTES: u64 = 10 * 1024 * 1024;
const THUMBNAIL_MAX_SIZE: u32 = 264;
const TEXT_EVENT_PREVIEW_CHARS: usize = 600;

fn is_image_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".png")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".gif")
        || lower.ends_with(".bmp")
        || lower.ends_with(".webp")
        || lower.ends_with(".ico")
}

fn make_text_event_content(record_type: &str, content: &str) -> (String, i64, bool) {
    let total_chars = content.chars().count();
    if record_type != "text" || total_chars <= TEXT_EVENT_PREVIEW_CHARS {
        return (content.to_string(), total_chars as i64, false);
    }

    (
        content.chars().take(TEXT_EVENT_PREVIEW_CHARS).collect(),
        total_chars as i64,
        true,
    )
}

struct StoredImage {
    relative_path: String,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    clipboard_png: Vec<u8>,
}

fn image_setting_u32(app: &AppHandle, key: &str, default: u32, min: u32, max: u32) -> u32 {
    crate::db::get_setting_sync(app, key)
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn encode_png(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    let mut output = Vec::new();
    let encoder = image::codecs::png::PngEncoder::new(&mut output);
    use image::ImageEncoder;
    encoder
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .ok()?;
    Some(output)
}

fn process_and_store_image(
    app: &AppHandle,
    mut image: image::DynamicImage,
    source_bytes: u64,
) -> Option<StoredImage> {
    let handling = crate::db::get_setting_sync(app, "large_image_handling")
        .unwrap_or_else(|| "compress".to_string());
    let is_large = source_bytes >= LARGE_IMAGE_THRESHOLD_BYTES;
    if is_large && handling == "skip" {
        log::info!("clipboard: skipped image larger than 10 MB");
        return None;
    }

    let keep_large_original = is_large && handling == "keep";
    let max_dimension = image_setting_u32(app, "image_max_dimension", 4096, 512, 16_384);
    let quality = image_setting_u32(app, "image_compression_quality", 90, 40, 100) as u8;
    if !keep_large_original && image.width().max(image.height()) > max_dimension {
        image = image.resize(
            max_dimension,
            max_dimension,
            image::imageops::FilterType::Lanczos3,
        );
    }

    let rgba_image = image.to_rgba8();
    let (width, height) = rgba_image.dimensions();
    let has_transparency = rgba_image.pixels().any(|pixel| pixel.0[3] != 255);
    let clipboard_png = encode_png(rgba_image.as_raw(), width, height)?;
    let use_jpeg = !keep_large_original && quality < 100 && !has_transparency;
    let (stored_bytes, extension) = if use_jpeg {
        let rgb = image::DynamicImage::ImageRgba8(rgba_image.clone()).to_rgb8();
        let mut bytes = Vec::new();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality);
        use image::ImageEncoder;
        encoder
            .write_image(rgb.as_raw(), width, height, image::ExtendedColorType::Rgb8)
            .ok()?;
        (bytes, "jpg")
    } else {
        (clipboard_png.clone(), "png")
    };

    let content_hash = stored_bytes.iter().fold(0u64, |acc, &byte| {
        acc.wrapping_mul(31).wrapping_add(byte as u64)
    });
    let filename = format!("{content_hash:016x}.{extension}");
    let relative_path = format!("images/{filename}");
    let mut images_dir = crate::db::get_storage_dir(app);
    images_dir.push("images");
    std::fs::create_dir_all(&images_dir).ok()?;
    let image_path = images_dir.join(&filename);
    if !image_path.exists() {
        let mut file = std::fs::File::create(&image_path).ok()?;
        file.write_all(&stored_bytes).ok()?;
    }

    let thumb_dir = images_dir.join("thumbs");
    std::fs::create_dir_all(&thumb_dir).ok()?;
    let thumb_path = thumb_dir.join(&filename);
    if !thumb_path.exists() {
        let thumbnail = image::DynamicImage::ImageRgba8(rgba_image.clone())
            .thumbnail(THUMBNAIL_MAX_SIZE, THUMBNAIL_MAX_SIZE);
        let mut thumb_output = std::io::Cursor::new(Vec::new());
        if thumbnail
            .write_to(&mut thumb_output, image::ImageFormat::Png)
            .is_ok()
        {
            let _ = std::fs::write(&thumb_path, thumb_output.into_inner());
        }
    }

    Some(StoredImage {
        relative_path,
        rgba: rgba_image.into_raw(),
        width,
        height,
        clipboard_png,
    })
}

/// Import an image file from disk into the storage directory.
/// Returns true if the file was imported as an image record.
fn import_image_file(app: &AppHandle, file_path: &str) -> bool {
    let file_size = std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);

    let img_bytes = match std::fs::read(file_path) {
        Ok(b) => b,
        Err(_) => return false,
    };

    let decoded = match image::load_from_memory(&img_bytes) {
        Ok(d) => d,
        Err(_) => return false,
    };

    let Some(stored) = process_and_store_image(app, decoded, file_size) else {
        return false;
    };
    crate::paste::cache_image(
        stored.relative_path.clone(),
        stored.rgba,
        stored.width,
        stored.height,
        stored.clipboard_png,
    );
    insert_and_emit(app, "image", &stored.relative_path);
    true
}

#[cfg(target_os = "windows")]
fn clipboard_has_spreadsheet_format() -> bool {
    use windows::Win32::System::DataExchange::{
        IsClipboardFormatAvailable, RegisterClipboardFormatW,
    };

    const SPREADSHEET_FORMATS: [&str; 9] = [
        "Biff12",
        "Biff8",
        "Biff5",
        "Biff4",
        "Biff3",
        "Biff",
        "XML Spreadsheet",
        "DataInterchangeFormat",
        "Csv",
    ];

    let Some(_clipboard) = ClipboardSession::open() else {
        return false;
    };
    unsafe {
        SPREADSHEET_FORMATS.iter().any(|name| {
            let wide_name: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
            let format = RegisterClipboardFormatW(windows::core::PCWSTR(wide_name.as_ptr()));
            format != 0 && IsClipboardFormatAvailable(format).is_ok()
        })
    }
}

#[cfg(not(target_os = "windows"))]
fn clipboard_has_spreadsheet_format() -> bool {
    false
}

fn read_clipboard_text_candidate(handle: &AppHandle) -> Option<(String, bool)> {
    let raw_text = handle.clipboard().read_text().ok()?;
    let has_spreadsheet_format = clipboard_has_spreadsheet_format();
    let text = normalize_clipboard_text(&raw_text, has_spreadsheet_format);
    (!text.is_empty()).then_some((text, has_spreadsheet_format))
}

/// Lightweight: hash the raw clipboard image bytes (PNG or DIB) for stable dedup.
/// Raw clipboard bytes are deterministic across reads, unlike re-decoded RGBA.
#[cfg(target_os = "windows")]
fn get_clipboard_image_hash() -> u64 {
    use windows::Win32::System::DataExchange::{
        GetClipboardData, IsClipboardFormatAvailable, RegisterClipboardFormatW,
    };

    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;

    let png_format_name: Vec<u16> = "PNG\0".encode_utf16().collect();
    let cf_png =
        unsafe { RegisterClipboardFormatW(windows::core::PCWSTR(png_format_name.as_ptr())) };
    let Some(_clipboard) = ClipboardSession::open() else {
        return 0;
    };

    for format in [cf_png, CF_DIBV5, CF_DIB] {
        if format == 0 || unsafe { IsClipboardFormatAvailable(format) }.is_err() {
            continue;
        }
        let Ok(handle) = (unsafe { GetClipboardData(format) }) else {
            continue;
        };
        let Some(memory) = LockedGlobalMemory::lock(handle) else {
            continue;
        };

        let hash = memory
            .bytes()
            .iter()
            .fold(0xcbf29ce484222325u64, |hash, byte| {
                (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3)
            });
        return if hash == 0 { 1 } else { hash };
    }

    0
}

/// Direct Windows clipboard image read as a supplement to the clipboard plugin.
/// Returns decoded RGBA data + dimensions (only called when image hash changed).
#[cfg(target_os = "windows")]
fn read_clipboard_image_raw() -> Option<(Vec<u8>, u32, u32)> {
    use windows::Win32::System::DataExchange::RegisterClipboardFormatW;

    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;

    let png_format_name: Vec<u16> = "PNG\0".encode_utf16().collect();
    let cf_png =
        unsafe { RegisterClipboardFormatW(windows::core::PCWSTR(png_format_name.as_ptr())) };
    if cf_png != 0 {
        if let Some(image) = copy_clipboard_format(cf_png)
            .as_deref()
            .and_then(decode_clipboard_png)
        {
            return Some(image);
        }
    }

    for format in [CF_DIBV5, CF_DIB] {
        if let Some(image) = copy_clipboard_format(format)
            .as_deref()
            .and_then(decode_clipboard_dib)
        {
            return Some(image);
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn read_clipboard_image_candidate(handle: &AppHandle) -> Option<(Vec<u8>, u32, u32)> {
    if let Some(image) = read_clipboard_image_raw() {
        return Some(image);
    }

    let image = handle.clipboard().read_image().ok()?;
    let width = image.width();
    let height = image.height();
    let expected_len = checked_rgba_len(width, height)?;
    let rgba = image.rgba();
    (rgba.len() == expected_len).then(|| (rgba.to_vec(), width, height))
}

#[cfg(target_os = "windows")]
fn read_clipboard_files() -> Option<Vec<String>> {
    use windows::Win32::System::DataExchange::*;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    const CF_HDROP: u32 = 15;

    let _clipboard = ClipboardSession::open()?;
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP).is_err() {
            return None;
        }

        let handle = match GetClipboardData(CF_HDROP) {
            Ok(h) => h,
            Err(_) => return None,
        };

        let hdrop = HDROP(handle.0);

        let count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);
        if count == 0 {
            return None;
        }

        let mut paths = Vec::new();
        for i in 0..count {
            let len = DragQueryFileW(hdrop, i, None);
            if len == 0 {
                continue;
            }
            let mut buf = vec![0u16; (len as usize) + 1];
            DragQueryFileW(hdrop, i, Some(&mut buf));
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            let path = String::from_utf16_lossy(&buf[..end]);
            if !path.is_empty() {
                paths.push(path);
            }
        }

        if paths.is_empty() {
            None
        } else {
            Some(paths)
        }
    }
}

/// Cached clipboard state, updated by the monitor and by paste functions.
/// When paste writes to the clipboard, it syncs these to prevent duplicate records.
pub static LAST_CLIPBOARD_TEXT: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
pub static LAST_CLIPBOARD_IMAGE_HASH: std::sync::Mutex<u64> = std::sync::Mutex::new(0);
#[cfg(target_os = "windows")]
pub static LAST_CLIPBOARD_FILES_KEY: std::sync::Mutex<String> =
    std::sync::Mutex::new(String::new());

/// Windows clipboard sequence number — increments on every clipboard change,
/// even if content is identical. Used to detect re-copies of the same content.
#[cfg(target_os = "windows")]
static LAST_CLIPBOARD_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

#[cfg(target_os = "windows")]
fn get_clipboard_sequence() -> u32 {
    use windows::Win32::System::DataExchange::GetClipboardSequenceNumber;
    unsafe { GetClipboardSequenceNumber() }
}

fn is_main_window_active(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    })
}

fn notification_preview(app: &AppHandle, record_type: &str, content: &str) -> (String, String) {
    let lang = crate::db::get_setting_sync(app, "language").unwrap_or_else(|| "zh-CN".to_string());
    let is_english = lang == "en";
    let title = if is_english {
        "New clipboard item"
    } else {
        "新的剪贴板内容"
    };
    let body = if (record_type == "text" || record_type == "link") && crate::db::is_api_key(content)
    {
        if is_english {
            "API Key copied"
        } else {
            "已复制新的 API Key"
        }
        .to_string()
    } else {
        match record_type {
            "image" => if is_english {
                "Image copied"
            } else {
                "已复制一张图片"
            }
            .to_string(),
            "file" => {
                let name = std::path::Path::new(content)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or(content);
                format!("{}: {}", if is_english { "File" } else { "文件" }, name)
            }
            _ => {
                let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
                let mut chars = normalized.chars();
                let preview: String = chars.by_ref().take(80).collect();
                if chars.next().is_some() {
                    format!("{preview}...")
                } else {
                    preview
                }
            }
        }
    };
    (title.to_string(), body)
}

fn maybe_show_clipboard_notification(app: &AppHandle, record_type: &str, content: &str) {
    if is_main_window_active(app)
        || crate::db::get_setting_sync(app, "clipboard_notifications").as_deref() != Some("1")
    {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    let (title, body) = notification_preview(app, record_type, content);
    if let Err(error) = app.notification().builder().title(title).body(body).show() {
        log::warn!("clipboard notification failed: {error}");
    }
}

/// Insert a new record into the DB and emit clipboard-update.
/// Skips insertion only if the most recent record has identical type and content
/// AND was created within the last 2 seconds (debounce window).
/// Re-copies after 2 seconds are treated as intentional and recorded normally.
fn insert_and_emit(app: &AppHandle, record_type: &str, content: &str) {
    let one_second_ago = chrono::Utc::now() - chrono::Duration::seconds(1);
    let cutoff = one_second_ago.to_rfc3339();

    let is_duplicate: bool = {
        let state = app.state::<crate::db::DbState>();
        let x = match state.conn.lock() {
            Ok(conn) => conn.query_row(
                "SELECT type, content, created_at FROM clipboard_records ORDER BY created_at DESC LIMIT 1",
                [],
                |row| {
                    let last_type: String = row.get(0)?;
                    let last_content: String = row.get(1)?;
                    let last_created: String = row.get(2)?;
                    Ok(last_type == record_type && last_content == content && last_created >= cutoff)
                },
            )
            .unwrap_or(false),
            Err(_) => false,
        };
        x
    };

    if is_duplicate {
        return;
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let inserted = {
        let state = app.state::<crate::db::DbState>();
        let result = match state.conn.lock() {
            Ok(conn) => conn.execute(
                "INSERT INTO clipboard_records (id, type, content, source_app, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![&id, record_type, content, "", &now],
            ).is_ok(),
            Err(_) => false,
        };
        result
    };
    if !inserted {
        return;
    }
    // API Key detection
    let (is_key, key_preview, guessed_service) =
        if (record_type == "text" || record_type == "link") && crate::db::is_api_key(content) {
            let preview = crate::db::make_key_preview(content);
            let guess = crate::db::guess_service(content).map(|s| s.to_string());
            if !crate::db::is_toast_shown_internal(app, &preview) {
                crate::db::mark_toast_shown_internal(app, &preview);
                app.emit(
                    "api-key-detected",
                    serde_json::json!({
                        "record_id": id,
                        "key_preview": &preview,
                        "guess": &guess,
                    }),
                )
                .ok();
            }
            (true, preview, guess)
        } else {
            (false, String::new(), None::<String>)
        };

    let (event_content, content_length, content_truncated) =
        make_text_event_content(record_type, content);

    app.emit(
        "clipboard-update",
        serde_json::json!({
            "id": id,
            "type": record_type,
            "content": event_content,
            "content_length": content_length,
            "content_truncated": content_truncated,
            "source_app": "",
            "created_at": now,
            "is_api_key": is_key,
            "key_preview": key_preview,
            "guessed_service": guessed_service,
            "label": null,
            "is_favorite": false,
            "favorite_note": "",
        }),
    )
    .ok();

    crate::db::increment_unread_if_hidden(app);
    maybe_show_clipboard_notification(app, record_type, content);
    if let Err(error) = crate::db::enforce_clipboard_limits(app) {
        log::warn!("clipboard limit enforcement failed: {error}");
    }
    crate::tray::schedule_tray_refresh(app);
}

fn sync_monitor_cache_from_snapshot(text: Option<&str>) {
    *LAST_CLIPBOARD_TEXT.lock().unwrap() = text.unwrap_or_default().to_string();
    #[cfg(target_os = "windows")]
    {
        let h = get_clipboard_image_hash();
        if h != 0 {
            *LAST_CLIPBOARD_IMAGE_HASH.lock().unwrap() = h;
        }
        if let Some(files) = read_clipboard_files() {
            *LAST_CLIPBOARD_FILES_KEY.lock().unwrap() = files.join("|");
        }
        LAST_CLIPBOARD_SEQ.store(get_clipboard_sequence(), Ordering::SeqCst);
    }
}

pub fn sync_monitor_cache(handle: &AppHandle) {
    let text = read_clipboard_text_candidate(handle).map(|(text, _)| text);
    sync_monitor_cache_from_snapshot(text.as_deref());
}

pub fn start_monitor(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.clone();

    {
        let initial_text = read_clipboard_text_candidate(&handle)
            .map(|(text, _)| text)
            .unwrap_or_default();
        *LAST_CLIPBOARD_TEXT.lock().unwrap() = initial_text;
    }

    #[cfg(target_os = "windows")]
    {
        *LAST_CLIPBOARD_IMAGE_HASH.lock().unwrap() = get_clipboard_image_hash();
    }

    #[cfg(target_os = "windows")]
    {
        let key = read_clipboard_files()
            .map(|files| files.join("|"))
            .unwrap_or_default();
        *LAST_CLIPBOARD_FILES_KEY.lock().unwrap() = key;
        LAST_CLIPBOARD_SEQ.store(get_clipboard_sequence(), Ordering::SeqCst);
    }

    std::thread::spawn(move || {
        let mut poll_count: u32 = 0;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(800));
            poll_count += 1;

            // Skip first 2 polls (1.6s) to avoid recording startup clipboard state
            if poll_count <= 2 {
                sync_monitor_cache(&handle);
                continue;
            }

            if crate::paste::PASTING.load(std::sync::atomic::Ordering::SeqCst) {
                sync_monitor_cache(&handle);
                continue;
            }

            // Detect clipboard changes via Windows sequence number.
            // This catches re-copies of identical content (e.g. same image twice).
            let seq_changed = {
                #[cfg(target_os = "windows")]
                {
                    let current_seq = get_clipboard_sequence();
                    let last_seq = LAST_CLIPBOARD_SEQ.load(Ordering::SeqCst);
                    if current_seq != last_seq {
                        LAST_CLIPBOARD_SEQ.store(current_seq, Ordering::SeqCst);
                        true
                    } else {
                        false
                    }
                }
                #[cfg(not(target_os = "windows"))]
                {
                    false
                }
            };

            if !seq_changed {
                continue;
            }

            let text_candidate = read_clipboard_text_candidate(&handle);
            if let Some((text, has_spreadsheet_format)) = text_candidate.as_ref() {
                if should_prefer_text_over_image(text, *has_spreadsheet_format) {
                    *LAST_CLIPBOARD_TEXT.lock().unwrap() = text.clone();
                    let record_type = classify_text_record(text);
                    insert_and_emit(&handle, record_type, text);
                    sync_monitor_cache_from_snapshot(Some(text));
                    continue;
                }
            }

            let mut image_recorded = false;

            let mut image_data: Option<(Vec<u8>, u32, u32)> = None;
            // Track whether the image hash stayed the same (re-copy of same image)
            let mut image_is_same = false;

            // Stable dedup: hash raw clipboard bytes (deterministic) rather than RGBA
            #[cfg(target_os = "windows")]
            {
                let raw_hash = get_clipboard_image_hash();
                let mut cached_hash = LAST_CLIPBOARD_IMAGE_HASH.lock().unwrap();
                if raw_hash != 0 && raw_hash != *cached_hash {
                    *cached_hash = raw_hash;
                    drop(cached_hash);
                    if let Some((rgba, w, h)) = read_clipboard_image_candidate(&handle) {
                        image_data = Some((rgba, w, h));
                    }
                } else if raw_hash != 0 {
                    // Sequence changed but image hash didn't — same image re-copied
                    image_is_same = true;
                    drop(cached_hash);
                } else {
                    drop(cached_hash);
                }
            }

            #[cfg(not(target_os = "windows"))]
            {
                // Non-Windows: use plugin-based image read with RGBA hash
                if let Ok(image) = handle.clipboard().read_image() {
                    let rgba = image.rgba();
                    if !rgba.is_empty() && image.width() > 0 && image.height() > 0 {
                        let hash = rgba
                            .iter()
                            .take(400)
                            .fold(0u64, |acc, &b| acc.wrapping_mul(31).wrapping_add(b as u64));
                        let mut cached_hash = LAST_CLIPBOARD_IMAGE_HASH.lock().unwrap();
                        if hash != *cached_hash {
                            *cached_hash = hash;
                            image_data = Some((rgba.to_vec(), image.width(), image.height()));
                        }
                    }
                }
            }

            if let Some((rgba_vec, img_w, img_h)) = image_data.take() {
                let source_bytes = rgba_vec.len() as u64;
                if let Some(buffer) = image::RgbaImage::from_raw(img_w, img_h, rgba_vec) {
                    if let Some(stored) = process_and_store_image(
                        &handle,
                        image::DynamicImage::ImageRgba8(buffer),
                        source_bytes,
                    ) {
                        log::info!(
                            "clipboard: recorded image {}x{} as {}",
                            stored.width,
                            stored.height,
                            stored.relative_path
                        );
                        crate::paste::cache_image(
                            stored.relative_path.clone(),
                            stored.rgba,
                            stored.width,
                            stored.height,
                            stored.clipboard_png,
                        );
                        insert_and_emit(&handle, "image", &stored.relative_path);
                        image_recorded = true;
                    }
                }
            }

            // Handle re-copy of same image: sequence changed but raw hash didn't.
            // Still insert a new chronological record pointing to the same file on disk.
            if image_is_same {
                #[cfg(target_os = "windows")]
                {
                    if let Some((rgba_vec, img_w, img_h)) = read_clipboard_image_candidate(&handle)
                    {
                        let source_bytes = rgba_vec.len() as u64;
                        if let Some(buffer) = image::RgbaImage::from_raw(img_w, img_h, rgba_vec) {
                            if let Some(stored) = process_and_store_image(
                                &handle,
                                image::DynamicImage::ImageRgba8(buffer),
                                source_bytes,
                            ) {
                                crate::paste::cache_image(
                                    stored.relative_path.clone(),
                                    stored.rgba,
                                    stored.width,
                                    stored.height,
                                    stored.clipboard_png,
                                );
                                insert_and_emit(&handle, "image", &stored.relative_path);
                            }
                        }
                    } else {
                        log::warn!(
                            "clipboard: image_is_same but clipboard image read failed, record lost"
                        );
                    }
                }
                sync_monitor_cache_from_snapshot(
                    text_candidate.as_ref().map(|(text, _)| text.as_str()),
                );
            } else if image_recorded {
                *LAST_CLIPBOARD_TEXT.lock().unwrap() = text_candidate
                    .as_ref()
                    .map(|(text, _)| text.clone())
                    .unwrap_or_default();
                #[cfg(target_os = "windows")]
                {
                    if let Some(files) = read_clipboard_files() {
                        *LAST_CLIPBOARD_FILES_KEY.lock().unwrap() = files.join("|");
                    }
                }
            } else {
                if let Some((text, _)) = text_candidate {
                    if text != *LAST_CLIPBOARD_TEXT.lock().unwrap() {
                        *LAST_CLIPBOARD_TEXT.lock().unwrap() = text.clone();
                        let record_type = classify_text_record(&text);
                        insert_and_emit(&handle, record_type, &text);
                    } else {
                        // Same text re-copied (sequence changed, text matches cache)
                        let record_type = classify_text_record(&text);
                        insert_and_emit(&handle, record_type, &text);
                    }
                }

                #[cfg(target_os = "windows")]
                {
                    if let Some(files) = read_clipboard_files() {
                        let key = files.join("|");
                        {
                            let mut cached = LAST_CLIPBOARD_FILES_KEY.lock().unwrap();
                            if key == *cached {
                                // Same file paths re-copied — insert new records
                                for file_path in &files {
                                    if file_path.trim().is_empty() {
                                        continue;
                                    }
                                    if is_previewable_image_file(file_path)
                                        || is_image_file(file_path)
                                    {
                                        import_image_file(&handle, file_path);
                                        continue;
                                    }
                                    insert_and_emit(&handle, "file", file_path);
                                }
                                continue;
                            }
                            *cached = key.clone();
                        }

                        for file_path in files {
                            if file_path.trim().is_empty() {
                                continue;
                            }
                            if is_previewable_image_file(&file_path) || is_image_file(&file_path) {
                                if import_image_file(&handle, &file_path) {
                                    continue;
                                }
                                // If import failed and it's an image file, skip (don't record raw path)
                                continue;
                            }
                            insert_and_emit(&handle, "file", &file_path);
                        }
                    }
                }
            }
        }
    });

    Ok(())
}
