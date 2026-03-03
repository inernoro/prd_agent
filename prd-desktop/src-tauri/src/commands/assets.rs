use tauri::command;

use crate::models::{ApiResponse, DesktopSkinsResponse, MyAssetsResponse};
use crate::services::api_client::ApiClient;

/// Desktop：获取可用皮肤列表（后端仅返回 skin 名称）
#[command]
pub async fn get_desktop_asset_skins() -> Result<ApiResponse<DesktopSkinsResponse>, String> {
    let client = ApiClient::new();
    client.get("/assets/desktop/skins").await
}

/// Desktop：获取当前用户的资产列表（图片/文档/附件）
#[command]
pub async fn get_my_assets(
    category: Option<String>,
    limit: Option<i32>,
    skip: Option<i32>,
) -> Result<ApiResponse<MyAssetsResponse>, String> {
    let client = ApiClient::new();

    let mut params: Vec<String> = Vec::new();
    if let Some(cat) = category.filter(|s| !s.trim().is_empty()) {
        params.push(format!("category={}", cat));
    }
    if let Some(l) = limit {
        params.push(format!("limit={}", l.max(1).min(100)));
    }
    if let Some(s) = skip {
        params.push(format!("skip={}", s.max(0)));
    }

    let url = if params.is_empty() {
        "/mobile/assets".to_string()
    } else {
        format!("/mobile/assets?{}", params.join("&"))
    };

    client.get(&url).await
}
