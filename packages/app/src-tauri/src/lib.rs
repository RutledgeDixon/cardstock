//! The desktop shell.
//!
//! Deliberately thin: the application is the web build, and this process exists to give
//! it a window, a place on disk, and a file type. Four commands cover the whole of what
//! the frontend cannot do for itself — find its parts directory, read and write `.card`
//! files by path, and learn which file it was launched with.
//!
//! Reads and writes are plain `std::fs` rather than the filesystem plugin. A `.card`
//! double-clicked anywhere on disk must open, and any plugin scope wide enough to allow
//! that is no scope at all; the two commands here are the only surface, and both are
//! restricted to `.card` paths.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};

/// The `.card` the process was started with, handed to the frontend once it asks.
struct LaunchFile(Mutex<Option<PathBuf>>);

const EXTENSION: &str = "card";
/// What Export may write and Import may read. Anything else is not this app's business.
const MODEL_EXTENSIONS: [&str; 5] = ["stl", "3mf", "obj", "step", "stp"];

/// A path is only worth touching if it names a part file. This is the one rule that
/// keeps the read/write commands from being a general filesystem API for the webview.
fn is_card(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case(EXTENSION))
        .unwrap_or(false)
}

fn has_extension(path: &Path, allowed: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| allowed.iter().any(|a| e.eq_ignore_ascii_case(a)))
        .unwrap_or(false)
}

fn model_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if has_extension(&path, &MODEL_EXTENSIONS) {
        Ok(path)
    } else {
        Err(format!("{} is not a model file", path.display()))
    }
}

fn card_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if is_card(&path) {
        Ok(path)
    } else {
        Err(format!("{} is not a .card file", path.display()))
    }
}

/// `<Documents>/CARDstock`, created on first use. Visible on purpose: parts are things
/// people share and back up, and an application-data folder is where files go to be lost.
#[tauri::command]
fn parts_directory(app: AppHandle) -> Result<String, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    let dir = base.join("CARDstock");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_card(path: String) -> Result<String, String> {
    let path = card_path(&path)?;
    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))
}

/// Written to a sibling temp file and renamed over the target, so a crash mid-write
/// leaves the previous save intact rather than a truncated file.
#[tauri::command]
fn write_card(path: String, contents: String) -> Result<(), String> {
    let path = card_path(&path)?;
    let tmp = path.with_extension("card.tmp");
    std::fs::write(&tmp, contents).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Could not replace {}: {e}", path.display()))
}

/// An export: raw bytes in the request body, the target path percent-encoded in a
/// header. Bytes rather than a JSON array because an STL of a real part is megabytes.
#[tauri::command]
fn write_export(request: Request<'_>) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("path")
        .and_then(|v| v.to_str().ok())
        .ok_or("no path given")?;
    let path = model_path(&percent_decode(encoded))?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("export body must be raw bytes".into()),
    };
    std::fs::write(&path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

/// An import: the file's bytes, whole. Restricted to model types like the export.
#[tauri::command]
fn read_import(path: String) -> Result<Response, String> {
    let path = model_path(&path)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    Ok(Response::new(bytes))
}

/// Just enough percent-decoding for a path: `%XX` triples, nothing else.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The launch file is consumed: a reload of the webview must not reopen it over
/// whatever the user has since done.
#[tauri::command]
fn launch_file(state: State<'_, LaunchFile>) -> Option<String> {
    state
        .0
        .lock()
        .ok()?
        .take()
        .map(|p| p.to_string_lossy().into_owned())
}

/// The first `.card` among a launch's arguments, if any. Linux and Windows pass the
/// opened file as an argument; macOS delivers it as an event, handled in `run`.
fn card_in_args<I: IntoIterator<Item = String>>(args: I) -> Option<PathBuf> {
    args.into_iter()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| is_card(p))
}

fn open_in_window(app: &AppHandle, path: &Path) {
    let _ = app.emit("open-file", path.to_string_lossy().into_owned());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // A second launch — another double-click — hands its file to the running window
        // instead of starting a second copy with its own autosave fighting the first.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(path) = card_in_args(args) {
                open_in_window(app, &path);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(LaunchFile(Mutex::new(card_in_args(std::env::args()))))
        .invoke_handler(tauri::generate_handler![
            parts_directory,
            read_card,
            write_card,
            write_export,
            read_import,
            launch_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building CARDstock")
        .run(|app, event| {
            // macOS: files opened through Finder arrive here rather than in argv.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        if is_card(&path) {
                            open_in_window(app, &path);
                        }
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_card_files_count() {
        assert!(is_card(Path::new("/x/part.card")));
        assert!(is_card(Path::new("C:\\x\\PART.CARD")));
        assert!(!is_card(Path::new("/x/part.stl")));
        assert!(!is_card(Path::new("/x/card")));
    }

    #[test]
    fn model_paths_are_the_listed_types_only() {
        assert!(model_path("/x/a.STL").is_ok());
        assert!(model_path("/x/a.step").is_ok());
        assert!(model_path("/x/a.card").is_err());
        assert!(model_path("/x/a.exe").is_err());
    }

    #[test]
    fn percent_decoding_restores_a_path() {
        assert_eq!(percent_decode("%2Fhome%2Fu%2Fmy%20part.stl"), "/home/u/my part.stl");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("bad%zz%4"), "bad%zz%4");
    }

    #[test]
    fn launch_argument_is_the_first_card() {
        let args = ["app", "--flag", "/a/b.stl", "/a/c.card", "/a/d.card"].map(String::from);
        assert_eq!(card_in_args(args), Some(PathBuf::from("/a/c.card")));
        assert_eq!(card_in_args(["app".to_string()]), None);
    }
}
