use serde::{Deserialize, Serialize};

use crate::models::ApiResponse;
use crate::services::api_client;
use crate::services::ApiClient;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBranding {
    pub desktop_name: String,
    #[serde(default)]
    pub desktop_subtitle: String,
    #[serde(default)]
    pub window_title: String,
    pub login_icon_key: String,
    #[serde(default)]
    pub login_background_key: String,
    pub updated_at: Option<String>,
}

/// 拉取 Desktop 品牌配置（在线模式使用；本地模式返回 None）
///
/// - 在线模式：GET /api/v1/desktop/branding（匿名）
/// - 拉取失败：返回 None（桌面端使用内置默认图标/名称）
#[tauri::command]
pub async fn fetch_desktop_branding() -> Result<Option<DesktopBranding>, String> {
    // best-effort：拉取失败回退到 None
    let _ = api_client::get_api_base_url();

    let client = ApiClient::new();
    let resp: ApiResponse<DesktopBranding> = client.get("/desktop/branding").await?;
    if resp.success {
        Ok(resp.data)
    } else {
        Ok(None)
    }
}
