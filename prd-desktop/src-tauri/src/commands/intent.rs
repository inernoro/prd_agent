use serde::{Deserialize, Serialize};
use tauri::command;

use crate::models::{ApiResponse};
use crate::services::ApiClient;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SuggestGroupNameRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    snippet: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestGroupNameResponse {
    pub name: String,
}

#[command]
pub async fn suggest_group_name(
    file_name: Option<String>,
    snippet: String,
) -> Result<ApiResponse<SuggestGroupNameResponse>, String> {
    let client = ApiClient::new();
    let request = SuggestGroupNameRequest { file_name, snippet };
    client.post("/intent/group-name", &request).await
}


