use serde::Serialize;
use tauri::command;

use crate::models::{ApiResponse, GroupInfo, OpenGroupSessionResponse};
use crate::services::ApiClient;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateGroupRequest {
    prd_document_id: String,
    group_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JoinGroupRequest {
    invite_code: String,
    user_role: String,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinGroupResponse {
    pub group_id: String,
    pub group_name: String,
    pub prd_title: Option<String>,
    pub member_count: i32,
}

#[command]
pub async fn create_group(
    prd_document_id: String,
    group_name: Option<String>,
) -> Result<ApiResponse<GroupInfo>, String> {
    let client = ApiClient::new();
    let request = CreateGroupRequest {
        prd_document_id,
        group_name,
    };

    client.post("/groups", &request).await
}

#[command]
pub async fn join_group(
    invite_code: String,
    user_role: String,
) -> Result<ApiResponse<JoinGroupResponse>, String> {
    let client = ApiClient::new();
    let request = JoinGroupRequest {
        invite_code,
        user_role,
    };

    client.post("/groups/join", &request).await
}

#[command]
pub async fn get_groups() -> Result<ApiResponse<Vec<GroupInfo>>, String> {
    let client = ApiClient::new();
    client.get("/groups").await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenGroupSessionRequest {
    user_role: String,
}

#[command]
pub async fn open_group_session(
    group_id: String,
    user_role: String,
) -> Result<ApiResponse<OpenGroupSessionResponse>, String> {
    let client = ApiClient::new();
    let request = OpenGroupSessionRequest { user_role };
    client
        .post(&format!("/groups/{}/session", group_id), &request)
        .await
}
