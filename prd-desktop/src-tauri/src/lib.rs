mod commands;
mod models;
mod services;

use tauri::Manager;
use tauri::Emitter;
use commands::session::StreamCancelState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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
            commands::session::get_session,
            commands::session::get_message_history,
            commands::session::switch_role,
            commands::session::send_message,
            commands::session::start_guide,
            commands::session::get_guide_step_content,
            commands::session::control_guide,
            commands::session::cancel_stream,
            commands::auth::login,
            commands::auth::register,
            commands::auth::set_auth_token,
            commands::group::create_group,
            commands::group::join_group,
            commands::group::get_groups,
            commands::group::open_group_session,
            commands::group::bind_group_prd,
            commands::group::dissolve_group,
            commands::config::get_config,
            commands::config::save_config,
            commands::config::get_default_api_url,
            commands::config::test_api_connection,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // warm-start deep link（macOS/iOS）：应用运行中收到 URL 打开事件
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                let _ = app_handle.emit("deep-link", url.to_string());
            }
        }
    });
}
