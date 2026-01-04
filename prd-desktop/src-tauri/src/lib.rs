mod commands;
mod models;
mod services;

use commands::session::StreamCancelState;
use tauri::Emitter;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.manage(StreamCancelState::default());
            // 初始化配置（从文件加载 API URL）
            commands::config::init_config(app.handle());

            // cold-start deep link：从启动参数中读取 prdagent://... 并发给前端处理
            if let Some(url) = std::env::args().find(|a| a.starts_with("prdagent://")) {
                let _ = app.emit("deep-link", url);
            }

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
            commands::document::get_document_content,
            commands::intent::suggest_group_name,
            commands::session::get_session,
            commands::session::get_message_history,
            commands::session::get_group_message_history,
            commands::session::subscribe_group_messages,
            commands::session::switch_role,
            commands::session::send_message,
            commands::session::resend_message,
            commands::session::get_prompts,
            commands::session::cancel_stream,
            commands::session::preview_ask_in_section,
            commands::auth::login,
            commands::auth::register,
            commands::auth::set_auth_token,
            commands::auth::set_auth_session,
            commands::assets::get_desktop_asset_skins,
            commands::group::create_group,
            commands::group::join_group,
            commands::group::get_groups,
            commands::group::open_group_session,
            commands::group::bind_group_prd,
            commands::group::dissolve_group,
            commands::group::get_group_members,
            commands::group::clear_group_context,
            commands::prd_comments::get_prd_comments,
            commands::prd_comments::create_prd_comment,
            commands::prd_comments::delete_prd_comment,
            commands::config::get_config,
            commands::config::save_config,
            commands::config::get_default_api_url,
            commands::config::test_api_connection,
            commands::preview_ask_history::get_preview_ask_history,
            commands::preview_ask_history::append_preview_ask_history,
            commands::preview_ask_history::clear_preview_ask_history,
            commands::preview_ask_history::clear_all_preview_ask_history,
            commands::preview_ask_history::get_preview_ask_history_stats,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
        // warm-start deep link（macOS/iOS）：应用运行中收到 URL 打开事件
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = _event {
            for url in urls {
                let _ = _app_handle.emit("deep-link", url.to_string());
            }
        }
    });
}
