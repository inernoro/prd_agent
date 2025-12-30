use futures::StreamExt;
use reqwest::StatusCode;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{command, AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

use crate::models::{
    ApiResponse, MessageHistoryItem, PromptsClientResponse, SessionInfo, SwitchRoleResponse,
};
use crate::services::{api_client, ApiClient};

#[derive(Default)]
pub struct StreamCancelState {
    message: Mutex<CancellationToken>,
    preview: Mutex<CancellationToken>,
}

impl StreamCancelState {
    fn new_message_token(&self) -> CancellationToken {
        let mut guard = self.message.lock().unwrap();
        *guard = CancellationToken::new();
        guard.clone()
    }
    fn new_preview_token(&self) -> CancellationToken {
        let mut guard = self.preview.lock().unwrap();
        *guard = CancellationToken::new();
        guard.clone()
    }
    fn cancel_all(&self) {
        self.message.lock().unwrap().cancel();
        self.preview.lock().unwrap().cancel();
    }
}

#[command]
pub async fn cancel_stream(
    cancel: State<'_, StreamCancelState>,
    kind: Option<String>,
) -> Result<(), String> {
    let k = kind.unwrap_or_else(|| "all".to_string()).to_lowercase();
    match k.as_str() {
        "all" | "message" | "preview" => {
            // 当前实现统一取消（避免前端判断困难）
            cancel.cancel_all();
            Ok(())
        }
        _ => Ok(()),
    }
}

fn emit_stream_error(app: &AppHandle, channel: &str, message: String) {
    // 前端只监听 message-chunk / preview-ask-chunk，不监听 "error" 事件名
    let _ = app.emit(
        channel,
        serde_json::json!({
            "type": "error",
            "errorMessage": message
        }),
    );
}

fn emit_auth_expired(app: &AppHandle) {
    // 统一事件：前端收到后跳转登录（但保留本地上下文/消息）
    let _ = app.emit(
        "auth-expired",
        serde_json::json!({ "code": "UNAUTHORIZED" }),
    );
}

fn emit_stream_phase(app: &AppHandle, channel: &str, phase: &str) {
    let _ = app.emit(
        channel,
        serde_json::json!({
            "type": "phase",
            "phase": phase
        }),
    );
}

fn handle_sse_text(
    app: &AppHandle,
    channel: &str,
    buf: &mut String,
    incoming: &str,
    saw_any_data: &mut bool,
) {
    buf.push_str(incoming);

    // SSE event delimiter: blank line
    while let Some(idx) = buf.find("\n\n") {
        let raw_event = buf[..idx].to_string();
        *buf = buf[idx + 2..].to_string();

        let mut data_lines: Vec<String> = Vec::new();
        for raw_line in raw_event.lines() {
            // 保留行尾 \r 的兼容（Windows CRLF）
            let line = raw_line.trim_end_matches('\r');
            if let Some(stripped) = line.strip_prefix("data:") {
                let payload = stripped.trim_start();
                data_lines.push(payload.to_string());
            }
        }

        if data_lines.is_empty() {
            continue;
        }

        let data = data_lines.join("\n").trim().to_string();
        if data.is_empty() {
            continue;
        }

        if !*saw_any_data {
            *saw_any_data = true;
            emit_stream_phase(app, channel, "receiving");
        }

        if data == "[DONE]" {
            let _ = app.emit(channel, serde_json::json!({ "type": "done" }));
            continue;
        }

        // 默认期望 data 是 JSON（后端会发 {"type":"delta"...}），但这里要容错
        match serde_json::from_str::<serde_json::Value>(&data) {
            Ok(event) => {
                let _ = app.emit(channel, event);
            }
            Err(_) => {
                let _ = app.emit(
                    channel,
                    serde_json::json!({
                        "type": "delta",
                        "content": data
                    }),
                );
            }
        }
    }
}

#[derive(Serialize)]
struct SwitchRoleRequest {
    role: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageRequest {
    content: String,
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attachment_ids: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewAskRequest {
    question: String,
    heading_id: String,
    heading_title: Option<String>,
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
    before: Option<String>,
) -> Result<ApiResponse<Vec<MessageHistoryItem>>, String> {
    let client = ApiClient::new();
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let mut path = format!("/sessions/{}/messages?limit={}", session_id, limit);
    if let Some(b) = before {
        let bb = b.trim().to_string();
        if !bb.is_empty() {
            // before 参数建议由前端传 UTC ISO（toISOString，末尾 'Z'），避免 '+' 被 query 解析为空格
            path.push_str("&before=");
            path.push_str(&bb);
        }
    }
    client.get(&path).await
}

#[command]
pub async fn get_group_message_history(
    group_id: String,
    limit: Option<i32>,
    before: Option<String>,
) -> Result<ApiResponse<Vec<MessageHistoryItem>>, String> {
    let client = ApiClient::new();
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let mut path = format!("/groups/{}/messages?limit={}", group_id, limit);
    if let Some(b) = before {
        let bb = b.trim().to_string();
        if !bb.is_empty() {
            path.push_str("&before=");
            path.push_str(&bb);
        }
    }
    client.get(&path).await
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
    cancel: State<'_, StreamCancelState>,
    session_id: String,
    content: String,
    role: Option<String>,
    prompt_key: Option<String>,
    attachment_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let base_url = api_client::get_api_base_url();
    let url = format!("{}/api/v1/sessions/{}/messages", base_url, session_id);

    let client = api_client::build_streaming_client(&base_url);
    let request = SendMessageRequest {
        content,
        role,
        prompt_key,
        attachment_ids,
    };

    let token = cancel.new_message_token();
    emit_stream_phase(&app, "message-chunk", "requesting");
    let mut req = client
        .post(&url)
        .header("Accept", "text/event-stream")
        .header("Content-Type", "application/json")
        .json(&request);

    if let Some(token) = api_client::get_auth_token() {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

    let mut response = req
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    // access 过期：尝试 refresh 后重试一次
    if response.status() == StatusCode::UNAUTHORIZED {
        let ok = ApiClient::new().refresh_auth().await.unwrap_or(false);
        if ok {
            let mut retry = client
                .post(&url)
                .header("Accept", "text/event-stream")
                .header("Content-Type", "application/json")
                .json(&request);
            if let Some(token) = api_client::get_auth_token() {
                retry = retry.header("Authorization", format!("Bearer {}", token));
            }
            response = retry
                .send()
                .await
                .map_err(|e| format!("Request failed: {}", e))?;
        } else {
            emit_auth_expired(&app);
        }
    }
    emit_stream_phase(&app, "message-chunk", "connected");
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        emit_stream_error(&app, "message-chunk", format!("HTTP {}: {}", status, body));
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut sse_buf = String::new();
    let mut saw_any_data = false;

    while let Some(chunk) = stream.next().await {
        if token.is_cancelled() {
            let _ = app.emit("message-chunk", serde_json::json!({ "type": "done" }));
            break;
        }
        match chunk {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                handle_sse_text(
                    &app,
                    "message-chunk",
                    &mut sse_buf,
                    &text,
                    &mut saw_any_data,
                );
            }
            Err(e) => {
                emit_stream_error(&app, "message-chunk", format!("Stream error: {}", e));
                break;
            }
        }
    }

    Ok(())
}

#[command]
pub async fn get_prompts() -> Result<ApiResponse<PromptsClientResponse>, String> {
    let client = ApiClient::new();
    client.get("/prompts").await
}

#[command]
pub async fn preview_ask_in_section(
    app: AppHandle,
    cancel: State<'_, StreamCancelState>,
    session_id: String,
    heading_id: String,
    heading_title: Option<String>,
    question: String,
) -> Result<(), String> {
    let base_url = api_client::get_api_base_url();
    let url = format!("{}/api/v1/sessions/{}/preview-ask", base_url, session_id);

    let client = api_client::build_streaming_client(&base_url);
    let request = PreviewAskRequest {
        question,
        heading_id,
        heading_title,
    };

    let token = cancel.new_preview_token();
    emit_stream_phase(&app, "preview-ask-chunk", "requesting");
    let mut req = client
        .post(&url)
        .header("Accept", "text/event-stream")
        .header("Content-Type", "application/json")
        .json(&request);

    if let Some(token) = api_client::get_auth_token() {
        req = req.header("Authorization", format!("Bearer {}", token));
    }

    let mut response = req
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if response.status() == StatusCode::UNAUTHORIZED {
        let ok = ApiClient::new().refresh_auth().await.unwrap_or(false);
        if ok {
            let mut retry = client
                .post(&url)
                .header("Accept", "text/event-stream")
                .header("Content-Type", "application/json")
                .json(&request);
            if let Some(token) = api_client::get_auth_token() {
                retry = retry.header("Authorization", format!("Bearer {}", token));
            }
            response = retry
                .send()
                .await
                .map_err(|e| format!("Request failed: {}", e))?;
        } else {
            emit_auth_expired(&app);
        }
    }
    emit_stream_phase(&app, "preview-ask-chunk", "connected");
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        emit_stream_error(
            &app,
            "preview-ask-chunk",
            format!("HTTP {}: {}", status, body),
        );
        return Ok(());
    }

    let mut stream = response.bytes_stream();
    let mut sse_buf = String::new();
    let mut saw_any_data = false;

    while let Some(chunk) = stream.next().await {
        if token.is_cancelled() {
            let _ = app.emit("preview-ask-chunk", serde_json::json!({ "type": "done" }));
            break;
        }
        match chunk {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                handle_sse_text(
                    &app,
                    "preview-ask-chunk",
                    &mut sse_buf,
                    &text,
                    &mut saw_any_data,
                );
            }
            Err(e) => {
                emit_stream_error(&app, "preview-ask-chunk", format!("Stream error: {}", e));
                break;
            }
        }
    }

    Ok(())
}
