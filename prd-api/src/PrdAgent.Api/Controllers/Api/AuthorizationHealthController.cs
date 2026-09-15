using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Attributes;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 跨用户、Agent、验收与服务身份的授权健康只读看板。
/// 看板不保存或返回任何明文凭据，只聚合配置存在性、可解密性和近期请求证据。
/// </summary>
[ApiController]
[Route("api/authorization-health")]
[Authorize]
[AdminController("logs", AdminPermissionCatalog.LogsRead)]
public sealed class AuthorizationHealthController : ControllerBase
{
    private static readonly TimeSpan ObservationWindow = TimeSpan.FromHours(24);
    private readonly MongoDbContext _db;
    private readonly IConfiguration _configuration;

    public AuthorizationHealthController(MongoDbContext db, IConfiguration configuration)
    {
        _db = db;
        _configuration = configuration;
    }

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var from = now.Subtract(ObservationWindow);
        var recentFailuresTask = _db.ApiRequestLogs
            .Find(x => x.StartedAt >= from && (x.StatusCode == 401 || x.StatusCode == 403))
            .SortByDescending(x => x.StartedAt)
            .Limit(50)
            .ToListAsync(ct);
        var activeAgentKeysTask = _db.AgentApiKeys
            .Find(x => x.IsActive && x.RevokedAt == null)
            .ToListAsync(ct);
        var enabledPlatformsTask = _db.LLMPlatforms.Find(x => x.Enabled).ToListAsync(ct);
        var userId = this.GetRequiredUserId();
        var externalAuthorizationsTask = _db.ExternalAuthorizations
            .Find(x => x.UserId == userId && x.RevokedAt == null)
            .ToListAsync(ct);

        await Task.WhenAll(recentFailuresTask, activeAgentKeysTask, enabledPlatformsTask, externalAuthorizationsTask);

        var failures = recentFailuresTask.Result;
        var activeAgentKeys = activeAgentKeysTask.Result.LongCount(x =>
            x.ExpiresAt is null || x.ExpiresAt.Value.AddDays(x.GracePeriodDays) > now);
        var enabledPlatforms = enabledPlatformsTask.Result;
        var externalAuthorizations = externalAuthorizationsTask.Result;
        var genericFailures = failures.Count(x => x.StatusCode == 401 && !IsClassifiedFailure(x));

        var modelKeyFailures = enabledPlatforms.Count(platform =>
            !PlatformApiKeyPolicy.IsApiKeyOptional(platform)
            && (string.IsNullOrWhiteSpace(platform.ApiKeyEncrypted)
                || !ApiKeyCryptoKeyRing.Decrypt(platform.ApiKeyEncrypted, _configuration).Success));

        var systems = new List<AuthorizationHealthItem>
        {
            Healthy(
                "map-session",
                "MAP 用户会话",
                "用户",
                "当前会话与 logs.read 权限已通过后端回读。",
                "当前页面请求",
                "/settings?tab=account"),
            BuildAiAccessKeyHealth(),
            BuildAgentApiKeyHealth(activeAgentKeys),
            BuildSyntheticLoginHealth(),
            BuildLlmGatewayHealth(),
            modelKeyFailures == 0
                ? Healthy(
                    "model-platform-keys",
                    "模型平台凭据",
                    "服务",
                    enabledPlatforms.Count == 0
                        ? "当前没有启用的平台；模型调用能力尚未建立运行证据。"
                        : $"{enabledPlatforms.Count} 个启用平台的必需凭据均可解密。",
                    "平台配置与密文试解",
                    "/logs")
                : Blocked(
                    "model-platform-keys",
                    "模型平台凭据",
                    "服务",
                    $"{modelKeyFailures} 个启用平台缺少凭据或无法解密，模型请求可能出现 401。",
                    "平台配置与密文试解",
                    "/logs",
                    "在 LLM Gateway 控制台（MAP 左下角「模型网关」）重新保存受影响平台凭据，并执行模型健康检查。"),
            BuildExternalAuthorizationHealth(externalAuthorizations),
            Conditional(
                "cds-project-identity",
                "CDS 项目身份",
                "部署",
                "CDS 项目 Key 与本机钥匙串不在 MAP 进程内，需由本机预检回读。",
                "外部机器探针",
                "/authorization-health#agent-probe",
                "运行授权预检，确认 CDS 项目身份、权威环境值与本机钥匙串一致。"),
            Conditional(
                "agent-local-credentials",
                "Agent 本机凭据",
                "Agent",
                "本机 Keychain 与 git 忽略环境文件不会上传到 MAP，只能报告探针结论。",
                "外部机器探针",
                "/authorization-health#agent-probe",
                "在 Agent 所在机器运行授权预检；不得复制明文到看板。"),
        };

        var blocked = systems.Count(x => x.Status == "blocked");
        var attention = systems.Count(x => x.Status is "attention" or "conditional");
        var verdict = blocked > 0 ? "blocked" : attention > 0 ? "attention" : "healthy";
        var conclusion = blocked > 0
            ? $"授权链路存在 {blocked} 项阻断，建议先恢复阻断项再继续验收。"
            : attention > 0
                ? $"MAP 内部授权未发现阻断；仍有 {attention} 项需要外部探针或运行证据确认。"
                : "授权链路健康，可继续业务验收。";

        return Ok(ApiResponse<AuthorizationHealthOverview>.Ok(new AuthorizationHealthOverview
        {
            GeneratedAt = now,
            ObservationHours = (int)ObservationWindow.TotalHours,
            Verdict = verdict,
            Conclusion = conclusion,
            Counts = new AuthorizationHealthCounts
            {
                Total = systems.Count,
                Healthy = systems.Count(x => x.Status == "healthy"),
                Attention = attention,
                Blocked = blocked,
            },
            Quality = new AuthorizationHealthQuality
            {
                RecentUnauthorized = failures.Count(x => x.StatusCode == 401),
                RecentForbidden = failures.Count(x => x.StatusCode == 403),
                GenericUnauthorized = genericFailures,
                ClassifiedRate = failures.Count == 0
                    ? 1
                    : Math.Round((double)failures.Count(IsClassifiedFailure) / failures.Count, 4),
            },
            Systems = systems,
            RecentFailures = failures.Select(ToFailure).ToList(),
        }));
    }

    private AuthorizationHealthItem BuildAiAccessKeyHealth()
    {
        var configured = !string.IsNullOrWhiteSpace(_configuration["AI_ACCESS_KEY"]);
        return configured
            ? Attention(
                "map-ai-access-key",
                "MAP AI Access Key",
                "Agent",
                "当前部署已加载 AI Access Key；看板不会读取或展示其明文，仍需合成登录回读证明可用。",
                "当前部署配置存在性",
                "/authorization-health#agent-probe",
                "运行合成登录预检，断言票据签发、消费和 /api/authz/me 回读成功。")
            : Blocked(
                "map-ai-access-key",
                "MAP AI Access Key",
                "Agent",
                "当前部署未配置 AI Access Key，自动化请求会被拒绝。",
                "当前部署配置存在性",
                "/authorization-health#agent-probe",
                "从权威部署配置恢复 AI Access Key，再同步本机钥匙串。" );
    }

    private static AuthorizationHealthItem BuildAgentApiKeyHealth(long activeKeys) => activeKeys > 0
        ? Healthy(
            "agent-api-keys",
            "Agent API Key",
            "Agent",
            $"当前有 {activeKeys} 个未撤销且仍在有效期或宽限期内的 Agent Key。",
            "Agent Key 台账",
            "/marketplace?dialog=open-api")
        : Attention(
            "agent-api-keys",
            "Agent API Key",
            "Agent",
            "当前没有可用的 Agent Key；依赖 M2M 调用的 Agent 无法工作。",
            "Agent Key 台账",
            "/marketplace?dialog=open-api",
            "按最小 scope 签发一个长期 Agent Key，并立即做真实端点回读。" );

    private AuthorizationHealthItem BuildSyntheticLoginHealth()
    {
        var enabled = IsTruthy(_configuration["SyntheticLogin:Enabled"] ?? _configuration["SYNTHETIC_LOGIN_ENABLED"]);
        var allowedUsers = (_configuration["SyntheticLogin:AllowedUsers"]
            ?? _configuration["SYNTHETIC_LOGIN_ALLOWED_USERS"]
            ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var signedUsers = Authentication.StableSmokeAuthenticationHandler.ReadKeys(_configuration)
            .Count(x => x.IsComplete);
        return enabled && (allowedUsers.Length > 0 || signedUsers > 0)
            ? Attention(
                "synthetic-login",
                "合成登录",
                "验收",
                "合成登录已启用且存在允许身份；需通过一次性票据消费与业务回读证明链路有效。",
                "启用开关与允许身份",
                "/authorization-health#agent-probe",
                "执行票据签发、单次消费、/api/authz/me 回读，并确认票据不可重放。")
            : Blocked(
                "synthetic-login",
                "合成登录",
                "验收",
                "合成登录未启用或没有允许身份，浏览器验收无法安全登录。",
                "启用开关与允许身份",
                "/authorization-health#agent-probe",
                "启用合成登录并配置专用账号或签名身份。" );
    }

    private AuthorizationHealthItem BuildLlmGatewayHealth()
    {
        var mode = (_configuration["LlmGateway:Mode"] ?? "inproc").Trim().ToLowerInvariant();
        var requiresHttp = mode is "http" or "shadow"
            || (_configuration.GetValue<bool?>("LlmGateway:LogicalModelsRequireHttp") ?? true);
        var keyConfigured = !string.IsNullOrWhiteSpace(_configuration["LlmGwServe:ApiKey"]);
        if (!requiresHttp)
            return Healthy("llmgw-service", "LLMGW 服务身份", "服务", "当前仅使用进程内网关，不依赖独立服务身份。", "LlmGateway 模式", "/logs");
        return keyConfigured
            ? Attention(
                "llmgw-service",
                "LLMGW 服务身份",
                "服务",
                "MAP 已配置 LLMGW 服务身份；仍需 /gw/healthz 与真实模型调用回读证明两端一致。",
                "MAP 网关配置存在性",
                "/logs",
                "执行 LLMGW 健康、auth context、key health 与最小模型调用。")
            : Blocked(
                "llmgw-service",
                "LLMGW 服务身份",
                "服务",
                "当前模式需要独立 LLMGW，但 MAP 未配置服务身份。",
                "MAP 网关配置存在性",
                "/logs",
                "统一 MAP 与 LLMGW 的服务 Key 后执行真实模型调用。" );
    }

    private static AuthorizationHealthItem BuildExternalAuthorizationHealth(IReadOnlyCollection<ExternalAuthorization> items)
    {
        var invalid = items.Count(x => !string.Equals(x.Status, "active", StringComparison.OrdinalIgnoreCase)
            || (x.ExpiresAt.HasValue && x.ExpiresAt <= DateTime.UtcNow));
        if (invalid > 0)
            return Attention(
                "external-authorizations",
                "外部系统授权",
                "用户",
                $"当前用户有 {invalid} 条外部授权已失效或过期。",
                "外部授权台账",
                "/open-platform?tab=auth",
                "重新授权并点击验证，确认真实外部 API 回读成功。",
                AdminPermissionCatalog.OpenPlatformManage);
        return Healthy(
            "external-authorizations",
            "外部系统授权",
            "用户",
            items.Count == 0 ? "当前用户未配置外部系统授权。" : $"当前用户的 {items.Count} 条外部授权台账状态正常。",
            "外部授权台账",
            "/open-platform?tab=auth",
            AdminPermissionCatalog.OpenPlatformManage);
    }

    internal static AuthorizationFailureItem ToFailure(ApiRequestLog item)
    {
        var code = string.IsNullOrWhiteSpace(item.ErrorCode)
            ? item.StatusCode == StatusCodes.Status403Forbidden
                ? "AUTH_UNCLASSIFIED_403"
                : "AUTH_UNCLASSIFIED_401"
            : item.ErrorCode!;
        var action = code switch
        {
            "AUTH_AI_KEY_INVALID" => "同步权威 AI Access Key 后按原路径复测。",
            "AUTH_AGENT_KEY_INVALID" => "续期或重新签发 Agent Key 后按原路径复测。",
            "AUTH_SESSION_REQUIRED" or "AUTH_SESSION_INVALID" or "AUTH_SESSION_REVOKED" => "重新登录后按原路径复测。",
            ErrorCodes.PERMISSION_DENIED => "检查账号角色或 Agent scope，不要反复登录。",
            _ => "按 requestId 查看请求日志，补充分类型诊断后复测。",
        };
        return new AuthorizationFailureItem
        {
            RequestId = item.RequestId,
            OccurredAt = item.StartedAt,
            Path = item.Path,
            StatusCode = item.StatusCode,
            Code = code,
            ClientType = item.ClientType ?? "unknown",
            AppName = item.AppName,
            Action = action,
        };
    }

    internal static bool IsClassifiedFailure(ApiRequestLog item) =>
        !string.IsNullOrWhiteSpace(item.ErrorCode)
        && !(item.StatusCode == StatusCodes.Status401Unauthorized
            && string.Equals(item.ErrorCode, ErrorCodes.UNAUTHORIZED, StringComparison.OrdinalIgnoreCase));

    private static bool IsTruthy(string? value) => value is not null
        && (value.Equals("1", StringComparison.OrdinalIgnoreCase)
            || value.Equals("true", StringComparison.OrdinalIgnoreCase)
            || value.Equals("yes", StringComparison.OrdinalIgnoreCase)
            || value.Equals("on", StringComparison.OrdinalIgnoreCase));

    private static AuthorizationHealthItem Healthy(string id, string label, string audience, string summary, string source, string actionUrl, string? actionPermission = null)
        => New(id, label, audience, "healthy", "正常", summary, source, actionUrl, "查看详情", actionPermission: actionPermission);
    private static AuthorizationHealthItem Attention(string id, string label, string audience, string summary, string source, string actionUrl, string recovery, string? actionPermission = null)
        => New(id, label, audience, "attention", "待验证", summary, source, actionUrl, "去验证", recovery, actionPermission);
    private static AuthorizationHealthItem Conditional(string id, string label, string audience, string summary, string source, string actionUrl, string recovery)
        => New(id, label, audience, "conditional", "需外部探针", summary, source, actionUrl, "查看预检", recovery);
    private static AuthorizationHealthItem Blocked(string id, string label, string audience, string summary, string source, string actionUrl, string recovery)
        => New(id, label, audience, "blocked", "阻断", summary, source, actionUrl, "立即恢复", recovery);
    private static AuthorizationHealthItem New(string id, string label, string audience, string status, string statusLabel, string summary, string source, string actionUrl, string actionLabel, string? recovery = null, string? actionPermission = null)
        => new()
        {
            Id = id,
            Label = label,
            Audience = audience,
            Status = status,
            StatusLabel = statusLabel,
            Summary = summary,
            EvidenceSource = source,
            ActionUrl = actionUrl,
            ActionLabel = actionLabel,
            ActionPermission = actionPermission,
            Recovery = recovery,
        };
}

public sealed class AuthorizationHealthOverview
{
    public DateTime GeneratedAt { get; set; }
    public int ObservationHours { get; set; }
    public string Verdict { get; set; } = string.Empty;
    public string Conclusion { get; set; } = string.Empty;
    public AuthorizationHealthCounts Counts { get; set; } = new();
    public AuthorizationHealthQuality Quality { get; set; } = new();
    public List<AuthorizationHealthItem> Systems { get; set; } = new();
    public List<AuthorizationFailureItem> RecentFailures { get; set; } = new();
}

public sealed class AuthorizationHealthCounts
{
    public int Total { get; set; }
    public int Healthy { get; set; }
    public int Attention { get; set; }
    public int Blocked { get; set; }
}

public sealed class AuthorizationHealthQuality
{
    public int RecentUnauthorized { get; set; }
    public int RecentForbidden { get; set; }
    public int GenericUnauthorized { get; set; }
    public double ClassifiedRate { get; set; }
}

public sealed class AuthorizationHealthItem
{
    public string Id { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string Audience { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public string StatusLabel { get; set; } = string.Empty;
    public string Summary { get; set; } = string.Empty;
    public string EvidenceSource { get; set; } = string.Empty;
    public string ActionUrl { get; set; } = string.Empty;
    public string ActionLabel { get; set; } = string.Empty;
    public string? ActionPermission { get; set; }
    public string? Recovery { get; set; }
}

public sealed class AuthorizationFailureItem
{
    public string RequestId { get; set; } = string.Empty;
    public DateTime OccurredAt { get; set; }
    public string Path { get; set; } = string.Empty;
    public int StatusCode { get; set; }
    public string Code { get; set; } = string.Empty;
    public string ClientType { get; set; } = string.Empty;
    public string? AppName { get; set; }
    public string Action { get; set; } = string.Empty;
}
