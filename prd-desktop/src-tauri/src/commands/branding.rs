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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login_background_url: Option<String>,
    #[serde(default)]
    pub assets: std::collections::HashMap<String, String>,
    pub updated_at: Option<String>,
}

/// 拉取 Desktop 品牌配置（在线模式使用；本地模式返回 None）
///
/// - 在线模式：GET /api/v1/desktop/branding?skin={skin}（匿名）
/// - skin: 可选，white/dark，用于获取对应皮肤的资源 URL（带回退逻辑）
/// - 拉取失败：返回 None（桌面端使用内置默认图标/名称）
#[tauri::command]
pub async fn fetch_desktop_branding(
    skin: Option<String>,
) -> Result<Option<DesktopBranding>, String> {
    // best-effort：拉取失败回退到 None
    let _ = api_client::get_api_base_url();

    let client = ApiClient::new();

    // 构建 URL，如果有 skin 参数则添加查询参数
    let url = if let Some(s) = skin {
        let s_normalized = s.trim().to_lowercase();
        if s_normalized == "white" || s_normalized == "dark" {
            format!("/desktop/branding?skin={}", s_normalized)
        } else {
            "/desktop/branding".to_string()
        }
    } else {
        "/desktop/branding".to_string()
    };

    let resp: ApiResponse<DesktopBranding> = client.get(&url).await?;
    if resp.success {
        Ok(resp.data)
    } else {
        Ok(None)
    }
}
