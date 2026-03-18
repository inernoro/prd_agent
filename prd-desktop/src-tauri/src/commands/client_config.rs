use serde::{Deserialize, Serialize};

/// 远程客户端配置（从 GitHub Release 产物拉取）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConfig {
    pub version: u32,
    pub default_api_url: String,
    pub preset_servers: Vec<PresetServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetServer {
    pub label: String,
    pub url: String,
}

const CLIENT_CONFIG_URL: &str =
    "https://github.com/inernoro/prd_agent/releases/latest/download/client-config.json";

/// 从 GitHub Release 拉取客户端配置（绕过浏览器 CORS）
#[tauri::command]
pub async fn fetch_client_config() -> Result<ClientConfig, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .get(CLIENT_CONFIG_URL)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("请求客户端配置失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!(
            "获取客户端配置失败: HTTP {}",
            resp.status().as_u16()
        ));
    }

    let config = resp
        .json::<ClientConfig>()
        .await
        .map_err(|e| format!("解析客户端配置失败: {}", e))?;

    Ok(config)
}
