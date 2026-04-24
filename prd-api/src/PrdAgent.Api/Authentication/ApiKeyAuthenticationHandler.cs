using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Api.Authentication;

/// <summary>
/// API Key 认证处理器
/// </summary>
public class ApiKeyAuthenticationHandler : AuthenticationHandler<ApiKeyAuthenticationOptions>
{
    private readonly IOpenPlatformService _openPlatformService;
    private readonly IAgentApiKeyService _agentApiKeyService;
    private readonly IConfiguration _configuration;

    public ApiKeyAuthenticationHandler(
        IOptionsMonitor<ApiKeyAuthenticationOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder,
        IOpenPlatformService openPlatformService,
        IAgentApiKeyService agentApiKeyService,
        IConfiguration configuration)
        : base(options, logger, encoder)
    {
        _openPlatformService = openPlatformService;
        _agentApiKeyService = agentApiKeyService;
        _configuration = configuration;
    }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var requestPath = Request.Path.Value;
        var requestMethod = Request.Method;
        var clientIp = Context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

        // 从 Authorization header 提取 API Key
        if (!Request.Headers.TryGetValue("Authorization", out var authHeader))
        {
            return AuthenticateResult.NoResult();
        }

        var authHeaderValue = authHeader.ToString();
        if (string.IsNullOrWhiteSpace(authHeaderValue))
        {
            return AuthenticateResult.NoResult();
        }

        // 支持 "Bearer sk-xxx" 格式
        string apiKey;
        if (authHeaderValue.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            apiKey = authHeaderValue["Bearer ".Length..].Trim();
        }
        else
        {
            apiKey = authHeaderValue.Trim();
        }

        // 如果不是 sk- 开头的 API Key，静默跳过让其他认证方案处理（如 JWT）
        if (string.IsNullOrWhiteSpace(apiKey) || !apiKey.StartsWith("sk-"))
        {
            return AuthenticateResult.NoResult();
        }

        // 检查是否为测试 Key
        var testApiKey = _configuration["OpenPlatform:TestApiKey"];
        if (!string.IsNullOrWhiteSpace(testApiKey) && apiKey == testApiKey)
        {
            // 使用测试 Key，创建测试用户身份
            var testClaims = new List<Claim>
            {
                new Claim("appId", "test-app-id"),
                new Claim("appName", "Test Application"),
                new Claim("boundUserId", "test-user-id"),
                new Claim("authType", "apikey-test"),
                new Claim("isTestKey", "true")
            };

            var testIdentity = new ClaimsIdentity(testClaims, Scheme.Name);
            var testPrincipal = new ClaimsPrincipal(testIdentity);
            var testTicket = new AuthenticationTicket(testPrincipal, Scheme.Name);

            return AuthenticateResult.Success(testTicket);
        }

        // 优先：AgentApiKey（`sk-ak-` 前缀，新版开放接口 M2M 鉴权）
        // 其次：OpenPlatformApp（`sk-` 前缀，历史 PRD 对话代理 Key）
        if (apiKey.StartsWith("sk-ak-", StringComparison.Ordinal))
        {
            var lookup = await _agentApiKeyService.LookupByPlaintextAsync(apiKey);
            if (lookup == null)
            {
                Logger.LogWarning("[401] AgentApiKey 无效/过期/已撤销 - Path: {Path}, Method: {Method}, IP: {IP}, KeyPrefix: {KeyPrefix}",
                    requestPath, requestMethod, clientIp, apiKey.Length > 15 ? apiKey[..15] + "..." : apiKey);
                return AuthenticateResult.Fail("Invalid, expired or revoked AgentApiKey");
            }

            var key = lookup.Key;
            var keyClaims = new List<Claim>
            {
                new Claim("appId", key.Id),
                new Claim("appName", key.Name),
                new Claim("boundUserId", key.OwnerUserId),
                new Claim("authType", "agent-apikey"),
                new Claim("agentApiKeyId", key.Id)
            };
            foreach (var scope in key.Scopes ?? new List<string>())
            {
                if (!string.IsNullOrWhiteSpace(scope))
                    keyClaims.Add(new Claim("scope", scope));
            }

            // 若处于宽限期，通过响应头提示续期（不阻断请求）
            if (lookup.InGracePeriod)
            {
                Response.Headers["X-AgentApiKey-Expiring"] = "true";
                if (key.ExpiresAt.HasValue)
                    Response.Headers["X-AgentApiKey-ExpiredAt"] = key.ExpiresAt.Value.ToString("o");
            }
            else if (key.ExpiresAt.HasValue)
            {
                var daysLeft = (key.ExpiresAt.Value - DateTime.UtcNow).TotalDays;
                if (daysLeft <= 30)
                {
                    Response.Headers["X-AgentApiKey-ExpiringSoon"] = "true";
                    Response.Headers["X-AgentApiKey-DaysLeft"] = ((int)Math.Ceiling(daysLeft)).ToString();
                }
            }

            // 记录使用（同步 await —— 不能 fire-and-forget，scoped 服务会被回收导致异常）
            await _agentApiKeyService.TouchUsageAsync(key.Id);

            var agentIdentity = new ClaimsIdentity(keyClaims, Scheme.Name);
            var agentPrincipal = new ClaimsPrincipal(agentIdentity);
            return AuthenticateResult.Success(new AuthenticationTicket(agentPrincipal, Scheme.Name));
        }

        // 验证 API Key（走历史 OpenPlatformApp 路径）
        var app = await _openPlatformService.GetAppByApiKeyAsync(apiKey);
        if (app == null)
        {
            Logger.LogWarning("[401] API Key无效或未激活 - Path: {Path}, Method: {Method}, IP: {IP}, KeyPrefix: {KeyPrefix}",
                requestPath, requestMethod, clientIp, apiKey.Length > 15 ? apiKey[..15] + "..." : apiKey);
            return AuthenticateResult.Fail("Invalid or inactive API Key");
        }

        // 构造 Claims
        var claims = new List<Claim>
        {
            new Claim("appId", app.Id),
            new Claim("appName", app.AppName),
            new Claim("boundUserId", app.BoundUserId),
            new Claim("authType", "apikey")
        };

        if (!string.IsNullOrWhiteSpace(app.BoundGroupId))
        {
            claims.Add(new Claim("boundGroupId", app.BoundGroupId));
        }

        var identity = new ClaimsIdentity(claims, Scheme.Name);
        var principal = new ClaimsPrincipal(identity);
        var ticket = new AuthenticationTicket(principal, Scheme.Name);

        return AuthenticateResult.Success(ticket);
    }
}

/// <summary>
/// API Key 认证选项
/// </summary>
public class ApiKeyAuthenticationOptions : AuthenticationSchemeOptions
{
}
