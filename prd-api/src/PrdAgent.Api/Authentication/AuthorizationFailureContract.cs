using System.Text.Json;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Authentication;

/// <summary>
/// 统一鉴权失败契约。只暴露稳定、可恢复的诊断码，不回传密钥、账号存在性或底层异常。
/// </summary>
public static class AuthorizationFailureContract
{
    private const string ContextKey = "authorization-failure";
    private const string ChallengeWrittenContextKey = "authorization-failure-challenge-written";

    public const string SessionRequired = "AUTH_SESSION_REQUIRED";
    public const string SessionInvalid = "AUTH_SESSION_INVALID";
    public const string SessionRevoked = "AUTH_SESSION_REVOKED";
    public const string SessionValidationUnavailable = "AUTH_SESSION_VALIDATION_UNAVAILABLE";
    public const string AiKeyNotConfigured = "AUTH_AI_KEY_NOT_CONFIGURED";
    public const string AiKeyInvalid = "AUTH_AI_KEY_INVALID";
    public const string AiIdentityRequired = "AUTH_AI_IDENTITY_REQUIRED";
    public const string AiIdentityUnavailable = "AUTH_AI_IDENTITY_UNAVAILABLE";
    public const string AgentKeyInvalid = "AUTH_AGENT_KEY_INVALID";
    public const string OpenPlatformKeyInvalid = "AUTH_OPEN_PLATFORM_KEY_INVALID";
    public const string StableSmokeNotConfigured = "AUTH_STABLE_SMOKE_NOT_CONFIGURED";
    public const string StableSmokeRequestInvalid = "AUTH_STABLE_SMOKE_REQUEST_INVALID";
    public const string StableSmokeSignatureExpired = "AUTH_STABLE_SMOKE_SIGNATURE_EXPIRED";
    public const string StableSmokeSignatureInvalid = "AUTH_STABLE_SMOKE_SIGNATURE_INVALID";
    public const string StableSmokeIdentityUnavailable = "AUTH_STABLE_SMOKE_IDENTITY_UNAVAILABLE";

    public sealed record Failure(string Code, string Message, string Recovery);

    public static void Set(HttpContext context, string code)
    {
        if (!context.Items.ContainsKey(ContextKey))
            context.Items[ContextKey] = Resolve(code);
    }

    public static Failure GetOrDefault(HttpContext context, bool hasBearerToken)
        => context.Items.TryGetValue(ContextKey, out var value) && value is Failure failure
            ? failure
            : Resolve(hasBearerToken ? SessionInvalid : SessionRequired);

    public static Failure Resolve(string code) => code switch
    {
        SessionRequired => new(code, "登录状态缺失，请登录后重试。", "重新登录"),
        SessionRevoked => new(code, "当前登录已失效，请重新登录后重试。", "重新登录"),
        SessionValidationUnavailable => new(code, "登录校验暂时不可用，请稍后重试。", "稍后重试"),
        AiKeyNotConfigured => new(code, "自动化访问凭据尚未在当前环境配置。", "同步当前环境的 AI Access Key 后重试"),
        AiKeyInvalid => new(code, "自动化访问凭据与当前环境不一致。", "从权威配置重新同步 AI Access Key 后重试"),
        AiIdentityRequired => new(code, "自动化请求缺少目标身份。", "补充已授权的自动化用户名后重试"),
        AiIdentityUnavailable => new(code, "自动化目标身份当前不可用。", "检查专用账号状态与允许名单后重试"),
        AgentKeyInvalid => new(code, "Agent 授权已失效或不可用。", "重新签发或续期 Agent API Key 后重试"),
        OpenPlatformKeyInvalid => new(code, "开放平台调用凭据已失效或不可用。", "在开放平台重新签发调用凭据后重试"),
        StableSmokeNotConfigured => new(code, "稳定冒烟签名身份尚未在当前环境配置。", "同步签名公钥和允许主机后重试"),
        StableSmokeRequestInvalid => new(code, "稳定冒烟请求不符合签名通道约束。", "检查允许端点、请求头和请求大小后重试"),
        StableSmokeSignatureExpired => new(code, "稳定冒烟签名已过期或已被使用。", "同步执行机时钟并生成新的签名后重试"),
        StableSmokeSignatureInvalid => new(code, "稳定冒烟签名与当前环境不一致。", "同步当前环境公钥与执行机私钥后重试"),
        StableSmokeIdentityUnavailable => new(code, "稳定冒烟专用身份当前不可用。", "检查专用账号状态与允许名单后重试"),
        _ => new(SessionInvalid, "当前登录已失效，请重新登录后重试。", "重新登录"),
    };

    public static async Task WriteChallengeAsync(HttpContext context, JsonSerializerOptions? jsonOptions = null)
    {
        // 默认授权策略会依次 challenge JWT、ApiKey、AiAccessKey 与 StableSmoke。
        // HasStarted 在部分服务器实现中不会在首次 WriteAsync 后立刻变为 true，必须用
        // 请求级标记保证只写一次，否则响应会拼成多个 JSON 对象，Agent 无法解析。
        if (context.Response.HasStarted || context.Items.ContainsKey(ChallengeWrittenContextKey))
            return;

        context.Items[ChallengeWrittenContextKey] = true;

        var authHeader = context.Request.Headers.Authorization.FirstOrDefault();
        var hasBearerToken = authHeader?.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) == true;
        var failure = GetOrDefault(context, hasBearerToken);
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.Headers["X-Auth-Diagnosis"] = failure.Code;
        context.Response.Headers["X-Auth-Recovery"] = Uri.EscapeDataString(failure.Recovery);
        var payload = ApiResponse<object>.Fail(failure.Code, failure.Message);
        await context.Response.WriteAsync(JsonSerializer.Serialize(
            payload,
            jsonOptions ?? new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));
    }
}
