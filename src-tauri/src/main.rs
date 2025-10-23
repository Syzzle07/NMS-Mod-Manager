#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// --- IMPORTS ---
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{Manager, PhysicalPosition};
use unrar;
use winreg::enums::*;
use winreg::RegKey;
use zip::ZipArchive;

// --- STRUCTS ---
#[derive(Serialize, Deserialize)]
struct WindowState {
    x: i32,
    y: i32,
    maximized: bool,
}

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

// --- REWORKED MOD INSTALLATION LOGIC ---

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

// --- MAIN FUNCTION ---
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app.get_window("main").unwrap();
            let state_file_path = get_state_file_path();
            if let Ok(state_json) = fs::read_to_string(state_file_path) {
                if let Ok(state) = serde_json::from_str::<WindowState>(&state_json) {
                    window.set_position(PhysicalPosition::new(state.x, state.y)).unwrap();
                    if state.maximized {
                        window.maximize().unwrap();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|event| {
            match event.event() {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) | tauri::WindowEvent::CloseRequested { .. } => {
                    let window = event.window();
                    let is_maximized = window.is_maximized().unwrap_or(false);

                    if !is_maximized {
                        let position = window.outer_position().unwrap();
                        let state = WindowState {
                            x: position.x,
                            y: position.y,
                            maximized: false,
                        };

                        if let Ok(state_json) = serde_json::to_string(&state) {
                            if let Err(e) = fs::write(get_state_file_path(), state_json) {
                                eprintln!("Failed to save window state: {}", e);
                            }
                        }
                    } else {
                        let state_file_path = get_state_file_path();
                        if let Ok(state_json) = fs::read_to_string(&state_file_path) {
                            if let Ok(mut state) = serde_json::from_str::<WindowState>(&state_json) {
                                state.maximized = true;
                                if let Ok(new_state_json) = serde_json::to_string(&state) {
                                    if let Err(e) = fs::write(state_file_path, new_state_json) {
                                        eprintln!("Failed to save maximized state: {}", e);
                                    }
                                }
                            }
                        }
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
            install_mod_from_archive, // Reworked
            resolve_conflict,         // New
            finalize_mod_installation,
            cleanup_temp_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}