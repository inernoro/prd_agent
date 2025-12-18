use serde::Serialize;
use tauri::command;

use crate::models::{ApiResponse, PrdCommentInfo};
use crate::services::ApiClient;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatePrdCommentRequest {
    document_id: String,
    group_id: String,
    heading_id: String,
    heading_title_snapshot: String,
    content: String,
}

#[command]
pub async fn get_prd_comments(
    document_id: String,
    group_id: String,
    heading_id: Option<String>,
    limit: Option<i32>,
) -> Result<ApiResponse<Vec<PrdCommentInfo>>, String> {
    let client = ApiClient::new();
    let mut path = format!(
        "/prd-comments?documentId={}&groupId={}",
        document_id, group_id
    );

    if let Some(h) = heading_id {
        if !h.trim().is_empty() {
            path.push_str(&format!("&headingId={}", h));
        }
    }

    if let Some(l) = limit {
        path.push_str(&format!("&limit={}", l));
    }

    client.get(&path).await
}

#[command]
pub async fn create_prd_comment(
    document_id: String,
    group_id: String,
    heading_id: String,
    heading_title_snapshot: String,
    content: String,
) -> Result<ApiResponse<PrdCommentInfo>, String> {
    let client = ApiClient::new();
    let req = CreatePrdCommentRequest {
        document_id,
        group_id,
        heading_id,
        heading_title_snapshot,
        content,
    };

    client.post("/prd-comments", &req).await
}

#[command]
pub async fn delete_prd_comment(
    comment_id: String,
    group_id: String,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client
        .delete(&format!("/prd-comments/{}?groupId={}", comment_id, group_id))
        .await
}
