use serde::Serialize;
use tauri::command;

use crate::models::{ApiResponse, LoginResponse};
use crate::services::ApiClient;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest {
    username: String,
    password: String,
    client_type: String,
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
    let request = LoginRequest {
        username,
        password,
        client_type: "desktop".to_string(),
    };

    let response: ApiResponse<LoginResponse> = client.post("/auth/login", &request).await?;

    // 保存token
    if response.success {
        if let Some(ref data) = response.data {
            ApiClient::set_token(data.access_token.clone());
            ApiClient::set_auth_session(
                Some(data.user.user_id.clone()),
                Some(data.refresh_token.clone()),
                Some(data.session_key.clone()),
                Some(data.client_type.clone()),
            );
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

/// 前端持久化登录态恢复时，同步 token 到 Rust（用于后续 API/SSE 鉴权）
#[command]
pub async fn set_auth_token(token: Option<String>) -> Result<(), String> {
    match token {
        Some(t) if !t.trim().is_empty() => ApiClient::set_token(t),
        _ => ApiClient::clear_token(),
    }
    Ok(())
}

/// 前端持久化登录态恢复时，同步 refresh 会话信息到 Rust（用于后续自动 refresh）
#[command]
pub async fn set_auth_session(
    user_id: Option<String>,
    refresh_token: Option<String>,
    session_key: Option<String>,
    client_type: Option<String>,
) -> Result<(), String> {
    ApiClient::set_auth_session(user_id, refresh_token, session_key, client_type);
    Ok(())
}
