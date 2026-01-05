use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::models::ApiResponse;
use crate::services::api_client;
use crate::services::ApiClient;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopBranding {
    pub desktop_name: String,
    pub login_icon_key: String,
    #[serde(default)]
    pub login_background_key: String,
    pub updated_at: Option<String>,
}

fn is_localhost_base_url(base_url: &str) -> bool {
    let parsed = match Url::parse(base_url) {
        Ok(v) => v,
        Err(_) => return false,
    };
    matches!(
        parsed.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

/// 拉取 Desktop 品牌配置（在线模式使用；本地模式返回 None）
///
/// - 在线模式：GET /api/v1/desktop/branding（匿名）
/// - 本地模式（localhost）：返回 None（桌面端使用内置默认图标/名称）
#[tauri::command]
pub async fn fetch_desktop_branding() -> Result<Option<DesktopBranding>, String> {
    let base = api_client::get_api_base_url();
    if is_localhost_base_url(base.trim()) {
        return Ok(None);
    }

    let client = ApiClient::new();
    let resp: ApiResponse<DesktopBranding> = client.get("/desktop/branding").await?;
    if resp.success {
        Ok(resp.data)
    } else {
        Ok(None)
    }
}
