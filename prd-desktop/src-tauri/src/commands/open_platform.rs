use serde::Serialize;
use tauri::command;

use crate::models::{ApiResponse, CreateOpenPlatformApiKeyResponse, OpenPlatformApiKeyDto};
use crate::services::ApiClient;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateOpenPlatformApiKeyRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    group_ids: Vec<String>,
}

#[command]
pub async fn open_platform_list_keys() -> Result<ApiResponse<Vec<OpenPlatformApiKeyDto>>, String> {
    let client = ApiClient::new();
    client.get("/open-platform/keys").await
}

#[command]
pub async fn open_platform_create_key(
    name: Option<String>,
    group_ids: Vec<String>,
) -> Result<ApiResponse<CreateOpenPlatformApiKeyResponse>, String> {
    let client = ApiClient::new();
    let req = CreateOpenPlatformApiKeyRequest {
        name: name.and_then(|s| {
            let t = s.trim().to_string();
            if t.is_empty() {
                None
            } else {
                Some(t)
            }
        }),
        group_ids: group_ids
            .into_iter()
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect(),
    };
    client.post("/open-platform/keys", &req).await
}

#[command]
pub async fn open_platform_revoke_key(
    key_id: String,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client
        .delete(&format!("/open-platform/keys/{}", key_id.trim()))
        .await
}
