using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Authentication;

/// <summary>
/// API Key 认证处理器
/// </summary>
public class ApiKeyAuthenticationHandler : AuthenticationHandler<ApiKeyAuthenticationOptions>
{
    private readonly IOpenPlatformService _openPlatformService;
    private readonly IAgentApiKeyService _agentApiKeyService;
    private readonly IConfiguration _configuration;
    private readonly IAdminPermissionService _permissionService;
    private readonly McpLoopbackSignal _mcpLoopback;

    public ApiKeyAuthenticationHandler(
        IOptionsMonitor<ApiKeyAuthenticationOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder,
        IOpenPlatformService openPlatformService,
        IAgentApiKeyService agentApiKeyService,
        IConfiguration configuration,
        IAdminPermissionService permissionService,
        McpLoopbackSignal mcpLoopback)
        : base(options, logger, encoder)
    {
        _openPlatformService = openPlatformService;
        _agentApiKeyService = agentApiKeyService;
        _configuration = configuration;
        _permissionService = permissionService;
        _mcpLoopback = mcpLoopback;
    }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var requestPath = Request.Path.Value;
        var requestMethod = Request.Method;
        var clientIp = Context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

        // 从 Authorization header 提取 API Key；缺陷分享提示词历史上使用 X-AI-Access-Key，
        // 这里兼容 sk-ak 临时密钥，避免外部 Agent 拿到分享文本后无法发表评论。
        if (!Request.Headers.TryGetValue("Authorization", out var authHeader))
        {
            if (!Request.Headers.TryGetValue("X-AI-Access-Key", out authHeader))
            {
                return AuthenticateResult.NoResult();
            }
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
                AuthorizationFailureContract.Set(Context, AuthorizationFailureContract.AgentKeyInvalid);
                return AuthenticateResult.Fail("Invalid, expired or revoked AgentApiKey");
            }

            var key = lookup.Key;
            var keyClaims = new List<Claim>
            {
                new Claim("appId", key.Id),
                new Claim("appName", key.Name),
                new Claim("boundUserId", key.OwnerUserId),
                // 注意：故意【不】在这里设 sub/NameIdentifier。否则 AgentApiKey 会在所有
                // 仅需登录（[Authorize] 但非 scope 门禁）的用户端点上满足 GetRequiredUserId()，
                // 等于 document-store:write 这种最小权限 key 越权成 owner 身份访问全站。
                // owner 身份只在「通过 scope 门禁的 AdminController 端点」上注入（见 AdminPermissionMiddleware）。
                new Claim("authType", "agent-apikey"),
                new Claim("agentApiKeyId", key.Id)
            };
            // 接入台能力目录里的 scope 要按「密钥主人此刻还有没有那个权限位」二次核对：
            // 签发时校验过一次，但权限随后可能被管理员回收，而密钥还在外面跑。
            // 只查一次权限（而且只在确实需要时才查），老 scope 不受影响。
            //
            // 自动模式（用户没动过高级设置）根本不读存的那份清单：它的清单就是「主人此刻有什么」，
            // 所以必须先把权限查出来再推导。平台以后新开一块能力，这里当场就把它算进去 ——
            // 这正是「新增的自动跟着走」那条语义的落点，不需要谁回来给存量密钥补一次 scope。
            var isAutoScope = key.ScopeMode == AgentApiKeyScopeMode.Auto;
            var storedScopes = (key.Scopes ?? new List<string>())
                .Where(s => !string.IsNullOrWhiteSpace(s))
                .ToList();

            IReadOnlyList<string>? ownerPermissions = null;
            if (isAutoScope || storedScopes.Any(McpCapabilityCatalog.PermissionCheckedScopes.Contains))
            {
                // root 破窗账户不在 Mongo 里，按 isRoot:false 去查它的权限只会拿到空集合，
                // 于是刚在控制台签出来的密钥下一秒就被剥光 scope。身份按 owner id 认，与 JwtService 同一个判据。
                var ownerIsRoot = string.Equals(key.OwnerUserId, AdminPermissionCatalog.RootUserId, StringComparison.Ordinal);
                ownerPermissions = await _permissionService.GetEffectivePermissionsAsync(key.OwnerUserId, ownerIsRoot);
            }

            // 自动模式的清单是推导出来的，推导时已经按签发口径过了权限，下面那道再检不必重复；
            // 手动模式仍走原来的口径（只查 PermissionCheckedScopes，放过存量的 document-store）。
            var declaredScopes = isAutoScope
                ? McpCapabilityCatalog.AutoScopesFor(ownerPermissions ?? Array.Empty<string>())
                : storedScopes;

            foreach (var scope in declaredScopes)
            {
                if (!isAutoScope
                    && McpCapabilityCatalog.PermissionCheckedScopes.Contains(scope)
                    && !McpCapabilityCatalog.PermissionsAllowScope(ownerPermissions ?? Array.Empty<string>(), scope))
                {
                    Logger.LogWarning("AgentApiKey {KeyId} 携带的 scope {Scope} 已失效：主人 {UserId} 当前没有对应权限位，本次请求按未授权处理",
                        key.Id, scope, key.OwnerUserId);
                    continue;
                }
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
            // 一次 MCP 工具调用会认证两遍：外面那次打在 /api/mcp 上，网关随后把同一把钥匙
            // 回环转给真正的接口，于是这里又认一遍。两遍都记一次用量的话，密钥管理页上的
            // 「累计请求数」对一次调用涨 2、对一批 N 个工具涨 N+1 —— 用户看到的数字不是他做的事。
            // 回环那一跳凭进程内令牌自证（外部无从伪造），和限流、配额闸门放行它是同一个判据。
            if (!_mcpLoopback.IsGatewayContinuation(Request))
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
            AuthorizationFailureContract.Set(Context, AuthorizationFailureContract.OpenPlatformKeyInvalid);
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

    protected override Task HandleChallengeAsync(AuthenticationProperties properties) =>
        AuthorizationFailureContract.WriteChallengeAsync(Context);
}

/// <summary>
/// API Key 认证选项
/// </summary>
public class ApiKeyAuthenticationOptions : AuthenticationSchemeOptions
{
}
