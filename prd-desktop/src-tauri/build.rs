use std::{
    env,
    fs,
    path::PathBuf,
};

fn main() {
    // Ensure bundle icons exist before tauri-build/tauri proc-macros validate the config.
    // The repo intentionally ignores `src-tauri/icons/` (generated assets), so CI checkouts
    // may miss these files and crash at compile time.
    ensure_bundle_icons_exist();

    // Re-run build script if config changes.
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=../icon.png");

    tauri_build::build()
}

fn ensure_bundle_icons_exist() {
    let manifest_dir = match env::var("CARGO_MANIFEST_DIR") {
        Ok(v) => PathBuf::from(v),
        Err(_) => return,
    };

    let config_path = manifest_dir.join("tauri.conf.json");
    let config = match fs::read_to_string(&config_path) {
        Ok(v) => v,
        Err(_) => return,
    };

    let icon_paths = extract_bundle_icon_paths(&config);
    if icon_paths.is_empty() {
        return;
    }

    for rel in icon_paths {
        let icon_path = manifest_dir.join(&rel);
        if icon_path.exists() {
            continue;
        }

        if let Some(parent) = icon_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let ext = icon_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        let bytes = match ext.as_str() {
            "png" => placeholder_png(),
            "ico" => placeholder_ico_from_png(placeholder_png().as_slice()),
            // For CI compile-time validation we mainly need the file to exist.
            // A minimal ICNS header avoids "empty file" edge cases in some tooling.
            "icns" => placeholder_icns_minimal(),
            _ => Vec::new(),
        };

        let _ = fs::write(&icon_path, bytes);
    }
}

/// Extracts icon paths from `"bundle": { "icon": [ ... ] }` in `tauri.conf.json`.
/// We keep this parser intentionally lightweight (no extra build-deps).
fn extract_bundle_icon_paths(config_json: &str) -> Vec<String> {
    // Fast path: only collect strings that look like "icons/..."
    // (This matches current project convention.)
    let mut out = Vec::new();
    let mut i = 0usize;
    let bytes = config_json.as_bytes();

    while i < bytes.len() {
        // look for `"icons/` or `"icons\`
        if bytes[i] == b'"' {
            let start = i + 1;
            if start + 6 < bytes.len()
                && (&config_json[start..]).starts_with("icons/")
                    || (&config_json[start..]).starts_with("icons\\")
            {
                if let Some(end_quote) = config_json[start..].find('"') {
                    let raw = &config_json[start..start + end_quote];
                    // normalize windows-style separators
                    let normalized = raw.replace('\\', "/");
                    out.push(normalized);
                    i = start + end_quote + 1;
                    continue;
                }
            }
        }
        i += 1;
    }

    // de-dup while preserving order
    let mut uniq = Vec::new();
    for p in out {
        if !uniq.iter().any(|x: &String| x == &p) {
            uniq.push(p);
        }
    }
    uniq
}

fn placeholder_png() -> Vec<u8> {
    // 1x1 transparent PNG (base64). Small enough to embed and avoids committing binaries.
    let b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XQmQAAAAASUVORK5CYII=";
    decode_base64(b64)
}

fn placeholder_ico_from_png(png: &[u8]) -> Vec<u8> {
    // Minimal ICO with a single embedded PNG image.
    // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) + PNG bytes.
    let mut out = Vec::with_capacity(6 + 16 + png.len());

    // ICONDIR
    out.extend_from_slice(&[0x00, 0x00]); // reserved
    out.extend_from_slice(&[0x01, 0x00]); // type (1=icon)
    out.extend_from_slice(&[0x01, 0x00]); // count

    // ICONDIRENTRY
    out.push(0x01); // width (1)
    out.push(0x01); // height (1)
    out.push(0x00); // color count
    out.push(0x00); // reserved
    out.extend_from_slice(&[0x01, 0x00]); // planes
    out.extend_from_slice(&[0x20, 0x00]); // bit count (32)

    let bytes_in_res = png.len() as u32;
    out.extend_from_slice(&bytes_in_res.to_le_bytes());

    let image_offset = (6 + 16) as u32;
    out.extend_from_slice(&image_offset.to_le_bytes());

    out.extend_from_slice(png);
    out
}

fn placeholder_icns_minimal() -> Vec<u8> {
    // Minimal ICNS container header: 'icns' + total length (8 bytes, big-endian).
    // Enough for existence checks; real release builds should provide proper icons.
    let mut out = Vec::with_capacity(8);
    out.extend_from_slice(b"icns");
    out.extend_from_slice(&(8u32.to_be_bytes()));
    out
}

fn decode_base64(input: &str) -> Vec<u8> {
    fn val(c: u8) -> Option<u8> {
        match c {
            b'A'..=b'Z' => Some(c - b'A'),
            b'a'..=b'z' => Some(c - b'a' + 26),
            b'0'..=b'9' => Some(c - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits: u8 = 0;

    for &c in input.as_bytes() {
        if c == b'=' {
            break;
        }
        let Some(v) = val(c) else {
            continue;
        };
        buf = (buf << 6) | (v as u32);
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            let byte = ((buf >> bits) & 0xFF) as u8;
            out.push(byte);
        }
    }

    out
}
