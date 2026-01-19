use tauri::Manager;

/// 打开开发者工具
#[tauri::command]
pub async fn open_devtools(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.open_devtools();
        Ok(())
    } else {
        Err("无法获取主窗口".to_string())
    }
}
