use serde::Serialize;
use tauri::command;

use crate::models::{ApiResponse, DocumentContentInfo, DocumentInfo, SessionInfo, UploadDocumentResponse};
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
struct AddDocumentToSessionRequest {
    content: String,
}

#[command]
pub async fn add_document_to_session(
    session_id: String,
    content: String,
) -> Result<ApiResponse<SessionInfo>, String> {
    let client = ApiClient::new();
    let request = AddDocumentToSessionRequest { content };
    client
        .post(
            &format!("/sessions/{}/documents", session_id),
            &request,
        )
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
