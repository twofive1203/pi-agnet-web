// Prevents an extra console window on Windows in release builds. Without this,
// the NSIS-installed exe is built as a console subsystem, so Windows spawns a
// command window whose close event terminates the whole pet process.
// DO NOT REMOVE.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    snail_pi_pet_tauri_preview_lib::run();
}
