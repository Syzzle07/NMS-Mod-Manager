#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use winreg::enums::*;
use winreg::RegKey;
use tauri::Manager;
use zip::ZipArchive;
use unrar;

#[tauri::command]
fn install_mod_from_archive(archive_path_str: String) -> Result<String, String> {
    let archive_path = Path::new(&archive_path_str);
    let extension = archive_path.extension().and_then(std::ffi::OsStr::to_str).unwrap_or("");
    let file_name = archive_path.file_name().unwrap_or_default().to_string_lossy();
    
    let game_path = find_game_path().ok_or("Could not find the game installation path.")?;
    let mods_path = game_path.join("GAMEDATA").join("MODS");
    fs::create_dir_all(&mods_path).map_err(|e| e.to_string())?;

    match extension.to_lowercase().as_str() {
        "zip" => extract_zip(archive_path, &mods_path)?,
        "rar" => extract_rar(archive_path, &mods_path)?,
        _ => return Err(format!("Unsupported file type: .{}", extension)),
    }
    
    Ok(format!("Successfully installed '{}' to the MODS folder.", file_name))
}

fn extract_zip(zip_path: &Path, dest_path: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("Failed to open zip file: {}", e))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {}", e))?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).unwrap();
        if let Some(outpath) = file.enclosed_name().map(|p| dest_path.join(p)) {
            if (*file.name()).ends_with('/') {
                fs::create_dir_all(&outpath).unwrap();
            } else {
                if let Some(p) = outpath.parent() { if !p.exists() { fs::create_dir_all(&p).unwrap(); } }
                let mut outfile = fs::File::create(&outpath).unwrap();
                io::copy(&mut file, &mut outfile).unwrap();
            }
        }
    }
    Ok(())
}

fn extract_rar(rar_path: &Path, dest_path: &Path) -> Result<(), String> {
    let mut archive = unrar::Archive::new(rar_path)
        .open_for_processing()
        .map_err(|e| format!("Failed to open RAR file: {:?}", e))?;

    while let Ok(Some(header)) = archive.read_header() {
        let outpath = dest_path.join(header.entry().filename.to_string_lossy().to_string());
        
        archive = if header.entry().is_file() {
            if let Some(p) = outpath.parent() {
                if !p.exists() { fs::create_dir_all(&p).unwrap(); }
            }
            header.extract_to(outpath)
                  .map_err(|e| format!("Failed to extract file from RAR: {:?}", e))?
        } else {
            fs::create_dir_all(&outpath).unwrap();
            header.skip()
                  .map_err(|e| format!("Failed to process directory entry in RAR: {:?}", e))?
        };
    }
    Ok(())
}


#[tauri::command]
fn delete_settings_file() -> Result<String, String> {
    if let Some(game_path) = find_game_path() {
        let settings_file = game_path.join("Binaries").join("SETTINGS").join("GCMODSETTINGS.MXML");
        if settings_file.exists() {
            fs::remove_file(&settings_file).map_err(|e| e.to_string())?;
            Ok("GCMODSETTINGS.MXML has been deleted successfully.".to_string())
        } else {
            Ok("GCMODSETTINGS.MXML was not found (it may have already been deleted).".to_string())
        }
    } else {
        Err("Could not find game path. File was not deleted.".to_string())
    }
}

#[tauri::command]
fn get_game_path() -> Option<String> { find_game_path().map(|p| p.to_string_lossy().into_owned()) }

#[tauri::command]
fn open_mods_folder() -> Result<(), String> {
    if let Some(game_path) = find_game_path() {
        let mods_path = game_path.join("GAMEDATA").join("MODS");
        fs::create_dir_all(&mods_path).map_err(|e| e.to_string())?;
        open::that(&mods_path).map_err(|e| e.to_string())?;
        Ok(())
    } else { Err("Game path not found.".to_string()) }
}

#[tauri::command]
fn save_file(file_path: String, content: String) -> Result<(), String> { fs::write(file_path, content).map_err(|e| e.to_string()) }

#[tauri::command]
fn minimize_window(app: tauri::AppHandle) { app.get_window("main").unwrap().minimize().unwrap(); }

#[tauri::command]
fn toggle_maximize_window(app: tauri::AppHandle) {
    let window = app.get_window("main").unwrap();
    if window.is_maximized().unwrap() { window.unmaximize().unwrap(); } 
    else { window.maximize().unwrap(); }
}

#[tauri::command]
fn close_window(app: tauri::AppHandle) { app.get_window("main").unwrap().close().unwrap(); }

fn find_game_path() -> Option<PathBuf> { if cfg!(not(windows)) { return None; } find_steam_path().or_else(find_gog_path) }

fn find_gog_path() -> Option<PathBuf> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let gog_key = hklm.open_subkey(r"SOFTWARE\WOW6432Node\GOG.com\Games\1446223351").ok()?;
    let game_path_str: String = gog_key.get_value("PATH").ok()?;
    let game_path = PathBuf::from(game_path_str);
    if game_path.join("Binaries").is_dir() { Some(game_path) } else { None }
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
                if p.exists() { library_folders.push(p); }
            }
        }
    }
    for folder in library_folders {
        let manifest_path = folder.join("steamapps").join("appmanifest_275850.acf");
        if let Ok(content) = fs::read_to_string(manifest_path) {
            if let Some(dir_str) = content.lines().find(|l| l.contains("\"installdir\"")).and_then(|l| l.split('"').nth(3)) {
                let game_path = folder.join("steamapps").join("common").join(dir_str);
                if game_path.is_dir() { return Some(game_path); }
            }
        }
    }
    None
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            get_game_path, open_mods_folder, save_file,
            minimize_window, toggle_maximize_window, close_window,
            delete_settings_file,
            install_mod_from_archive
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}