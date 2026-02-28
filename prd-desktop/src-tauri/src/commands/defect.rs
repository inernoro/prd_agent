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
    template_id: Option<String>,
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
struct PolishDefectRequest {
    content: String,
    template_id: Option<String>,
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
    client.get("/api/defect-agent/defects").await
}

/// 获取缺陷管理用户列表（用于选择提交对象）
#[command]
pub async fn list_defect_users() -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client.get("/api/defect-agent/users").await
}

/// 获取缺陷模板列表
#[command]
pub async fn list_defect_templates() -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client.get("/api/defect-agent/templates").await
}

/// 创建缺陷报告
#[command]
pub async fn create_defect(
    content: String,
    severity: String,
    title: Option<String>,
    assignee_user_id: String,
    template_id: Option<String>,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let request = CreateDefectRequest {
        content,
        severity,
        title,
        assignee_user_id,
        template_id,
    };
    client.post("/api/defect-agent/defects", &request).await
}

/// 提交缺陷（触发 Agent 处理流程）
#[command]
pub async fn submit_defect(id: String) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let body = EmptyBody {};
    client
        .post(&format!("/api/defect-agent/defects/{}/submit", id), &body)
        .await
}

/// 获取单个缺陷详情
#[command]
pub async fn get_defect(id: String) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client
        .get(&format!("/api/defect-agent/defects/{}", id))
        .await
}

/// 获取缺陷消息列表（支持 afterSeq 增量拉取）
#[command]
pub async fn get_defect_messages(
    id: String,
    after_seq: Option<i64>,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let path = match after_seq {
        Some(seq) => format!("/api/defect-agent/defects/{}/messages?afterSeq={}", id, seq),
        None => format!("/api/defect-agent/defects/{}/messages", id),
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
        .post(
            &format!("/api/defect-agent/defects/{}/messages", id),
            &request,
        )
        .await
}

/// 处理缺陷（标记为处理中）
#[command]
pub async fn process_defect(id: String) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let body = EmptyBody {};
    client
        .post(&format!("/api/defect-agent/defects/{}/process", id), &body)
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
        .post(
            &format!("/api/defect-agent/defects/{}/resolve", id),
            &request,
        )
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
        .post(
            &format!("/api/defect-agent/defects/{}/reject", id),
            &request,
        )
        .await
}

/// 获取缺陷统计信息
#[command]
pub async fn get_defect_stats() -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client.get("/api/defect-agent/stats").await
}

/// AI 润色缺陷描述
#[command]
pub async fn polish_defect(
    content: String,
    template_id: Option<String>,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    let request = PolishDefectRequest {
        content,
        template_id,
    };
    client
        .post("/api/defect-agent/defects/polish", &request)
        .await
}

/// 预览 API 日志（提交缺陷时自动采集的日志）
#[command]
pub async fn preview_defect_logs() -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client.get("/api/defect-agent/logs/preview").await
}

/// 上传缺陷附件（base64 编码的文件）
#[command]
pub async fn add_defect_attachment(
    id: String,
    file_base64: String,
    file_name: String,
    mime_type: String,
) -> Result<ApiResponse<serde_json::Value>, String> {
    use base64::Engine;
    let file_bytes = base64::engine::general_purpose::STANDARD
        .decode(&file_base64)
        .map_err(|e| format!("Failed to decode file: {}", e))?;

    let client = ApiClient::new();
    client
        .post_file(
            &format!("/api/defect-agent/defects/{}/attachments", id),
            file_bytes,
            file_name,
            mime_type,
        )
        .await
}
