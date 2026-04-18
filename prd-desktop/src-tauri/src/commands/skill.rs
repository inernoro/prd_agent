use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::command;

use crate::models::ApiResponse;
use crate::services::ApiClient;

// Re-export for dialog access
use tauri_plugin_dialog::DialogExt;

// ━━━ 新 Skill API 模型（对应 /api/prd-agent/skills） ━━━━━━━━

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInputConfig {
    pub context_scope: String,
    pub accepts_user_input: bool,
    pub user_input_placeholder: Option<String>,
    pub accepts_attachments: bool,
    pub parameters: Vec<SkillParameter>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillOutputConfig {
    pub mode: String,
    pub file_name_template: Option<String>,
    pub echo_to_chat: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillParameter {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub param_type: String,
    pub default_value: Option<String>,
    pub options: Option<Vec<SkillParameterOption>>,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillParameterOption {
    pub value: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub skill_key: String,
    pub title: String,
    pub description: String,
    pub icon: Option<String>,
    pub category: String,
    pub tags: Vec<String>,
    pub roles: Vec<String>,
    pub order: i32,
    pub visibility: String,
    pub input: SkillInputConfig,
    pub output: SkillOutputConfig,
    pub is_enabled: bool,
    pub is_built_in: bool,
    pub usage_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsResponse {
    pub skills: Vec<Skill>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillExecuteResponse {
    pub run_id: String,
    pub user_message_id: String,
    pub assistant_message_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillExecuteRequest {
    pub session_id: String,
    pub user_input: Option<String>,
    pub attachment_ids: Option<Vec<String>>,
    pub parameters: Option<HashMap<String, String>>,
    pub context_scope_override: Option<String>,
    pub output_mode_override: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSkillRequest {
    pub title: String,
    pub description: Option<String>,
    pub icon: Option<String>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
    pub order: Option<i32>,
    pub input: Option<SkillInputConfig>,
    pub execution: Option<SkillExecutionConfig>,
    pub output: Option<SkillOutputConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillExecutionConfig {
    pub prompt_template: String,
    pub system_prompt_override: Option<String>,
    pub model_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSkillResponse {
    pub skill_key: String,
}

/// 获取可用技能列表（新 API：/api/prd-agent/skills）
#[command]
pub async fn get_skills(role: Option<String>) -> Result<ApiResponse<SkillsResponse>, String> {
    let client = ApiClient::new();
    let mut path = "/api/prd-agent/skills".to_string();
    if let Some(r) = role {
        let r = r.trim().to_string();
        if !r.is_empty() {
            path = format!("/api/prd-agent/skills?role={}", r);
        }
    }
    client.get(&path).await
}

/// 执行技能（创建 SkillRun）
#[command]
pub async fn execute_skill(
    skill_key: String,
    session_id: String,
    user_input: Option<String>,
    attachment_ids: Option<Vec<String>>,
    parameters: Option<HashMap<String, String>>,
) -> Result<ApiResponse<SkillExecuteResponse>, String> {
    let client = ApiClient::new();
    let request = SkillExecuteRequest {
        session_id,
        user_input,
        attachment_ids,
        parameters,
        context_scope_override: None,
        output_mode_override: None,
    };
    client
        .post(
            &format!("/api/prd-agent/skills/{}/execute", skill_key),
            &request,
        )
        .await
}

/// 创建个人技能
#[command]
pub async fn create_skill(
    request: CreateSkillRequest,
) -> Result<ApiResponse<CreateSkillResponse>, String> {
    let client = ApiClient::new();
    client.post("/api/prd-agent/skills", &request).await
}

/// 更新个人技能
#[command]
pub async fn update_skill(
    skill_key: String,
    request: CreateSkillRequest,
) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client
        .put(&format!("/api/prd-agent/skills/{}", skill_key), &request)
        .await
}

/// 删除个人技能
#[command]
pub async fn delete_skill(skill_key: String) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client
        .delete(&format!("/api/prd-agent/skills/{}", skill_key))
        .await
}

// ━━━ 从消息提炼提示词模板 ━━━━━━━━

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSkillFromMessageRequest {
    pub user_message: Option<String>,
    pub assistant_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractPromptTemplateResponse {
    pub prompt_template: String,
}

/// 从对话消息提炼可复用的提示词模板（旧版：单条消息）
#[command]
pub async fn generate_skill_from_message(
    user_message: Option<String>,
    assistant_message: String,
) -> Result<ApiResponse<ExtractPromptTemplateResponse>, String> {
    let client = ApiClient::new();
    let request = GenerateSkillFromMessageRequest {
        user_message,
        assistant_message,
    };
    client
        .post("/api/prd-agent/skills/generate-from-message", &request)
        .await
}

// ━━━ 从多轮对话提炼技能（增强版） ━━━━━━━━

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateSkillFromConversationRequest {
    pub conversation_messages: Vec<ConversationMessage>,
    pub key_assistant_message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedSkillDraftResponse {
    pub prompt_template: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub icon: Option<String>,
    pub skill_md: Option<String>,
}

// ━━━ 导出技能为 SKILL.md 文件 ━━━━━━━━

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSkillResponse {
    pub skill_md: String,
    pub file_name: String,
}

/// 导出技能为 SKILL.md（从 API 获取）
#[command]
pub async fn export_skill(skill_key: String) -> Result<ApiResponse<ExportSkillResponse>, String> {
    let client = ApiClient::new();
    client
        .get(&format!("/api/prd-agent/skills/{}/export", skill_key))
        .await
}

/// 导入 SKILL.md 文本创建个人技能
#[command]
pub async fn import_skill(skill_md: String) -> Result<ApiResponse<CreateSkillResponse>, String> {
    let client = ApiClient::new();
    let body = serde_json::json!({ "skillMd": skill_md });
    client.post("/api/prd-agent/skills/import", &body).await
}

/// 将 SKILL.md 内容保存为本地文件（使用系统保存对话框）
#[command]
pub async fn save_skill_to_file(
    app: tauri::AppHandle,
    content: String,
    default_name: String,
) -> Result<bool, String> {
    use std::sync::mpsc;
    use tauri_plugin_dialog::FilePath;

    let (tx, rx) = mpsc::channel();

    app.dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("SKILL.md", &["md"])
        .add_filter("All Files", &["*"])
        .save_file(move |path| {
            tx.send(path).ok();
        });

    let path = rx.recv().map_err(|e| format!("Dialog error: {}", e))?;

    match path {
        Some(file_path) => {
            let path_buf = match file_path {
                FilePath::Path(p) => p,
                FilePath::Url(u) => {
                    // Convert file:// URL to path
                    u.to_file_path()
                        .map_err(|_| "Invalid file URL".to_string())?
                }
            };
            std::fs::write(&path_buf, content.as_bytes())
                .map_err(|e| format!("Failed to write file: {}", e))?;
            Ok(true)
        }
        None => Ok(false), // User cancelled
    }
}

/// 从多轮对话提炼可复用的技能草案（增强版）
#[command]
pub async fn generate_skill_from_conversation(
    conversation_messages: Vec<ConversationMessage>,
    key_assistant_message: String,
) -> Result<ApiResponse<ExtractedSkillDraftResponse>, String> {
    let client = ApiClient::new();
    let request = GenerateSkillFromConversationRequest {
        conversation_messages,
        key_assistant_message,
    };
    client
        .post("/api/prd-agent/skills/generate-from-conversation", &request)
        .await
}
