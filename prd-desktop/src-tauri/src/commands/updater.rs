use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

use crate::services::api_client;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 是否有可用更新
    pub available: bool,
    /// 当前版本
    pub current_version: String,
    /// 新版本号（如果有）
    pub version: Option<String>,
    /// 更新日志（如果有）
    pub body: Option<String>,
}

/// 单个 manifest fetch 结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFetchResult {
    pub url: String,
    pub status: u16,
    pub status_text: String,
    pub ok: bool,
    pub body: Option<String>,
    pub error: Option<String>,
}

/// fetch_update_manifests 的返回结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchManifestsResult {
    pub target: String,
    pub results: Vec<ManifestFetchResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterPlatformInfo {
    /// Target triple used by our GitHub Release assets naming (e.g. x86_64-pc-windows-msvc)
    pub target: String,
    /// x86_64 / aarch64 / i686 / armv7 / ...
    pub arch: String,
    /// manifest key format we use for updater matching
    pub json_target: String,
}

/// 加速更新检查结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceleratedUpdateResult {
    /// 使用的更新源：accelerated / github / failed
    pub source: String,
    /// manifest JSON（成功时）
    pub manifest: Option<String>,
    /// 错误信息（失败时）
    pub error: Option<String>,
    /// 加速端点耗时 ms（无论成功失败都记录）
    pub accelerated_latency_ms: Option<u64>,
    /// GitHub 端点耗时 ms（仅回退时记录）
    pub github_latency_ms: Option<u64>,
}

fn get_updater_target_triple() -> &'static str {
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
        "unknown"
    }
}

fn get_updater_arch() -> &'static str {
    if cfg!(target_arch = "x86") {
        "i686"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "arm") {
        "armv7"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "riscv64") {
        "riscv64"
    } else {
        "unknown"
    }
}

/// 构建加速更新端点 URL
fn build_accelerated_url(target: &str) -> String {
    let base = api_client::get_api_base_url();
    format!(
        "{}/api/v1/desktop/update/latest-{}.json",
        base.trim_end_matches('/'),
        target
    )
}

/// 构建 GitHub 更新端点 URL
fn build_github_url(target: &str) -> String {
    format!(
        "https://github.com/inernoro/prd_agent/releases/latest/download/latest-{}.json",
        target
    )
}

/// 获取 updater 当前平台信息（用于前端展示/诊断更新源的 manifest 命名）
#[tauri::command]
pub async fn get_updater_platform_info() -> UpdaterPlatformInfo {
    let target = get_updater_target_triple().to_string();
    let arch = get_updater_arch().to_string();
    let json_target = target.clone();
    UpdaterPlatformInfo {
        target,
        arch,
        json_target,
    }
}

/// 检查是否有可用更新
#[tauri::command]
pub async fn check_for_update(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current_version = app.package_info().version.to_string();

    let updater = app.updater().map_err(|e| e.to_string())?;

    match updater.check().await {
        Ok(Some(update)) => Ok(UpdateInfo {
            available: true,
            current_version,
            version: Some(update.version.clone()),
            body: update.body.clone(),
        }),
        Ok(None) => Ok(UpdateInfo {
            available: false,
            current_version,
            version: None,
            body: None,
        }),
        Err(e) => Err(format!("检查更新失败: {}", e)),
    }
}

/// 加速更新检查：先尝试管理后台加速端点（3 秒超时），失败则回退 GitHub。
/// 前端可用此命令获取 manifest 以展示更新信息，实际下载仍走 Tauri updater。
#[tauri::command]
pub async fn fetch_accelerated_manifest() -> AcceleratedUpdateResult {
    let target = get_updater_target_triple();
    let accel_url = build_accelerated_url(target);
    let github_url = build_github_url(target);

    // 1. 尝试加速端点（3 秒超时）
    let accel_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .unwrap_or_default();

    let accel_start = std::time::Instant::now();
    let accel_result = accel_client
        .get(&accel_url)
        .header("Accept", "application/json")
        .send()
        .await;
    let accel_latency = accel_start.elapsed().as_millis() as u64;

    match accel_result {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(body) = resp.text().await {
                return AcceleratedUpdateResult {
                    source: "accelerated".to_string(),
                    manifest: Some(body),
                    error: None,
                    accelerated_latency_ms: Some(accel_latency),
                    github_latency_ms: None,
                };
            }
        }
        _ => {
            // 加速端点不可用，记录日志继续
        }
    }

    // 2. 回退 GitHub（30 秒超时）
    let github_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default();

    let github_start = std::time::Instant::now();
    let github_result = github_client
        .get(&github_url)
        .header("Accept", "application/json")
        .send()
        .await;
    let github_latency = github_start.elapsed().as_millis() as u64;

    match github_result {
        Ok(resp) if resp.status().is_success() => match resp.text().await {
            Ok(body) => AcceleratedUpdateResult {
                source: "github".to_string(),
                manifest: Some(body),
                error: None,
                accelerated_latency_ms: Some(accel_latency),
                github_latency_ms: Some(github_latency),
            },
            Err(e) => AcceleratedUpdateResult {
                source: "failed".to_string(),
                manifest: None,
                error: Some(format!("读取 GitHub 响应失败: {}", e)),
                accelerated_latency_ms: Some(accel_latency),
                github_latency_ms: Some(github_latency),
            },
        },
        Ok(resp) => AcceleratedUpdateResult {
            source: "failed".to_string(),
            manifest: None,
            error: Some(format!("GitHub 返回 HTTP {}", resp.status().as_u16())),
            accelerated_latency_ms: Some(accel_latency),
            github_latency_ms: Some(github_latency),
        },
        Err(e) => AcceleratedUpdateResult {
            source: "failed".to_string(),
            manifest: None,
            error: Some(format!("GitHub 请求失败: {}", e)),
            accelerated_latency_ms: Some(accel_latency),
            github_latency_ms: Some(github_latency),
        },
    }
}

/// 在后端 fetch 更新 manifest（绕过浏览器 CORS 限制）
/// 用于诊断更新源是否可访问、返回内容是否正确
/// 同时检查加速端点和 GitHub 端点
#[tauri::command]
pub async fn fetch_update_manifests() -> Result<FetchManifestsResult, String> {
    let target = get_updater_target_triple().to_string();

    let candidates = vec![build_accelerated_url(&target), build_github_url(&target)];

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let mut results = Vec::new();

    for url in candidates {
        let result = match client
            .get(&url)
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let status_text = resp
                    .status()
                    .canonical_reason()
                    .unwrap_or("Unknown")
                    .to_string();
                let ok = resp.status().is_success();

                let body = match resp.text().await {
                    Ok(text) => Some(text),
                    Err(e) => Some(format!("[读取响应体失败: {}]", e)),
                };

                ManifestFetchResult {
                    url: url.clone(),
                    status,
                    status_text,
                    ok,
                    body,
                    error: None,
                }
            }
            Err(e) => ManifestFetchResult {
                url: url.clone(),
                status: 0,
                status_text: "Request Failed".to_string(),
                ok: false,
                body: None,
                error: Some(e.to_string()),
            },
        };

        results.push(result);
    }

    Ok(FetchManifestsResult { target, results })
}
