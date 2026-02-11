mod commands;
mod models;
mod services;

use commands::session::StreamCancelState;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    fn updater_target_triple() -> &'static str {
        // NOTE: our GitHub Release assets are named as `latest-<target-triple>.json`.
        // Examples:
        // - aarch64-apple-darwin
        // - x86_64-apple-darwin
        // - x86_64-pc-windows-msvc
        // - x86_64-unknown-linux-gnu
        if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
            "aarch64-apple-darwin"
        } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
            "x86_64-apple-darwin"
        } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
            "x86_64-pc-windows-msvc"
        } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86") {
            "i686-pc-windows-msvc"
        } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
            "x86_64-unknown-linux-gnu"
        } else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
            "aarch64-unknown-linux-gnu"
        } else {
            // fallback: keep the app running; updater will likely fail with a clear error message.
            "unknown"
        }
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .target(updater_target_triple())
                .build(),
        )
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

            // macOS：使用"覆盖式/透明"标题栏，让 WebView 内容延伸到最顶部（类似无白色标题栏）
            // 说明：这会让红绿灯悬浮在内容之上，前端需自行留出安全区并提供可拖拽区域。
            #[cfg(target_os = "macos")]
            {
                use tauri::TitleBarStyle;
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title_bar_style(TitleBarStyle::Overlay);
                }
            }

            // 创建自定义菜单
            let settings_item = MenuItemBuilder::new("设置...")
                .id("settings")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;

            let devtools_item = MenuItemBuilder::new("开发者工具")
                .id("devtools")
                .accelerator("CmdOrCtrl+Shift+I")
                .build(app)?;

            let check_update_item = MenuItemBuilder::new("检查更新...")
                .id("check_update")
                .build(app)?;

            // macOS 需要 Edit 子菜单才能让 Cmd+C/V/X/A 等快捷键在 WebView 中生效
            let edit_submenu = SubmenuBuilder::new(app, "编辑")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;

            let help_submenu = SubmenuBuilder::new(app, "帮助")
                .item(&settings_item)
                .separator()
                .item(&devtools_item)
                .separator()
                .item(&check_update_item)
                .build()?;

            let menu = MenuBuilder::new(app).items(&[&edit_submenu, &help_submenu]).build()?;

            app.set_menu(menu)?;

            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => {
                let _ = app.emit("open-settings", ());
            }
            "devtools" => {
                if let Some(window) = app.get_webview_window("main") {
                    window.open_devtools();
                }
            }
            "check_update" => {
                let app_handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    let current_version = app_handle.package_info().version.to_string();
                    match app_handle.updater() {
                        Ok(updater) => match updater.check().await {
                            Ok(Some(update)) => {
                                let version = update.version.clone();
                                let body = update
                                    .body
                                    .clone()
                                    .unwrap_or_else(|| "请前往下载更新".to_string());
                                app_handle
                                    .dialog()
                                    .message(format!("发现新版本 {}\n\n{}", version, body))
                                    .title("检查更新")
                                    .kind(MessageDialogKind::Info)
                                    .blocking_show();
                            }
                            Ok(None) => {
                                app_handle
                                    .dialog()
                                    .message(format!("当前已是最新版本 ({})", current_version))
                                    .title("检查更新")
                                    .kind(MessageDialogKind::Info)
                                    .blocking_show();
                            }
                            Err(e) => {
                                app_handle
                                    .dialog()
                                    .message(format!("检查更新失败: {}", e))
                                    .title("检查更新")
                                    .kind(MessageDialogKind::Error)
                                    .blocking_show();
                            }
                        },
                        Err(e) => {
                            app_handle
                                .dialog()
                                .message(format!("检查更新失败: {}", e))
                                .title("检查更新")
                                .kind(MessageDialogKind::Error)
                                .blocking_show();
                        }
                    }
                });
            }
            _ => {}
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
            commands::session::create_chat_run,
            commands::session::subscribe_chat_run,
            commands::session::cancel_chat_run,
            commands::session::resend_message,
            commands::session::get_prompts,
            commands::session::cancel_stream,
            commands::session::preview_ask_in_section,
            commands::auth::login,
            commands::auth::set_auth_token,
            commands::auth::set_auth_session,
            commands::branding::fetch_desktop_branding,
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
            commands::config::run_network_diagnostics,
            commands::preview_ask_history::get_preview_ask_history,
            commands::preview_ask_history::append_preview_ask_history,
            commands::preview_ask_history::clear_preview_ask_history,
            commands::preview_ask_history::clear_all_preview_ask_history,
            commands::preview_ask_history::get_preview_ask_history_stats,
            commands::updater::get_updater_platform_info,
            commands::updater::check_for_update,
            commands::updater::fetch_update_manifests,
            commands::defect::list_defects,
            commands::defect::create_defect,
            commands::defect::submit_defect,
            commands::defect::get_defect,
            commands::defect::get_defect_messages,
            commands::defect::send_defect_message,
            commands::defect::process_defect,
            commands::defect::resolve_defect,
            commands::defect::reject_defect,
            commands::defect::get_defect_stats,
            commands::devtools::open_devtools,
            commands::attachment::upload_attachment,
            commands::skill::get_skills,
            commands::skill::execute_skill,
            commands::skill::create_skill,
            commands::skill::update_skill,
            commands::skill::delete_skill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
        match &_event {
            // 应用退出：取消所有 SSE 流 + 停止心跳，确保资源优雅释放
            tauri::RunEvent::ExitRequested { .. } => {
                if let Some(cancel_state) = _app_handle.try_state::<StreamCancelState>() {
                    cancel_state.cancel_all();
                }
                services::api_client::stop_desktop_presence_heartbeat();
            }
            // warm-start deep link（macOS/iOS）：应用运行中收到 URL 打开事件
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            tauri::RunEvent::Opened { urls } => {
                for url in urls {
                    let _ = _app_handle.emit("deep-link", url.to_string());
                }
            }
            _ => {}
        }
    });
}
