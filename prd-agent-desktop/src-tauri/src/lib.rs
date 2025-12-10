mod commands;
mod services;
mod models;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::document::upload_document,
            commands::document::get_document,
            commands::session::get_session,
            commands::session::switch_role,
            commands::session::send_message,
            commands::session::start_guide,
            commands::session::control_guide,
            commands::auth::login,
            commands::auth::register,
            commands::group::create_group,
            commands::group::join_group,
            commands::group::get_groups,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}


