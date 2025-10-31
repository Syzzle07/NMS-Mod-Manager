#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// --- IMPORTS ---
use chrono::Utc;
use serde::{Deserialize, Serialize};
use quick_xml::de::from_str;
use quick_xml::se::to_string;
use quick_xml::events::Event;
use quick_xml::Reader;
use quick_xml::Writer;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use tauri::{LogicalSize, Manager, PhysicalPosition};
use unrar;
use winreg::enums::*;
use winreg::RegKey;
use zip::ZipArchive;

// --- STRUCTS ---

#[derive(Serialize, Deserialize, Debug, Clone)]
struct ModProperty {
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@value", default)]
    value: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename = "Property")]
struct ModEntry {
    #[serde(rename = "@name")]
    entry_name: String,
    #[serde(rename = "@value")]
    entry_value: String,
    #[serde(rename = "@_index")]
    index: String,
    #[serde(rename = "Property", default)]
    properties: Vec<ModProperty>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct TopLevelProperty {
    #[serde(rename = "@name")]
    name: String,
    #[serde(rename = "@value", default)]
    value: Option<String>, 
    #[serde(rename = "Property", default)]
    mods: Vec<ModEntry>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename = "Data")]
struct SettingsData {
    #[serde(rename = "@template")]
    template: String,
    #[serde(rename = "Property")]
    properties: Vec<TopLevelProperty>,
}
//--- END OF DELETE STRUCT ---

#[derive(Serialize, Deserialize, Debug)]
struct WindowState {
    x: i32,
    y: i32,
    width: Option<u32>,
    height: Option<u32>,
    maximized: bool,
}

struct UserResized(std::sync::atomic::AtomicBool);

// New struct to hold information about a single mod being installed from an archive
#[derive(serde::Serialize, Clone)]
struct ModInstallInfo {
    name: String,
    // The path to the new version of the mod in a temporary "staging" area
    temp_path: String,
}

// New struct to report the complete results of the archive analysis to JavaScript
#[derive(serde::Serialize)]
struct InstallationAnalysis {
    // Mods that were new and installed without issue
    successes: Vec<ModInstallInfo>,
    // Mods that already exist and require user confirmation
    conflicts: Vec<ModInstallInfo>,
    // Path to a temporary folder if the archive was "messy" (no containing folder)
    messy_archive_path: Option<String>,
}

// --- HELPER FUNCTIONS (Unchanged) ---
fn get_state_file_path() -> PathBuf {
    let exe_path = env::current_exe().expect("Failed to find executable path");
    let exe_dir = exe_path.parent().expect("Failed to get parent directory of executable");
    exe_dir.join("window-state.json")
}

fn find_game_path() -> Option<PathBuf> {
    if cfg!(not(windows)) {
        return None;
    }
    find_steam_path().or_else(find_gog_path)
}

fn find_gog_path() -> Option<PathBuf> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let gog_key = hklm.open_subkey(r"SOFTWARE\WOW6432Node\GOG.com\Games\1446223351").ok()?;
    let game_path_str: String = gog_key.get_value("PATH").ok()?;
    let game_path = PathBuf::from(game_path_str);
    if game_path.join("Binaries").is_dir() {
        Some(game_path)
    } else {
        None
    }
}

fn find_steam_path() -> Option<PathBuf> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let steam_key = hklm.open_subkey(r"SOFTWARE\WOW6432Node\Valve\Steam").ok()?;
    let steam_path_str: String = steam_key.get_value("InstallPath").ok()?;
    let steam_path = PathBuf::from(steam_path_str);
    let mut library_folders = vec![steam_path.clone()];
    if let Ok(content) = fs::read_to_string(steam_path.join("steamapps").join("libraryfolders.vdf")) {
        for line in content.lines() {
            if let Some(path_str) = line.split('"').nth(3) {
                let p = PathBuf::from(path_str.replace("\\\\", "\\"));
                if p.exists() {
                    library_folders.push(p);
                }
            }
        }
    }
    for folder in library_folders {
        let manifest_path = folder.join("steamapps").join("appmanifest_275850.acf");
        if let Ok(content) = fs::read_to_string(manifest_path) {
            if let Some(dir_str) = content.lines().find(|l| l.contains("\"installdir\"")).and_then(|l| l.split('"').nth(3)) {
                let game_path = folder.join("steamapps").join("common").join(dir_str);
                if game_path.is_dir() {
                    return Some(game_path);
                }
            }
        }
    }
    None
}

/// Extracts a zip or rar archive to a new temporary directory inside the mods folder.
fn extract_archive_to_temp(archive_path: &Path, mods_path: &Path) -> Result<PathBuf, String> {
    let temp_extract_path = mods_path.join(format!("temp_extract_{}", Utc::now().timestamp_millis()));
    fs::create_dir_all(&temp_extract_path).map_err(|e| e.to_string())?;

    let extension = archive_path.extension().and_then(std::ffi::OsStr::to_str).unwrap_or("").to_lowercase();
    match extension.as_str() {
        "zip" => {
            let file = fs::File::open(archive_path).map_err(|e| format!("Failed to open zip file: {}", e))?;
            let mut archive = ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {}", e))?;
            archive.extract(&temp_extract_path).map_err(|e| e.to_string())?;
        }
        "rar" => {
            let mut archive = unrar::Archive::new(archive_path).open_for_processing().map_err(|e| format!("Failed to open RAR: {:?}", e))?;
            while let Ok(Some(header)) = archive.read_header() {
                archive = header.extract_to(&temp_extract_path).map_err(|e| format!("Failed to extract from RAR: {:?}", e))?;
            }
        }
        _ => return Err(format!("Unsupported file type: .{}", extension)),
    }
    Ok(temp_extract_path)
}

#[tauri::command]
fn install_mod_from_archive(archive_path_str: String) -> Result<InstallationAnalysis, String> {
    let archive_path = Path::new(&archive_path_str);
    let game_path = find_game_path().ok_or_else(|| "Could not find the game installation path.".to_string())?;
    let mods_path = game_path.join("GAMEDATA").join("MODS");
    fs::create_dir_all(&mods_path).map_err(|e| e.to_string())?;

    // 1. Extract archive to a temporary location for analysis
    let temp_extract_path = extract_archive_to_temp(archive_path, &mods_path)?;

    // 2. Analyze the extracted contents for valid mod folders
    let folder_entries: Vec<_> = fs::read_dir(&temp_extract_path)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .collect();

    // 3. Handle "messy" archives (no containing folder)
    if folder_entries.is_empty() {
        // Return the path to JS so it can prompt the user for a name
        return Ok(InstallationAnalysis {
            successes: vec![],
            conflicts: vec![],
            messy_archive_path: Some(temp_extract_path.to_string_lossy().into_owned()),
        });
    }

    // 4. Create a staging area for mods that have conflicts
    let staging_path = mods_path.join(format!("temp_staging_{}", Utc::now().timestamp_millis()));
    
    let mut successes = Vec::new();
    let mut conflicts = Vec::new();

    for entry in folder_entries {
        let mod_name = entry.file_name().to_string_lossy().into_owned();
        let final_dest_path = mods_path.join(&mod_name);

        if final_dest_path.exists() {
            // CONFLICT: Move mod to the staging area to await user decision
            if !staging_path.exists() {
                 fs::create_dir_all(&staging_path).map_err(|e| e.to_string())?;
            }
            let staged_mod_path = staging_path.join(&mod_name);
            fs::rename(entry.path(), &staged_mod_path).map_err(|e| e.to_string())?;
            conflicts.push(ModInstallInfo {
                name: mod_name,
                temp_path: staged_mod_path.to_string_lossy().into_owned(),
            });
        } else {
            // NEW MOD: Move directly to the final mods folder
            fs::rename(entry.path(), &final_dest_path).map_err(|e| e.to_string())?;
            successes.push(ModInstallInfo {
                name: mod_name,
                temp_path: final_dest_path.to_string_lossy().into_owned(),
            });
        }
    }

    // Introduce a tiny delay to give the OS time to release the file handle
    thread::sleep(Duration::from_millis(100)); // 100ms
    
    // 5. Cleanup the initial extraction folder, which should now be empty
    fs::remove_dir_all(&temp_extract_path).ok();
    
    Ok(InstallationAnalysis {
        successes,
        conflicts,
        messy_archive_path: None,
    })
}

#[tauri::command]
/// Handles the user's decision to either replace an existing mod or cancel the update.
fn resolve_conflict(mod_name: String, temp_mod_path_str: String, replace: bool) -> Result<(), String> {
    let game_path = find_game_path().ok_or_else(|| "Could not find game path.".to_string())?;
    let mods_path = game_path.join("GAMEDATA").join("MODS");
    let final_mod_path = mods_path.join(&mod_name);
    let temp_mod_path = PathBuf::from(&temp_mod_path_str);

    if replace {
        // User confirmed replacement: delete old, move new
        if final_mod_path.exists() {
            fs::remove_dir_all(&final_mod_path).map_err(|e| format!("Failed to remove old mod: {}", e))?;
        }
        fs::rename(&temp_mod_path, &final_mod_path).map_err(|e| format!("Failed to move new mod into place: {}", e))?;
    } else {
        // User cancelled: just delete the temporary folder for this new mod
        fs::remove_dir_all(&temp_mod_path).map_err(|e| format!("Failed to cleanup temp mod folder: {}", e))?;
    }
    
    // Attempt to clean up the parent staging directory if it's now empty
    if let Some(parent) = temp_mod_path.parent() {
        if parent.exists() && parent.read_dir().map_or(false, |mut i| i.next().is_none()) {
             fs::remove_dir(parent).ok();
        }
    }

    Ok(())
}


// --- OTHER TAURI COMMANDS (Unchanged) ---
#[tauri::command]
fn delete_settings_file() -> Result<String, String> {
    if let Some(game_path) = find_game_path() {
        let settings_file = game_path.join("Binaries").join("SETTINGS").join("GCMODSETTINGS.MXML");
        if settings_file.exists() {
            fs::remove_file(&settings_file).map_err(|e| e.to_string())?;
            Ok("alertDeleteSuccess".to_string())
        } else {
            Ok("alertDeleteNotFound".to_string())
        }
    } else {
        Err("alertDeleteError".to_string())
    }
}

#[tauri::command]
fn get_game_path() -> Option<String> {
    find_game_path().map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn open_mods_folder() -> Result<(), String> {
    if let Some(game_path) = find_game_path() {
        let mods_path = game_path.join("GAMEDATA").join("MODS");
        fs::create_dir_all(&mods_path).map_err(|e| e.to_string())?;
        open::that(&mods_path).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Game path not found.".to_string())
    }
}

#[tauri::command]
fn save_file(file_path: String, content: String) -> Result<(), String> {
    fs::write(file_path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn minimize_window(app: tauri::AppHandle) {
    app.get_window("main").unwrap().minimize().unwrap();
}

#[tauri::command]
fn toggle_maximize_window(app: tauri::AppHandle) {
    let window = app.get_window("main").unwrap();
    if window.is_maximized().unwrap() {
        window.unmaximize().unwrap();
    } else {
        window.maximize().unwrap();
    }
}

#[tauri::command]
fn close_window(app: tauri::AppHandle) {
    app.get_window("main").unwrap().close().unwrap();
}

#[tauri::command]
fn finalize_mod_installation(temp_path: String, new_name: String) -> Result<(), String> {
    let temp_folder = PathBuf::from(temp_path);
    if !temp_folder.exists() {
        return Err("Temporary installation folder not found.".to_string());
    }
    let mods_path = temp_folder.parent().ok_or("Could not determine MODS folder path.")?;
    let final_dest_path = mods_path.join(new_name);
    if final_dest_path.exists() {
        return Err(format!("A mod folder with the name '{}' already exists.", final_dest_path.file_name().unwrap().to_string_lossy()));
    }
    fs::rename(temp_folder, final_dest_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn cleanup_temp_folder(path: String) -> Result<(), String> {
    let temp_folder = PathBuf::from(path);
    if temp_folder.exists() {
        fs::remove_dir_all(temp_folder).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn resize_window(window: tauri::Window, width: f64) -> Result<(), String> {
    let current_height = window.outer_size().map_err(|e| e.to_string())?.height;
    window.set_size(LogicalSize::new(width, current_height as f64))
          .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_mod(mod_name: String) -> Result<String, String> {
    // 1. Find Paths
    let game_path = find_game_path().ok_or_else(|| "Could not find game installation path.".to_string())?;
    let settings_file_path = game_path.join("Binaries").join("SETTINGS").join("GCMODSETTINGS.MXML");
    let mod_to_delete_path = game_path.join("GAMEDATA").join("MODS").join(&mod_name);

    // 2. Delete the Mod Folder
    if mod_to_delete_path.exists() {
        fs::remove_dir_all(&mod_to_delete_path)
            .map_err(|e| format!("Failed to delete mod folder for '{}': {}", mod_name, e))?;
    }

    // 3. Read and Deserialize
    let xml_content = fs::read_to_string(&settings_file_path)
        .map_err(|e| format!("Failed to read GCMODSETTINGS.MXML: {}", e))?;
    let mut root: SettingsData = from_str(&xml_content)
        .map_err(|e| format!("Failed to parse GCMODSETTINGS.MXML: {}", e))?;

    // 4. Modify the data in the structs
    for prop in root.properties.iter_mut() {
        if prop.name == "Data" {
            prop.mods.retain(|entry| {
                if let Some(name_prop) = entry.properties.iter().find(|p| p.name == "Name") {
                    if let Some(name_value) = &name_prop.value {
                        !name_value.eq_ignore_ascii_case(&mod_name)
                    } else { true }
                } else { true }
            });

            for (i, mod_entry) in prop.mods.iter_mut().enumerate() {
                let new_index = i.to_string();
                mod_entry.index = new_index.clone();
                if let Some(priority_prop) = mod_entry.properties.iter_mut().find(|p| p.name == "ModPriority") {
                    priority_prop.value = Some(new_index);
                }
            }
            break;
        }
    }

    // 5. Serialize and Re-format
    let unformatted_xml = to_string(&root).map_err(|e| e.to_string())?;
    let mut reader = Reader::from_str(&unformatted_xml);
    reader.trim_text(true);
    let mut writer = Writer::new_with_indent(Vec::new(), b' ', 2);
    loop {
        match reader.read_event() {
            Ok(Event::Eof) => break,
            Ok(event) => writer.write_event(event).unwrap(),
            Err(e) => return Err(format!("XML formatting error: {:?}", e)),
        }
    }
    let buf = writer.into_inner();
    let xml_body = String::from_utf8(buf).map_err(|e| e.to_string())?;
    let final_content = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n{}", xml_body);

    // 6. Return the perfect content to JavaScript, DO NOT SAVE.
    Ok(final_content)
}

// --- MAIN FUNCTION ---
fn main() {
    tauri::Builder::default()
        .manage(UserResized(std::sync::atomic::AtomicBool::new(false)))
        .setup(|app| {
            let window = app.get_window("main").unwrap();
            let state_file_path = get_state_file_path();

            if let Ok(state_json) = std::fs::read_to_string(state_file_path) {
                if let Ok(state) = serde_json::from_str::<WindowState>(&state_json) {
                    window.set_position(PhysicalPosition::new(state.x, state.y)).unwrap();
                    if let (Some(width), Some(height)) = (state.width, state.height) {
                        window.set_size(tauri::PhysicalSize::new(width, height)).unwrap();
                        let resize_state: tauri::State<UserResized> = app.state();
                        resize_state.0.store(true, std::sync::atomic::Ordering::Relaxed);
                    }
                    if state.maximized {
                        window.maximize().unwrap();
                    }
                }
            }
            window.show().unwrap(); 
            Ok(())
        })
        .on_window_event(|event| {
            match event.event() {
                tauri::WindowEvent::Resized(_) |
                tauri::WindowEvent::Moved(_) |
                tauri::WindowEvent::CloseRequested { .. } => {
                    let window = event.window();
                    let resize_state: tauri::State<UserResized> = window.state();
                    
                    if let tauri::WindowEvent::Resized(_) = event.event() {
                        if !window.is_maximized().unwrap_or(false) {
                            resize_state.0.store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                    }

                    let is_maximized = window.is_maximized().unwrap_or(false);

                    let mut state: WindowState = std::fs::read_to_string(get_state_file_path())
                        .ok()
                        .and_then(|json| serde_json::from_str(&json).ok())
                        .unwrap_or_else(|| {
                            let pos = window.outer_position().unwrap_or_default();
                            WindowState { x: pos.x, y: pos.y, width: None, height: None, maximized: false }
                        });
                    
                    state.maximized = is_maximized;

                    if !is_maximized {
                        let position = window.outer_position().unwrap();
                        state.x = position.x;
                        state.y = position.y;
                         if resize_state.0.load(std::sync::atomic::Ordering::Relaxed) {
                            let size = window.outer_size().unwrap();
                            state.width = Some(size.width);
                            state.height = Some(size.height);
                        }
                    }

                    if let Ok(state_json) = serde_json::to_string(&state) {
                        if let Err(e) = std::fs::write(get_state_file_path(), state_json) {
                            eprintln!("Failed to save window state: {}", e);
                        }
                    }
                    
                    if let tauri::WindowEvent::CloseRequested { .. } = event.event() {
                         window.app_handle().exit(0);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_game_path,
            open_mods_folder,
            save_file,
            minimize_window,
            toggle_maximize_window,
            close_window,
            delete_settings_file,
            install_mod_from_archive,
            resolve_conflict,
            finalize_mod_installation,
            cleanup_temp_folder,
            resize_window,
            delete_mod
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}