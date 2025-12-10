use serde::Serialize;
use tauri::command;

use crate::models::{ApiResponse, LoginResponse};
use crate::services::ApiClient;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisterRequest {
    username: String,
    password: String,
    invite_code: String,
    role: String,
    display_name: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterResponse {
    pub user_id: String,
    pub username: String,
    pub role: String,
}

#[command]
pub async fn login(
    username: String,
    password: String,
) -> Result<ApiResponse<LoginResponse>, String> {
    let client = ApiClient::new();
    let request = LoginRequest { username, password };

    let response: ApiResponse<LoginResponse> = client.post("/auth/login", &request).await?;

    // 保存token
    if response.success {
        if let Some(ref data) = response.data {
            ApiClient::set_token(data.access_token.clone());
        }
    }

    Ok(response)
}

#[command]
pub async fn register(
    username: String,
    password: String,
    invite_code: String,
    role: String,
    display_name: Option<String>,
) -> Result<ApiResponse<RegisterResponse>, String> {
    let client = ApiClient::new();
    let request = RegisterRequest {
        username,
        password,
        invite_code,
        role,
        display_name,
    };

    client.post("/auth/register", &request).await
}

