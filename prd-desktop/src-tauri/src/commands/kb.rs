use serde::Deserialize;
use tauri::command;

use crate::models::{ApiResponse, KbDocumentContentInfo, KbDocumentInfo};
use crate::services::ApiClient;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbFileInput {
    pub file_name: String,
    pub content: Vec<u8>,
    pub mime_type: String,
}

#[command]
pub async fn list_kb_documents(
    group_id: String,
) -> Result<ApiResponse<Vec<KbDocumentInfo>>, String> {
    let client = ApiClient::new();
    client
        .get(&format!("/groups/{}/kb/documents", group_id))
        .await
}

#[command]
pub async fn upload_kb_documents(
    group_id: String,
    files: Vec<KbFileInput>,
) -> Result<ApiResponse<Vec<KbDocumentInfo>>, String> {
    let client = ApiClient::new();

    let mut form = reqwest::multipart::Form::new();
    for file in files {
        let mime = file.mime_type.clone();
        let part = reqwest::multipart::Part::bytes(file.content)
            .file_name(file.file_name)
            .mime_str(&mime)
            .map_err(|e| format!("Invalid MIME type: {}", e))?;
        form = form.part("files", part);
    }

    client
        .post_multipart(&format!("/groups/{}/kb/documents", group_id), form)
        .await
}

#[command]
pub async fn replace_kb_document(
    group_id: String,
    document_id: String,
    file: KbFileInput,
) -> Result<ApiResponse<KbDocumentInfo>, String> {
    let client = ApiClient::new();

    let mime = file.mime_type.clone();
    let part = reqwest::multipart::Part::bytes(file.content)
        .file_name(file.file_name)
        .mime_str(&mime)
        .map_err(|e| format!("Invalid MIME type: {}", e))?;
    let form = reqwest::multipart::Form::new().part("file", part);

    client
        .put_multipart(
            &format!("/groups/{}/kb/documents/{}", group_id, document_id),
            form,
        )
        .await
}

#[command]
pub async fn delete_kb_document(
    group_id: String,
    document_id: String,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client
        .delete(&format!(
            "/groups/{}/kb/documents/{}",
            group_id, document_id
        ))
        .await
}

#[command]
pub async fn get_kb_document_content(
    group_id: String,
    document_id: String,
) -> Result<ApiResponse<KbDocumentContentInfo>, String> {
    let client = ApiClient::new();
    client
        .get(&format!(
            "/groups/{}/kb/documents/{}/content",
            group_id, document_id
        ))
        .await
}
