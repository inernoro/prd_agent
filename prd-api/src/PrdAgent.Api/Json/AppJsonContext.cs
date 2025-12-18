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
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
// API 响应类型
[JsonSerializable(typeof(ApiResponse<object>))]
[JsonSerializable(typeof(ApiResponse<LoginResponse>))]
[JsonSerializable(typeof(ApiResponse<RegisterResponse>))]
[JsonSerializable(typeof(ApiResponse<SessionResponse>))]
[JsonSerializable(typeof(ApiResponse<SwitchRoleResponse>))]
[JsonSerializable(typeof(ApiResponse<GuideControlResponse>))]
[JsonSerializable(typeof(ApiResponse<GuideProgressResponse>))]
[JsonSerializable(typeof(ApiResponse<UploadDocumentResponse>))]
[JsonSerializable(typeof(ApiResponse<GroupResponse>))]
[JsonSerializable(typeof(ApiResponse<JoinGroupResponse>))]
[JsonSerializable(typeof(ApiResponse<List<GroupResponse>>))]
[JsonSerializable(typeof(ApiResponse<List<GroupMemberResponse>>))]
[JsonSerializable(typeof(ApiResponse<List<MessageResponse>>))]
[JsonSerializable(typeof(ApiResponse<List<OutlineItemResponse>>))]
[JsonSerializable(typeof(ApiResponse<UserListResponse>))]
[JsonSerializable(typeof(ApiResponse<UserDetailResponse>))]
[JsonSerializable(typeof(ApiResponse<UserStatusUpdateResponse>))]
[JsonSerializable(typeof(ApiResponse<UserRoleUpdateResponse>))]
[JsonSerializable(typeof(ApiResponse<UserPasswordUpdateResponse>))]
[JsonSerializable(typeof(ApiResponse<InviteCodeGenerateResponse>))]
[JsonSerializable(typeof(ApiResponse<AdminPagedResult<AdminGroupListItem>>))]
[JsonSerializable(typeof(ApiResponse<AdminGroupListItem>))]
[JsonSerializable(typeof(ApiResponse<List<AdminGroupMemberDto>>))]
[JsonSerializable(typeof(ApiResponse<AdminRegenerateInviteResponse>))]
[JsonSerializable(typeof(ApiResponse<AdminPagedResult<AdminMessageDto>>))]
[JsonSerializable(typeof(ApiResponse<HealthCheckResponse>))]
// 流式事件类型
[JsonSerializable(typeof(ChatStreamEvent))]
[JsonSerializable(typeof(GuideStreamEvent))]
[JsonSerializable(typeof(StreamErrorEvent))]
// 请求类型
[JsonSerializable(typeof(LoginRequest))]
[JsonSerializable(typeof(RegisterRequest))]
[JsonSerializable(typeof(RefreshTokenRequest))]
[JsonSerializable(typeof(SwitchRoleRequest))]
[JsonSerializable(typeof(SendMessageRequest))]
[JsonSerializable(typeof(StartGuideRequest))]
[JsonSerializable(typeof(GuideControlRequest))]
[JsonSerializable(typeof(CreateGroupRequest))]
[JsonSerializable(typeof(JoinGroupRequest))]
[JsonSerializable(typeof(GroupMessageRequest))]
[JsonSerializable(typeof(UploadDocumentRequest))]
[JsonSerializable(typeof(UpdateStatusRequest))]
[JsonSerializable(typeof(UpdateRoleRequest))]
[JsonSerializable(typeof(UpdatePasswordRequest))]
[JsonSerializable(typeof(GenerateInviteCodeRequest))]
[JsonSerializable(typeof(ValidatePasswordRequest))]
// 密码验证响应
[JsonSerializable(typeof(ApiResponse<PasswordValidationResponse>))]
[JsonSerializable(typeof(PasswordValidationResponse))]
// 核心模型类型
[JsonSerializable(typeof(TokenUsage))]
[JsonSerializable(typeof(SenderInfo))]
[JsonSerializable(typeof(GuideControlResult))]
[JsonSerializable(typeof(DocumentInfo))]
[JsonSerializable(typeof(SectionInfo))]
[JsonSerializable(typeof(UserInfo))]
// 引用模型（SSE citations）
[JsonSerializable(typeof(DocCitation))]
// 列表类型（引用）
[JsonSerializable(typeof(List<DocCitation>))]
// 列表类型
[JsonSerializable(typeof(List<MessageResponse>))]
[JsonSerializable(typeof(List<OutlineItemResponse>))]
[JsonSerializable(typeof(List<int>))]
public partial class AppJsonContext : JsonSerializerContext
{
}

