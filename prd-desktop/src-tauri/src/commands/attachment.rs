use serde::{Deserialize, Serialize};
use tauri::command;

use crate::models::ApiResponse;
use crate::services::api_client;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadAttachmentResponse {
    pub attachment_id: String,
    pub url: String,
    pub file_name: String,
    pub mime_type: String,
    pub size: i64,
}

/// 上传附件（图片）到服务端
/// - file_path: 本地文件路径（由 Tauri file dialog 选取）
/// - file_name: 原始文件名
#[command]
pub async fn upload_attachment(
    file_path: String,
    file_name: Option<String>,
) -> Result<ApiResponse<UploadAttachmentResponse>, String> {
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err("文件不存在".to_string());
    }

    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("读取文件失败: {}", e))?;

    // 限制 5MB
    if bytes.len() > 5 * 1024 * 1024 {
        return Err("文件大小不能超过 5MB".to_string());
    }

    let fname = file_name.unwrap_or_else(|| {
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });

    // 推断 MIME type
    let mime = match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    };

    // 构建 multipart form
    let base_url = api_client::get_api_base_url();
    let url = format!("{}/api/v1/attachments", base_url);

    let client = api_client::build_http_client(&base_url);

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(fname.clone())
        .mime_str(mime)
        .map_err(|e| format!("构建请求失败: {}", e))?;

    let form = reqwest::multipart::Form::new().part("file", part);

    let mut req = client.post(&url).multipart(form);

    // 添加公共 header
    req = req.header("X-Client", "desktop");
    if let Some(cid) = api_client::get_client_id_pub() {
        if !cid.trim().is_empty() {
            req = req.header("X-Client-Id", cid);
        }
    }
    if let Some(token) = api_client::get_auth_token() {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("上传失败: {}", e))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if text.is_empty() {
        return Err(format!("服务器响应为空，状态码: {}", status));
    }

    serde_json::from_str::<ApiResponse<UploadAttachmentResponse>>(&text).map_err(|e| {
        format!(
            "解析响应失败: {}。状态: {}。响应: {}",
            e,
            status,
            &text[..text.len().min(500)]
        )
    })
}
