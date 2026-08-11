using System.IdentityModel.Tokens.Jwt;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 为自动化验收签发短时、单次消费的登录入口。
/// 此通道不接受账号密码，也不改变环境的 SSO 或密码登录策略。
/// </summary>
[ApiController]
[Route("api/v1/auth/synthetic")]
public sealed class SyntheticLoginController : ControllerBase
{
    private const string TicketCollectionName = "console_sso_tickets";
    private const string TicketPurpose = "stable-smoke-login";
    private const int DefaultTicketSeconds = 180;
    private const int MinTicketSeconds = 60;
    private const int MaxTicketSeconds = 300;
    private const int SessionMinutes = 30;

    private readonly MongoDbContext _db;
    private readonly IConfiguration _configuration;
    private readonly IJwtService _jwtService;
    private readonly IAuthSessionService _authSessionService;
    private readonly ILogger<SyntheticLoginController> _logger;

    public SyntheticLoginController(
        MongoDbContext db,
        IConfiguration configuration,
        IJwtService jwtService,
        IAuthSessionService authSessionService,
        ILogger<SyntheticLoginController> logger)
    {
        _db = db;
        _configuration = configuration;
        _jwtService = jwtService;
        _authSessionService = authSessionService;
        _logger = logger;
    }

    [HttpPost("ticket")]
    [Authorize(AuthenticationSchemes = AiAccessKeyAuthenticationHandler.SchemeName)]
    [ProducesResponseType(typeof(ApiResponse<SyntheticLoginTicketResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> IssueTicket(
        [FromBody] SyntheticLoginTicketRequest request,
        CancellationToken ct)
    {
        if (!IsEnabled(_configuration))
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                ApiResponse<object>.Fail(
                    "SYNTHETIC_LOGIN_DISABLED",
                    "合成测试登录未启用，请由管理员开启后重试"));
        }

        var username = User.FindFirst(JwtRegisteredClaimNames.UniqueName)?.Value?.Trim() ?? string.Empty;
        if (!IsAllowedUser(username, ReadAllowedUsers(_configuration)))
        {
            _logger.LogWarning(
                "Synthetic login ticket denied. username={Username}, requestId={RequestId}",
                username,
                HttpContext.TraceIdentifier);
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(
                    "SYNTHETIC_LOGIN_ACCOUNT_NOT_ALLOWED",
                    "当前账号不是合成测试专用账号，请更换已授权账号后重试"));
        }

        if (!TryNormalizeReturnUrl(request.ReturnUrl, out var returnUrl))
        {
            return BadRequest(ApiResponse<object>.Fail(
                "SYNTHETIC_LOGIN_RETURN_URL_INVALID",
                "目标页面必须是当前站点内的有效路径，请修改后重试"));
        }

        var userId = User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value?.Trim() ?? string.Empty;
        var user = await _db.Users.Find(item => item.UserId == userId).FirstOrDefaultAsync(ct);
        if (user is null || user.Status != UserStatus.Active || user.UserType != UserType.Human)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(
                    "SYNTHETIC_LOGIN_ACCOUNT_UNAVAILABLE",
                    "合成测试账号不可用，请检查账号状态后重试"));
        }

        var lifetimeSeconds = NormalizeTicketSeconds(request.ExpiresInSeconds);
        var now = DateTime.UtcNow;
        var expiresAt = now.AddSeconds(lifetimeSeconds);
        var code = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var ticketId = Guid.NewGuid().ToString("N");
        var tickets = _db.Database.GetCollection<BsonDocument>(TicketCollectionName);
        await tickets.InsertOneAsync(new BsonDocument
        {
            { "_id", ticketId },
            { "CodeHash", Hash(code) },
            { "Purpose", TicketPurpose },
            { "UserId", user.UserId },
            { "Username", user.Username },
            { "ReturnUrl", returnUrl },
            { "State", "issued" },
            { "CreatedAt", now },
            { "ExpiresAt", expiresAt },
            { "ConsumedAt", BsonNull.Value },
        }, cancellationToken: ct);

        var loginUrl = BuildLoginUrl(code, returnUrl);
        _logger.LogWarning(
            "Synthetic login ticket issued. ticketId={TicketId}, username={Username}, expiresAt={ExpiresAt}, requestId={RequestId}",
            ticketId,
            user.Username,
            expiresAt,
            HttpContext.TraceIdentifier);

        return Ok(ApiResponse<SyntheticLoginTicketResponse>.Ok(new SyntheticLoginTicketResponse
        {
            LoginUrl = loginUrl,
            ExpiresAt = expiresAt,
            TicketId = ticketId,
        }));
    }

    [HttpPost("exchange")]
    [AllowAnonymous]
    [ProducesResponseType(typeof(ApiResponse<LoginResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Exchange(
        [FromBody] SyntheticLoginExchangeRequest request,
        CancellationToken ct)
    {
        if (!IsEnabled(_configuration))
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                ApiResponse<object>.Fail(
                    "SYNTHETIC_LOGIN_DISABLED",
                    "合成测试登录未启用，请重新生成入口后再试"));
        }
        if (string.IsNullOrWhiteSpace(request.Code) || request.Code.Length is < 32 or > 256)
        {
            return Unauthorized(ApiResponse<object>.Fail(
                "SYNTHETIC_LOGIN_TICKET_INVALID",
                "一次性登录入口已失效，请重新生成后再试"));
        }

        var now = DateTime.UtcNow;
        var tickets = _db.Database.GetCollection<BsonDocument>(TicketCollectionName);
        var ticket = await tickets.FindOneAndUpdateAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("CodeHash", Hash(request.Code.Trim())),
                Builders<BsonDocument>.Filter.Eq("Purpose", TicketPurpose),
                Builders<BsonDocument>.Filter.Eq("State", "issued"),
                Builders<BsonDocument>.Filter.Gt("ExpiresAt", now)),
            Builders<BsonDocument>.Update
                .Set("State", "consumed")
                .Set("ConsumedAt", now),
            new FindOneAndUpdateOptions<BsonDocument, BsonDocument>
            {
                ReturnDocument = ReturnDocument.After,
            },
            ct);
        if (ticket is null)
        {
            return Unauthorized(ApiResponse<object>.Fail(
                "SYNTHETIC_LOGIN_TICKET_INVALID",
                "一次性登录入口已失效，请重新生成后再试"));
        }

        var userId = ticket.GetValue("UserId", string.Empty).AsString;
        var username = ticket.GetValue("Username", string.Empty).AsString;
        var user = await _db.Users.Find(item => item.UserId == userId).FirstOrDefaultAsync(ct);
        if (user is null
            || user.Status != UserStatus.Active
            || user.UserType != UserType.Human
            || !IsAllowedUser(user.Username, ReadAllowedUsers(_configuration)))
        {
            _logger.LogWarning(
                "Synthetic login ticket consumed for unavailable account. ticketId={TicketId}, username={Username}, requestId={RequestId}",
                ticket["_id"].AsString,
                username,
                HttpContext.TraceIdentifier);
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(
                    "SYNTHETIC_LOGIN_ACCOUNT_UNAVAILABLE",
                    "合成测试账号不可用，请检查账号状态后重新生成入口"));
        }

        const string clientType = "admin";
        var tokenVersion = await _authSessionService.GetTokenVersionAsync(user.UserId, clientType, ct);
        var sessionKey = $"synthetic-{Guid.NewGuid():N}";
        var sessionMinutes = Math.Min(
            SessionMinutes,
            AuthTokenLifetimes.EffectiveAccessTokenMinutes(
                _configuration.GetValue<int>(
                    "Jwt:AccessTokenMinutes",
                    AuthTokenLifetimes.DefaultAccessTokenMinutes),
                _configuration.GetValue<int>(
                    "Auth:SessionSlidingDays",
                    AuthTokenLifetimes.DefaultSessionSlidingDays)));
        var accessToken = _jwtService.GenerateAccessToken(
            user,
            clientType,
            sessionKey,
            tokenVersion,
            sessionMinutes,
            "synthetic-test");
        var avatarUrl = AvatarUrlBuilder.Build(_configuration, user);

        _logger.LogWarning(
            "Synthetic login session established. ticketId={TicketId}, username={Username}, sessionMinutes={SessionMinutes}, requestId={RequestId}",
            ticket["_id"].AsString,
            user.Username,
            sessionMinutes,
            HttpContext.TraceIdentifier);

        return Ok(ApiResponse<LoginResponse>.Ok(new LoginResponse
        {
            AccessToken = accessToken,
            RefreshToken = string.Empty,
            SessionKey = sessionKey,
            ClientType = clientType,
            ExpiresIn = sessionMinutes * 60,
            MustResetPassword = false,
            User = new UserInfo
            {
                UserId = user.UserId,
                Username = user.Username,
                DisplayName = user.DisplayName,
                Role = user.Role,
                UserType = user.UserType,
                BotKind = user.BotKind,
                AvatarFileName = user.AvatarFileName,
                AvatarUrl = avatarUrl,
            },
        }));
    }

    private static bool IsEnabled(IConfiguration configuration) =>
        IsTruthy(configuration["SyntheticLogin:Enabled"] ?? configuration["SYNTHETIC_LOGIN_ENABLED"]);

    private static IReadOnlySet<string> ReadAllowedUsers(IConfiguration configuration) =>
        (configuration["SyntheticLogin:AllowedUsers"]
            ?? configuration["SYNTHETIC_LOGIN_ALLOWED_USERS"]
            ?? string.Empty)
        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
        .ToHashSet(StringComparer.OrdinalIgnoreCase);

    private static bool IsAllowedUser(string? username, IReadOnlySet<string> allowedUsers) =>
        !string.IsNullOrWhiteSpace(username) && allowedUsers.Contains(username.Trim());

    private static int NormalizeTicketSeconds(int? requestedSeconds) =>
        Math.Clamp(requestedSeconds ?? DefaultTicketSeconds, MinTicketSeconds, MaxTicketSeconds);

    private static string BuildLoginUrl(string code, string returnUrl) =>
        $"/synthetic-login#code={Uri.EscapeDataString(code)}&returnUrl={Uri.EscapeDataString(returnUrl)}";

    private static bool TryNormalizeReturnUrl(string? raw, out string returnUrl)
    {
        returnUrl = "/";
        var value = string.IsNullOrWhiteSpace(raw) ? "/" : raw.Trim();
        if (!value.StartsWith("/", StringComparison.Ordinal)
            || value.StartsWith("//", StringComparison.Ordinal)
            || value.Contains('\\')
            || value.Any(char.IsControl))
        {
            return false;
        }
        returnUrl = value;
        return true;
    }

    private static bool IsTruthy(string? value) =>
        value is not null
        && (value.Equals("1", StringComparison.OrdinalIgnoreCase)
            || value.Equals("true", StringComparison.OrdinalIgnoreCase)
            || value.Equals("yes", StringComparison.OrdinalIgnoreCase)
            || value.Equals("on", StringComparison.OrdinalIgnoreCase));

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}

public sealed class SyntheticLoginTicketRequest
{
    public string? ReturnUrl { get; set; }
    public int? ExpiresInSeconds { get; set; }
}

public sealed class SyntheticLoginExchangeRequest
{
    public string Code { get; set; } = string.Empty;
}

public sealed class SyntheticLoginTicketResponse
{
    public string LoginUrl { get; set; } = string.Empty;
    public DateTime ExpiresAt { get; set; }
    public string TicketId { get; set; } = string.Empty;
}
