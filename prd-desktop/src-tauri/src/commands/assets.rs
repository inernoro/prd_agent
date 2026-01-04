use tauri::command;

use crate::models::{ApiResponse, DesktopSkinsResponse};
use crate::services::api_client::ApiClient;

/// Desktop：获取可用皮肤列表（后端仅返回 skin 名称）
#[command]
pub async fn get_desktop_asset_skins() -> Result<ApiResponse<DesktopSkinsResponse>, String> {
    let client = ApiClient::new();
    client.get("/assets/desktop/skins").await
}
