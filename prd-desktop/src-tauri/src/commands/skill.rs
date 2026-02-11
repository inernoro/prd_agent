use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::command;

use crate::models::ApiResponse;
use crate::services::ApiClient;

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
    client.post(&format!("/api/prd-agent/skills/{}/execute", skill_key), &request).await
}

/// 创建个人技能
#[command]
pub async fn create_skill(request: CreateSkillRequest) -> Result<ApiResponse<CreateSkillResponse>, String> {
    let client = ApiClient::new();
    client.post("/api/prd-agent/skills", &request).await
}

/// 更新个人技能
#[command]
pub async fn update_skill(skill_key: String, request: CreateSkillRequest) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client.put(&format!("/api/prd-agent/skills/{}", skill_key), &request).await
}

/// 删除个人技能
#[command]
pub async fn delete_skill(skill_key: String) -> Result<ApiResponse<serde_json::Value>, String> {
    let client = ApiClient::new();
    client.delete(&format!("/api/prd-agent/skills/{}", skill_key)).await
}
