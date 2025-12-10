use futures::StreamExt;
use serde::Serialize;
use tauri::{command, AppHandle, Emitter};

use crate::models::{ApiResponse, GuideControlResponse, SessionInfo, SwitchRoleResponse};
use crate::services::ApiClient;

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
    let url = format!(
        "{}/api/v1/sessions/{}/messages",
        std::env::var("API_BASE_URL").unwrap_or_else(|_| "http://localhost:5000".to_string()),
        session_id
    );

    let client = reqwest::Client::new();
    let request = SendMessageRequest { content, role };

    let response = client
        .post(&url)
        .header("Accept", "text/event-stream")
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                for line in text.lines() {
                    if line.starts_with("data: ") {
                        let data = &line[6..];
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
pub async fn start_guide(
    app: AppHandle,
    session_id: String,
    role: String,
) -> Result<(), String> {
    let url = format!(
        "{}/api/v1/sessions/{}/guide/start",
        std::env::var("API_BASE_URL").unwrap_or_else(|_| "http://localhost:5000".to_string()),
        session_id
    );

    let client = reqwest::Client::new();
    let request = StartGuideRequest { role };

    let response = client
        .post(&url)
        .header("Accept", "text/event-stream")
        .header("Content-Type", "application/json")
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                for line in text.lines() {
                    if line.starts_with("data: ") {
                        let data = &line[6..];
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
