using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Authentication;

/// <summary>
/// AI 超级访问密钥认证处理器
/// 通过环境变量 AI_ACCESS_KEY 配置超级密钥
/// 请求头：X-AI-Access-Key: {密钥}
/// 请求头：X-AI-Impersonate: {用户名}
/// </summary>
public class AiAccessKeyAuthenticationHandler : AuthenticationHandler<AiAccessKeyAuthenticationOptions>
{
    private readonly IConfiguration _configuration;
    private readonly IUserService _userService;

    public const string SchemeName = "AiAccessKey";

    /// <summary>
    /// 自定义 Claim 类型：标记为 AI 超级访问模式
    /// </summary>
    public const string ClaimTypeIsAiSuperAccess = "isAiSuperAccess";

    public AiAccessKeyAuthenticationHandler(
        IOptionsMonitor<AiAccessKeyAuthenticationOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder,
        IConfiguration configuration,
        IUserService userService)
        : base(options, logger, encoder)
    {
        _configuration = configuration;
        _userService = userService;
    }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var requestPath = Request.Path.Value;
        var requestMethod = Request.Method;
        var clientIp = Context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

        // 1. 检查是否有 X-AI-Access-Key 头部
        if (!Request.Headers.TryGetValue("X-AI-Access-Key", out var accessKeyHeader))
        {
            return AuthenticateResult.NoResult();
        }

        var accessKey = accessKeyHeader.ToString().Trim();
        if (string.IsNullOrWhiteSpace(accessKey))
        {
            return AuthenticateResult.NoResult();
        }

        // 2. 从环境变量获取配置的超级密钥
        var configuredKey = (_configuration["AI_ACCESS_KEY"] ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(configuredKey))
        {
            Logger.LogWarning(
                "[401] AI Access Key 认证失败：服务器未配置 AI_ACCESS_KEY - Path: {Path}, Method: {Method}, IP: {IP}",
                requestPath, requestMethod, clientIp);
            return AuthenticateResult.Fail("AI Access Key authentication not configured");
        }

        // 3. 验证密钥
        if (!string.Equals(accessKey, configuredKey, StringComparison.Ordinal))
        {
            Logger.LogWarning(
                "[401] AI Access Key 无效 - Path: {Path}, Method: {Method}, IP: {IP}, KeyPrefix: {KeyPrefix}",
                requestPath, requestMethod, clientIp,
                accessKey.Length > 8 ? accessKey[..8] + "..." : accessKey);
            return AuthenticateResult.Fail("Invalid AI Access Key");
        }

        // 4. 检查 X-AI-Impersonate 头部（必需）
        if (!Request.Headers.TryGetValue("X-AI-Impersonate", out var impersonateHeader))
        {
            Logger.LogWarning(
                "[401] AI Access Key 认证失败：缺少 X-AI-Impersonate 头部 - Path: {Path}, Method: {Method}, IP: {IP}",
                requestPath, requestMethod, clientIp);
            return AuthenticateResult.Fail("X-AI-Impersonate header is required");
        }

        var impersonateUsername = impersonateHeader.ToString().Trim();
        if (string.IsNullOrWhiteSpace(impersonateUsername))
        {
            Logger.LogWarning(
                "[401] AI Access Key 认证失败：X-AI-Impersonate 为空 - Path: {Path}, Method: {Method}, IP: {IP}",
                requestPath, requestMethod, clientIp);
            return AuthenticateResult.Fail("X-AI-Impersonate header cannot be empty");
        }

        // 5. 验证用户存在（从数据库查询）
        var user = await _userService.GetByUsernameAsync(impersonateUsername);
        if (user == null)
        {
            Logger.LogWarning(
                "[401] AI Access Key 认证失败：用户不存在 - Path: {Path}, Method: {Method}, IP: {IP}, Username: {Username}",
                requestPath, requestMethod, clientIp, impersonateUsername);
            return AuthenticateResult.Fail($"User '{impersonateUsername}' not found");
        }

        // 6. 检查用户状态（禁用的用户不允许模拟）
        if (user.Status == UserStatus.Disabled)
        {
            Logger.LogWarning(
                "[401] AI Access Key 认证失败：用户已禁用 - Path: {Path}, Method: {Method}, IP: {IP}, Username: {Username}",
                requestPath, requestMethod, clientIp, impersonateUsername);
            return AuthenticateResult.Fail($"User '{impersonateUsername}' is disabled");
        }

        // 7. 构造 Claims（以被模拟用户的身份，但附加超级权限标记）
        var claims = new List<Claim>
        {
            // 标准 JWT claims - 使用被模拟用户的身份
            new Claim(JwtRegisteredClaimNames.Sub, user.UserId),
            new Claim(JwtRegisteredClaimNames.UniqueName, user.Username),
            new Claim("displayName", user.DisplayName),
            new Claim("role", user.Role.ToString()),

            // 客户端类型标记为 AI 访问
            new Claim("clientType", "ai"),

            // 超级访问标记
            new Claim(ClaimTypeIsAiSuperAccess, "1"),

            // 认证类型
            new Claim("authType", "ai-access-key")
        };

        Logger.LogInformation(
            "AI Access Key 认证成功 - Path: {Path}, Method: {Method}, IP: {IP}, ImpersonatedUser: {Username}, UserId: {UserId}",
            requestPath, requestMethod, clientIp, user.Username, user.UserId);

        var identity = new ClaimsIdentity(claims, Scheme.Name);
        var principal = new ClaimsPrincipal(identity);
        var ticket = new AuthenticationTicket(principal, Scheme.Name);

        return AuthenticateResult.Success(ticket);
    }
}

/// <summary>
/// AI 超级访问密钥认证选项
/// </summary>
public class AiAccessKeyAuthenticationOptions : AuthenticationSchemeOptions
{
}
