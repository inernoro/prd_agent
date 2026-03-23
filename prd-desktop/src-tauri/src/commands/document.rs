use serde::Serialize;
use tauri::command;

use crate::models::{
    ApiResponse, DocumentContentInfo, DocumentInfo, SessionInfo, UploadDocumentResponse,
};
use crate::services::ApiClient;

#[derive(Serialize)]
struct UploadDocumentRequest {
    content: String,
}

#[command]
pub async fn upload_document(
    content: String,
) -> Result<ApiResponse<UploadDocumentResponse>, String> {
    let client = ApiClient::new();
    let request = UploadDocumentRequest { content };

    client.post("/documents", &request).await
}

#[command]
pub async fn get_document(document_id: String) -> Result<ApiResponse<DocumentInfo>, String> {
    let client = ApiClient::new();
    client.get(&format!("/documents/{}", document_id)).await
}

#[command]
pub async fn get_document_content(
    document_id: String,
    group_id: String,
) -> Result<ApiResponse<DocumentContentInfo>, String> {
    let client = ApiClient::new();
    client
        .get(&format!(
            "/documents/{}/content?groupId={}",
            document_id, group_id
        ))
        .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AddDocumentToSessionRequest {
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    document_type: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateDocumentTypeRequest {
    document_type: String,
}

#[command]
pub async fn add_document_to_session(
    session_id: String,
    content: String,
    document_type: Option<String>,
) -> Result<ApiResponse<SessionInfo>, String> {
    let client = ApiClient::new();
    let request = AddDocumentToSessionRequest {
        content,
        document_type,
    };
    client
        .post(&format!("/sessions/{}/documents", session_id), &request)
        .await
}

#[command]
pub async fn remove_document_from_session(
    session_id: String,
    document_id: String,
) -> Result<ApiResponse<SessionInfo>, String> {
    let client = ApiClient::new();
    client
        .delete(&format!(
            "/sessions/{}/documents/{}",
            session_id, document_id
        ))
        .await
}

/// 读取文本文件内容（UTF-8）
#[command]
pub async fn read_text_file(file_path: String) -> Result<String, String> {
    std::fs::read_to_string(&file_path).map_err(|e| format!("读取文件失败: {}", e))
}

/// 上传文件到会话（支持 PDF/Word/Excel/PPT 等二进制格式）
#[command]
pub async fn upload_file_to_session(
    session_id: String,
    file_path: String,
    document_type: Option<String>,
) -> Result<ApiResponse<SessionInfo>, String> {
    let path = std::path::Path::new(&file_path);
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {}", e))?;
    let file_name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // 推断 MIME type
    let mime = match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("pdf") => "application/pdf",
        Some("doc") => "application/msword",
        Some("docx") => {
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        }
        Some("xls") => "application/vnd.ms-excel",
        Some("xlsx") => {
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        }
        Some("ppt") => "application/vnd.ms-powerpoint",
        Some("pptx") => {
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        }
        Some("md") | Some("mdc") => "text/markdown",
        Some("txt") | Some("log") => "text/plain",
        Some("csv") => "text/csv",
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        Some("html") | Some("htm") => "text/html",
        _ => "application/octet-stream",
    };

    let client = ApiClient::new();
    let api_path = if let Some(ref dt) = document_type {
        format!(
            "/sessions/{}/documents/upload?documentType={}",
            session_id, dt
        )
    } else {
        format!("/sessions/{}/documents/upload", session_id)
    };
    client
        .post_file(&api_path, bytes, file_name, mime.to_string())
        .await
}

#[command]
pub async fn update_document_type(
    session_id: String,
    document_id: String,
    document_type: String,
) -> Result<ApiResponse<SessionInfo>, String> {
    let client = ApiClient::new();
    let request = UpdateDocumentTypeRequest { document_type };
    client
        .patch(
            &format!("/sessions/{}/documents/{}/type", session_id, document_id),
            &request,
        )
        .await
}
