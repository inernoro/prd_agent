use futures::StreamExt;
use serde::Serialize;
use tauri::{command, AppHandle, Emitter};

use crate::models::{ApiResponse, GuideControlResponse, MessageHistoryItem, SessionInfo, SwitchRoleResponse};
use crate::services::{api_client, ApiClient};

#[derive(Serialize)]
struct SwitchRoleRequest {
    role: String,
}

#[derive(Serialize)]
struct SendMessageRequest {
    content: String,
    role: Option<String>,
}

#[derive(Serialize)]
struct StartGuideRequest {
    role: String,
}

#[derive(Serialize)]
struct GuideControlRequest {
    action: String,
    step: Option<i32>,
}

#[command]
pub async fn get_session(session_id: String) -> Result<ApiResponse<SessionInfo>, String> {
    let client = ApiClient::new();
    client.get(&format!("/sessions/{}", session_id)).await
}

#[command]
pub async fn get_message_history(
    session_id: String,
    limit: Option<i32>,
) -> Result<ApiResponse<Vec<MessageHistoryItem>>, String> {
    let client = ApiClient::new();
    let limit = limit.unwrap_or(50);
    client
        .get(&format!("/sessions/{}/messages?limit={}", session_id, limit))
        .await
}

#[command]
pub async fn switch_role(
    session_id: String,
    role: String,
) -> Result<ApiResponse<SwitchRoleResponse>, String> {
    let client = ApiClient::new();
    let request = SwitchRoleRequest { role };

    client
        .put(&format!("/sessions/{}/role", session_id), &request)
        .await
}

#[command]
pub async fn send_message(
    app: AppHandle,
    session_id: String,
    content: String,
    role: Option<String>,
) -> Result<(), String> {
    let base_url = api_client::get_api_base_url();
    let url = format!(
        "{}/api/v1/sessions/{}/messages",
        base_url,
        session_id
    );

    let client = api_client::build_streaming_client(&base_url);
    let request = SendMessageRequest { content, role };

    let mut req = client
        .post(&url)
        .header("Accept", "text/event-stream")
        .header("Content-Type", "application/json")
        .json(&request);

    if let Some(token) = api_client::get_auth_token() {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

    let response = req.send().await.map_err(|e| format!("Request failed: {}", e))?;

    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                for line in text.lines() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                            let _ = app.emit("message-chunk", event);
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "error",
                    serde_json::json!({
                        "code": "STREAM_ERROR",
                        "message": format!("Stream error: {}", e)
                    }),
                );
                break;
            }
        }
    }

    Ok(())
}

#[command]
pub async fn start_guide(app: AppHandle, session_id: String, role: String) -> Result<(), String> {
    let base_url = api_client::get_api_base_url();
    let url = format!(
        "{}/api/v1/sessions/{}/guide/start",
        base_url,
        session_id
    );

    let client = api_client::build_streaming_client(&base_url);
    let request = StartGuideRequest { role };

    let mut req = client
        .post(&url)
        .header("Accept", "text/event-stream")
        .header("Content-Type", "application/json")
        .json(&request);

    if let Some(token) = api_client::get_auth_token() {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

    let response = req.send().await.map_err(|e| format!("Request failed: {}", e))?;

    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                for line in text.lines() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                            let _ = app.emit("guide-chunk", event);
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "error",
                    serde_json::json!({
                        "code": "STREAM_ERROR",
                        "message": format!("Stream error: {}", e)
                    }),
                );
                break;
            }
        }
    }

    Ok(())
}

#[command]
pub async fn get_guide_step_content(app: AppHandle, session_id: String, step: i32) -> Result<(), String> {
    let base_url = api_client::get_api_base_url();
    let url = format!(
        "{}/api/v1/sessions/{}/guide/step/{}",
        base_url,
        session_id,
        step
    );

    let client = api_client::build_streaming_client(&base_url);

    let mut req = client
        .get(&url)
        .header("Accept", "text/event-stream");

    if let Some(token) = api_client::get_auth_token() {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

    let response = req.send().await.map_err(|e| format!("Request failed: {}", e))?;

    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                for line in text.lines() {
                    if let Some(data) = line.strip_prefix("data: ") {
                        if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                            let _ = app.emit("guide-chunk", event);
                        }
                    }
                }
            }
            Err(e) => {
                let _ = app.emit(
                    "error",
                    serde_json::json!({
                        "code": "STREAM_ERROR",
                        "message": format!("Stream error: {}", e)
                    }),
                );
                break;
            }
        }
    }

    Ok(())
}

#[command]
pub async fn control_guide(
    session_id: String,
    action: String,
    step: Option<i32>,
) -> Result<ApiResponse<GuideControlResponse>, String> {
    let client = ApiClient::new();
    let request = GuideControlRequest { action, step };

    client
        .post(&format!("/sessions/{}/guide/control", session_id), &request)
        .await
}
