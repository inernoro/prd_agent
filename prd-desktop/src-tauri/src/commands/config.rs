use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tauri::Manager;
use uuid::Uuid;

use crate::services::api_client;

/// 应用配置结构
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub api_base_url: String,
    #[serde(default)]
    pub is_developer: bool,
    #[serde(default)]
    pub client_id: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            api_base_url: api_client::get_default_api_url(),
            is_developer: false,
            client_id: Uuid::new_v4().to_string(),
        }
    }
}

/// 获取配置文件路径
fn get_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    // 确保目录存在
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    }

    Ok(app_data_dir.join("config.json"))
}

/// 加载配置
fn load_config_from_file(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    let config_path = get_config_path(app)?;

    if config_path.exists() {
        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config file: {}", e))?;
        let mut parsed = serde_json::from_str::<AppConfig>(&content)
            .map_err(|e| format!("Failed to parse config file: {}", e))?;

        // 兼容旧配置：缺少 clientId 时自动补齐并落盘
        if parsed.client_id.trim().is_empty() {
            parsed.client_id = Uuid::new_v4().to_string();
            let _ = save_config_to_file(app, &parsed);
        }

        Ok(parsed)
    } else {
        Ok(AppConfig::default())
    }
}

/// 保存配置到文件
fn save_config_to_file(app: &tauri::AppHandle, config: &AppConfig) -> Result<(), String> {
    let config_path = get_config_path(app)?;
    let content = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;
    fs::write(&config_path, content).map_err(|e| format!("Failed to write config file: {}", e))
}

/// 获取当前配置
#[tauri::command]
pub async fn get_config(app: tauri::AppHandle) -> Result<AppConfig, String> {
    load_config_from_file(&app)
}

/// 保存配置
#[tauri::command]
pub async fn save_config(app: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    // 更新内存中的 API URL
    api_client::set_api_base_url(config.api_base_url.clone());
    // clientId：若前端未传（兼容旧版），则保留旧值或生成新值，避免写入空串导致 clientId 丢失
    let mut to_save = config.clone();
    if to_save.client_id.trim().is_empty() {
        let existing = load_config_from_file(&app).ok();
        to_save.client_id = existing
            .and_then(|x| if x.client_id.trim().is_empty() { None } else { Some(x.client_id) })
            .unwrap_or_else(|| Uuid::new_v4().to_string());
    }
    api_client::set_client_id(to_save.client_id.clone());

    // 持久化到文件
    save_config_to_file(&app, &to_save)
}

/// 获取默认 API 地址
#[tauri::command]
pub async fn get_default_api_url() -> String {
    api_client::get_default_api_url()
}

/// API 连接测试结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiTestResult {
    pub success: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub server_status: Option<String>,
}

fn is_localhost_url(api_base_url: &str) -> bool {
    let parsed = match Url::parse(api_base_url) {
        Ok(v) => v,
        Err(_) => return false,
    };

    matches!(
        parsed.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

/// 测试 API 连接
#[tauri::command]
pub async fn test_api_connection(api_url: String) -> ApiTestResult {
    // 对 localhost 自动绕过系统/环境代理，避免被全局代理截胡导致 503
    let mut builder = Client::builder().timeout(Duration::from_secs(10));
    if is_localhost_url(api_url.trim()) {
        builder = builder.no_proxy();
    }
    let client = builder.build().unwrap_or_default();

    let health_url = format!("{}/health", api_url.trim_end_matches('/'));
    let start = std::time::Instant::now();

    match client.get(&health_url).send().await {
        Ok(response) => {
            let latency = start.elapsed().as_millis() as u64;

            if response.status().is_success() {
                // 尝试解析 health 响应
                if let Ok(json) = response.json::<serde_json::Value>().await {
                    let status = json
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();

                    ApiTestResult {
                        success: true,
                        latency_ms: Some(latency),
                        error: None,
                        server_status: Some(status),
                    }
                } else {
                    ApiTestResult {
                        success: true,
                        latency_ms: Some(latency),
                        error: None,
                        server_status: Some("ok".to_string()),
                    }
                }
            } else {
                ApiTestResult {
                    success: false,
                    latency_ms: Some(latency),
                    error: Some(format!("HTTP {}", response.status().as_u16())),
                    server_status: None,
                }
            }
        }
        Err(e) => {
            let error_msg = if e.is_timeout() {
                "连接超时".to_string()
            } else if e.is_connect() {
                "无法连接到服务器".to_string()
            } else {
                format!("连接失败: {}", e)
            };

            ApiTestResult {
                success: false,
                latency_ms: None,
                error: Some(error_msg),
                server_status: None,
            }
        }
    }
}

/// 初始化配置（应用启动时调用）
#[allow(unused_variables)]
pub fn init_config(app: &tauri::AppHandle) {
    // 规则（避免“我明明改了配置但请求没打到目标服务器”）：
    // 1) 优先使用环境变量 API_BASE_URL（在 api_client.rs 中已读取并初始化）
    // 2) 若有 config.json，则使用其中的 apiBaseUrl 覆盖
    // 3) 否则保持默认值（DEFAULT_API_URL）
    //
    // 注意：debug 模式不再强制写死 localhost:5000，允许你本地/容器映射到其他端口。
    if let Ok(config) = load_config_from_file(app) {
        let trimmed = config.api_base_url.trim().to_string();
        if !trimmed.is_empty() {
            api_client::set_api_base_url(trimmed);
        }

        if !config.client_id.trim().is_empty() {
            api_client::set_client_id(config.client_id);
        }
    }
}
