use serde::Serialize;
use tauri_plugin_updater::UpdaterExt;

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
