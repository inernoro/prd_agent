use serde::Serialize;
use tauri::command;

use crate::models::ApiResponse;
use crate::services::ApiClient;

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateDefectRequest {
    content: String,
    severity: String,
    title: Option<String>,
    assignee_user_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SendDefectMessageRequest {
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolveDefectRequest {
    resolution: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RejectDefectRequest {
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EmptyBody {}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// 获取缺陷列表
#[command]
pub async fn list_defects() -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client.get("/defect-agent/defects").await
}

/// 创建缺陷报告（assigneeUserId 硬编码为 "inernoro"）
#[command]
pub async fn create_defect(
    content: String,
    severity: String,
    title: Option<String>,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let request = CreateDefectRequest {
        content,
        severity,
        title,
        assignee_user_id: "inernoro".to_string(),
    };
    client.post("/defect-agent/defects", &request).await
}

/// 提交缺陷（触发 Agent 处理流程）
#[command]
pub async fn submit_defect(id: String) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let body = EmptyBody {};
    client
        .post(&format!("/defect-agent/defects/{}/submit", id), &body)
        .await
}

/// 获取单个缺陷详情
#[command]
pub async fn get_defect(id: String) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client.get(&format!("/defect-agent/defects/{}", id)).await
}

/// 获取缺陷消息列表（支持 afterSeq 增量拉取）
#[command]
pub async fn get_defect_messages(
    id: String,
    after_seq: Option<i64>,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let path = match after_seq {
        Some(seq) => format!("/defect-agent/defects/{}/messages?afterSeq={}", id, seq),
        None => format!("/defect-agent/defects/{}/messages", id),
    };
    client.get(&path).await
}

/// 发送缺陷消息
#[command]
pub async fn send_defect_message(
    id: String,
    content: String,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let request = SendDefectMessageRequest { content };
    client
        .post(&format!("/defect-agent/defects/{}/messages", id), &request)
        .await
}

/// 处理缺陷（标记为处理中）
#[command]
pub async fn process_defect(id: String) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let body = EmptyBody {};
    client
        .post(&format!("/defect-agent/defects/{}/process", id), &body)
        .await
}

/// 解决缺陷
#[command]
pub async fn resolve_defect(
    id: String,
    resolution: String,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let request = ResolveDefectRequest { resolution };
    client
        .post(&format!("/defect-agent/defects/{}/resolve", id), &request)
        .await
}

/// 驳回缺陷
#[command]
pub async fn reject_defect(
    id: String,
    reason: String,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let request = RejectDefectRequest { reason };
    client
        .post(&format!("/defect-agent/defects/{}/reject", id), &request)
        .await
}

/// 获取缺陷统计信息
#[command]
pub async fn get_defect_stats() -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client.get("/defect-agent/stats").await
}
