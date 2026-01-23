use serde::Serialize;
use tauri::command;

use crate::models::{ApiResponse, DocumentContentInfo, DocumentInfo, UploadDocumentResponse};
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
