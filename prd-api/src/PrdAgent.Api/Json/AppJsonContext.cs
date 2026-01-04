using System.Text.Json.Serialization;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Controllers.Admin;
using PrdAgent.Api.Models.Requests;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

// AuthController 中定义的类型别名
using ValidatePasswordRequest = PrdAgent.Api.Controllers.ValidatePasswordRequest;
using PasswordValidationResponse = PrdAgent.Api.Controllers.PasswordValidationResponse;

namespace PrdAgent.Api.Json;

/// <summary>
/// AOT 兼容的 JSON 序列化上下文
/// </summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UseStringEnumConverter = true)]
// API 响应类型
[JsonSerializable(typeof(ApiResponse<object>))]
[JsonSerializable(typeof(ApiResponse<LoginResponse>))]
[JsonSerializable(typeof(ApiResponse<RegisterResponse>))]
[JsonSerializable(typeof(ApiResponse<SessionResponse>))]
[JsonSerializable(typeof(ApiResponse<SwitchRoleResponse>))]
[JsonSerializable(typeof(ApiResponse<UploadDocumentResponse>))]
[JsonSerializable(typeof(ApiResponse<DocumentContentInfo>))]
[JsonSerializable(typeof(ApiResponse<GroupResponse>))]
[JsonSerializable(typeof(ApiResponse<JoinGroupResponse>))]
[JsonSerializable(typeof(ApiResponse<List<GroupResponse>>))]
[JsonSerializable(typeof(ApiResponse<List<GroupMemberResponse>>))]
[JsonSerializable(typeof(ApiResponse<BootstrapGroupBotsResponse>))]
[JsonSerializable(typeof(ApiResponse<List<MessageResponse>>))]
[JsonSerializable(typeof(ApiResponse<PromptsClientResponse>))]
[JsonSerializable(typeof(ApiResponse<UserListResponse>))]
[JsonSerializable(typeof(ApiResponse<UserDetailResponse>))]
[JsonSerializable(typeof(ApiResponse<UserStatusUpdateResponse>))]
[JsonSerializable(typeof(ApiResponse<UserRoleUpdateResponse>))]
[JsonSerializable(typeof(ApiResponse<UserPasswordUpdateResponse>))]
[JsonSerializable(typeof(ApiResponse<UnlockUserResponse>))]
[JsonSerializable(typeof(ApiResponse<InviteCodeGenerateResponse>))]
[JsonSerializable(typeof(ApiResponse<AdminCreateUserResponse>))]
[JsonSerializable(typeof(ApiResponse<AdminBulkCreateUsersResponse>))]
[JsonSerializable(typeof(ApiResponse<ForceExpireResponse>))]
[JsonSerializable(typeof(ApiResponse<AdminPagedResult<AdminGroupListItem>>))]
[JsonSerializable(typeof(ApiResponse<AdminGroupListItem>))]
[JsonSerializable(typeof(ApiResponse<List<AdminGroupMemberDto>>))]
[JsonSerializable(typeof(ApiResponse<AdminRegenerateInviteResponse>))]
[JsonSerializable(typeof(ApiResponse<AdminPagedResult<AdminMessageDto>>))]
[JsonSerializable(typeof(ApiResponse<HealthCheckResponse>))]
// Desktop Assets
[JsonSerializable(typeof(ApiResponse<DesktopSkinsResponse>))]
[JsonSerializable(typeof(ApiResponse<List<AdminDesktopAssetSkinDto>>))]
[JsonSerializable(typeof(ApiResponse<AdminDesktopAssetSkinDto>))]
[JsonSerializable(typeof(ApiResponse<List<AdminDesktopAssetKeyDto>>))]
[JsonSerializable(typeof(ApiResponse<AdminDesktopAssetUploadResponse>))]
// 群消息 SSE
[JsonSerializable(typeof(GroupMessageStreamEventDto))]
[JsonSerializable(typeof(GroupMessageStreamMessageDto))]
// Admin Data（配置导入导出 / 数据管理）
[JsonSerializable(typeof(ApiResponse<ExportedConfigV1>))]
[JsonSerializable(typeof(ApiResponse<DataConfigImportResponse>))]
[JsonSerializable(typeof(ApiResponse<DataSummaryResponse>))]
[JsonSerializable(typeof(ApiResponse<DataPurgeResponse>))]
// 流式事件类型
[JsonSerializable(typeof(ChatStreamEvent))]
[JsonSerializable(typeof(StreamErrorEvent))]
[JsonSerializable(typeof(PreviewAskStreamEvent))]
[JsonSerializable(typeof(PromptOptimizeStreamEvent))]
// 请求类型
[JsonSerializable(typeof(LoginRequest))]
[JsonSerializable(typeof(RegisterRequest))]
[JsonSerializable(typeof(RefreshTokenRequest))]
[JsonSerializable(typeof(SwitchRoleRequest))]
[JsonSerializable(typeof(SendMessageRequest))]
[JsonSerializable(typeof(UpsertPromptsRequest))]
[JsonSerializable(typeof(PromptOptimizeStreamRequest))]
[JsonSerializable(typeof(CreateGroupRequest))]
[JsonSerializable(typeof(JoinGroupRequest))]
[JsonSerializable(typeof(GroupMessageRequest))]
[JsonSerializable(typeof(BootstrapGroupBotsRequest))]
[JsonSerializable(typeof(UploadDocumentRequest))]
[JsonSerializable(typeof(UpdateStatusRequest))]
[JsonSerializable(typeof(UpdateRoleRequest))]
[JsonSerializable(typeof(UpdatePasswordRequest))]
[JsonSerializable(typeof(GenerateInviteCodeRequest))]
[JsonSerializable(typeof(AdminCreateUserRequest))]
[JsonSerializable(typeof(AdminBulkCreateUsersRequest))]
[JsonSerializable(typeof(AdminBulkCreateUserItem))]
[JsonSerializable(typeof(ValidatePasswordRequest))]
[JsonSerializable(typeof(ForceExpireRequest))]
// Desktop Assets 请求
[JsonSerializable(typeof(AdminCreateDesktopAssetSkinRequest))]
[JsonSerializable(typeof(AdminUpdateDesktopAssetSkinRequest))]
[JsonSerializable(typeof(AdminCreateDesktopAssetKeyRequest))]
// Admin Data 请求
[JsonSerializable(typeof(DataConfigImportRequest))]
[JsonSerializable(typeof(DataPurgeRequest))]
// 预览提问请求
[JsonSerializable(typeof(PreviewAskRequest))]
// 密码验证响应
[JsonSerializable(typeof(ApiResponse<PasswordValidationResponse>))]
[JsonSerializable(typeof(PasswordValidationResponse))]
// 用户管理新增 DTO
[JsonSerializable(typeof(AdminCreateUserResponse))]
[JsonSerializable(typeof(AdminBulkCreateUsersResponse))]
[JsonSerializable(typeof(AdminBulkCreateUserError))]
// 核心模型类型
[JsonSerializable(typeof(TokenUsage))]
[JsonSerializable(typeof(SenderInfo))]
[JsonSerializable(typeof(DocumentInfo))]
[JsonSerializable(typeof(DocumentContentInfo))]
[JsonSerializable(typeof(SectionInfo))]
[JsonSerializable(typeof(UserInfo))]
// 引用模型（SSE citations）
[JsonSerializable(typeof(DocCitation))]
// 列表类型（引用）
[JsonSerializable(typeof(List<DocCitation>))]
// 列表类型
[JsonSerializable(typeof(List<MessageResponse>))]
[JsonSerializable(typeof(List<int>))]
public partial class AppJsonContext : JsonSerializerContext
{
}

