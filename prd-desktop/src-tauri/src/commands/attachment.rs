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

/// Consume a single-use selection created by the native file picker.
#[command]
pub async fn upload_attachment(
    window: tauri::WebviewWindow,
    selections: tauri::State<'_, super::file_selection::FileSelections>,
    selection_id: String,
) -> Result<ApiResponse<UploadAttachmentResponse>, String> {
    let selected = super::file_selection::consume_selection(
        &window,
        selections,
        &selection_id,
        super::file_selection::FilePurpose::Attachment,
        None,
    )?;
    let bytes = selected.bytes;
    let fname = selected.name;
    let path = std::path::Path::new(&fname);

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

    let response = req.send().await.map_err(|e| format!("上传失败: {}", e))?;

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
