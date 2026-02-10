use serde::{Deserialize, Serialize};
use tauri::command;

use crate::models::ApiResponse;
use crate::services::ApiClient;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillParameter {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub param_type: String,
    pub default_value: Option<String>,
    pub options: Option<Vec<String>>,
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillItem {
    pub skill_key: String,
    pub title: String,
    pub description: String,
    pub icon: Option<String>,
    pub category: Option<String>,
    pub roles: Vec<String>,
    pub order: i32,
    pub context_scope: String,
    pub output_mode: String,
    pub output_file_name_template: Option<String>,
    pub prompt_template: String,
    pub parameters: Option<Vec<SkillParameter>>,
    pub is_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsResponse {
    pub updated_at: String,
    pub skills: Vec<SkillItem>,
}

/// 获取服务端公共技能列表
#[command]
pub async fn get_skills(role: Option<String>) -> Result<ApiResponse<SkillsResponse>, String> {
    let client = ApiClient::new();
    let mut path = "/skills".to_string();
    if let Some(r) = role {
        let r = r.trim().to_string();
        if !r.is_empty() {
            path = format!("/skills?role={}", r);
        }
    }
    client.get(&path).await
}
