use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<ApiError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadDocumentResponse {
    pub session_id: String,
    pub document: DocumentInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub id: String,
    pub title: String,
    pub char_count: i32,
    pub token_estimate: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentContentInfo {
    pub id: String,
    pub title: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrdCommentInfo {
    pub id: String,
    pub document_id: String,
    pub heading_id: String,
    pub heading_title_snapshot: String,
    pub author_user_id: String,
    pub author_display_name: String,
    pub content: String,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub group_id: Option<String>,
    pub document_id: String,
    pub current_role: String,
    pub mode: String,
    pub guide_step: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub session_key: String,
    pub client_type: String,
    pub expires_in: i32,
    pub user: UserInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub role: String,
    #[serde(default)]
    pub user_type: Option<String>,
    #[serde(default)]
    pub bot_kind: Option<String>,
    #[serde(default)]
    pub avatar_file_name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub group_id: String,
    pub group_name: String,
    #[serde(default)]
    pub prd_document_id: Option<String>,
    pub prd_title: Option<String>,
    #[serde(default)]
    pub invite_link: Option<String>,
    pub invite_code: String,
    #[serde(default)]
    pub created_at: Option<String>,
    pub member_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberInfo {
    pub user_id: String,
    pub username: String,
    pub display_name: String,
    pub member_role: String,
    #[serde(default)]
    pub tags: Vec<GroupMemberTag>,
    #[serde(default)]
    pub avatar_file_name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub joined_at: String,
    pub is_owner: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMemberTag {
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenGroupSessionResponse {
    pub session_id: String,
    pub group_id: String,
    pub document_id: String,
    pub current_role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSkinsResponse {
    pub skins: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchRoleResponse {
    pub session_id: String,
    pub current_role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: i32,
    pub output: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageHistoryItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_tags: Option<Vec<GroupMemberTag>>,
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resend_of_message_id: Option<String>,
    pub view_role: Option<String>,
    pub timestamp: String,
    pub token_usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptClientItem {
    pub prompt_key: String,
    pub order: i32,
    pub role: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptsClientResponse {
    pub updated_at: String,
    pub prompts: Vec<PromptClientItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenPlatformApiKeyDto {
    pub id: String,
    pub owner_user_id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub key_prefix: String,
    #[serde(default)]
    pub allowed_group_ids: Vec<String>,
    pub created_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub revoked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOpenPlatformApiKeyResponse {
    pub api_key: String,
    pub key: OpenPlatformApiKeyDto,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub message_id: Option<String>,
    pub content: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}
