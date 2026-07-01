using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers;

[ApiController]
[Route("api/v1/auth/miduo-planet")]
public class MiduoPlanetSsoController : ControllerBase
{
    private readonly IUserService _userService;
    private readonly IJwtService _jwtService;
    private readonly IAuthSessionService _authSessionService;
    private readonly MongoDbContext _db;
    private readonly IConfiguration _cfg;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<MiduoPlanetSsoController> _logger;

    public MiduoPlanetSsoController(
        IUserService userService,
        IJwtService jwtService,
        IAuthSessionService authSessionService,
        MongoDbContext db,
        IConfiguration cfg,
        IHttpClientFactory httpClientFactory,
        ILogger<MiduoPlanetSsoController> logger)
    {
        _userService = userService;
        _jwtService = jwtService;
        _authSessionService = authSessionService;
        _db = db;
        _cfg = cfg;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    [HttpGet("options")]
    [ProducesResponseType(typeof(ApiResponse<SsoOptionsResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Options()
    {
        var options = await ReadOptionsAsync(HttpContext.RequestAborted);
        var items = options.Enabled
            ? new List<SsoLoginOption>
            {
                new()
                {
                    Provider = "miduo-planet",
                    Label = options.Label,
                    BaseUrl = options.BaseUrl,
                    AppCode = options.AppCode,
                    RedirectUri = options.RedirectUri
                }
            }
            : new List<SsoLoginOption>();

        return Ok(ApiResponse<SsoOptionsResponse>.Ok(new SsoOptionsResponse
        {
            Items = items,
            PasswordLoginDisabled = options.PasswordLoginDisabled
        }));
    }

    [HttpPost("login")]
    [ProducesResponseType(typeof(ApiResponse<LoginResponse>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> Login([FromBody] MiduoPlanetSsoLoginRequest request, CancellationToken ct)
    {
        var options = await ReadOptionsAsync(ct);
        if (!options.Enabled)
        {
            return NotFound(ApiResponse<object>.Fail("SSO_DISABLED", "米多星球 SSO 未启用"));
        }

        var token = (request.Token ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(token))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "token 不能为空"));
        }

        var clientType = (request.ClientType ?? string.Empty).Trim().ToLowerInvariant();
        if (clientType is not "admin" and not "desktop")
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "clientType 必须是 admin 或 desktop"));
        }

        var profile = await ValidateLoginTokenAsync(options, token, ct);
        if (profile == null || string.IsNullOrWhiteSpace(profile.SubjectValue))
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.UNAUTHORIZED, "米多星球令牌无效或用户信息不完整"));
        }

        var subjectHash = HashSsoSubject(options.AppCode, options.SubjectType, profile.SubjectValue);
        var users = await _db.Users
            .Find(u => u.MiduoSsoSubjectType == options.SubjectType && u.MiduoSsoSubjectHash == subjectHash)
            .Limit(2)
            .ToListAsync(ct);

        if (users.Count == 0)
        {
            return Unauthorized(ApiResponse<object>.Fail("SSO_USER_NOT_BOUND", "米多星球账号未绑定 MAP 用户"));
        }
        if (users.Count > 1)
        {
            _logger.LogError("Miduo Planet SSO binding duplicated. subjectType={SubjectType}", options.SubjectType);
            return Unauthorized(ApiResponse<object>.Fail("SSO_BINDING_DUPLICATED", "米多星球账号绑定不唯一，请联系管理员"));
        }

        var user = users[0];

        if (user.UserType == UserType.Bot)
        {
            return Unauthorized(ApiResponse<object>.Fail(ErrorCodes.INVALID_CREDENTIALS, "机器人账号不能登录"));
        }

        if (user.Status == UserStatus.Disabled)
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail(ErrorCodes.ACCOUNT_DISABLED, "账号已被禁用"));
        }

        await _userService.UpdateLastLoginAsync(user.UserId);
        await _userService.UpdateLastActiveAsync(user.UserId);

        var tokenVersion = await _authSessionService.GetTokenVersionAsync(user.UserId, clientType);
        var (sessionKey, refreshToken) = await _authSessionService.CreateRefreshSessionAsync(user.UserId, clientType);
        var accessToken = _jwtService.GenerateAccessToken(user, clientType, sessionKey, tokenVersion);
        var avatarUrl = AvatarUrlBuilder.Build(_cfg, user);

        _logger.LogInformation("User logged in via Miduo Planet SSO: {Username}", user.Username);

        return Ok(ApiResponse<LoginResponse>.Ok(new LoginResponse
        {
            AccessToken = accessToken,
            RefreshToken = refreshToken,
            SessionKey = sessionKey,
            ClientType = clientType,
            ExpiresIn = 3600,
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
                AvatarUrl = avatarUrl
            }
        }));
    }

    private async Task<MiduoPlanetSsoOptions> ReadOptionsAsync(CancellationToken ct)
    {
        var settings = await _db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(ct);
        var enabledFromConfig = IsTruthy(FirstConfig("MiduoSso:Enabled", "MIDUO_SSO_ENABLED", "MiduoPlanetSso:Enabled", "MIDUO_PLANET_SSO_ENABLED"));
        var enabled = settings?.MiduoSsoEnabled ?? enabledFromConfig;
        var passwordLoginDisabled = settings?.PasswordLoginDisabled == true
            && !IsTruthy(FirstConfig("MAP_PASSWORD_LOGIN_BREAK_GLASS", "PASSWORD_LOGIN_BREAK_GLASS", "MIDUO_SSO_PASSWORD_LOGIN_BREAK_GLASS"));

        var baseUrl = NormalizeAbsoluteHttpUrl(FirstNonEmpty(settings?.MiduoSsoBaseUrl, FirstConfig("MiduoSso:BaseUrl", "MIDUO_SSO_BASE_URL", "MiduoPlanetSso:BaseUrl", "MIDUO_PLANET_SSO_BASE_URL")), trimTrailingSlash: true);
        var appCode = FirstNonEmpty(settings?.MiduoSsoAppCode, FirstConfig("MiduoSso:AppCode", "MIDUO_SSO_APP_CODE", "MiduoPlanetSso:AppCode", "MIDUO_PLANET_SSO_APP_CODE"));
        var appSecret = FirstNonEmpty(settings?.MiduoSsoAppSecret, FirstConfig("MiduoSso:AppSecret", "MIDUO_SSO_APP_SECRET", "MiduoPlanetSso:AppSecret", "MIDUO_PLANET_SSO_APP_SECRET"));
        var redirectUri = NormalizeAbsoluteHttpUrl(FirstNonEmpty(settings?.MiduoSsoRedirectUri, FirstConfig("MiduoSso:RedirectUri", "MIDUO_SSO_REDIRECT_URI", "MiduoPlanetSso:RedirectUri", "MIDUO_PLANET_SSO_REDIRECT_URI")), trimTrailingSlash: false);
        if (string.IsNullOrWhiteSpace(baseUrl)
            || string.IsNullOrWhiteSpace(appCode)
            || string.IsNullOrWhiteSpace(appSecret)
            || string.IsNullOrWhiteSpace(redirectUri))
        {
            enabled = false;
        }

        return new MiduoPlanetSsoOptions
        {
            Enabled = enabled,
            Label = FirstNonEmpty(settings?.MiduoSsoLabel, FirstConfig("MiduoSso:Label", "MIDUO_SSO_LABEL", "MiduoPlanetSso:Label", "MIDUO_PLANET_SSO_LABEL")) ?? "米多星球",
            BaseUrl = baseUrl ?? string.Empty,
            AppCode = appCode ?? string.Empty,
            AppSecret = appSecret ?? string.Empty,
            RedirectUri = redirectUri ?? string.Empty,
            SubjectType = NormalizeSubjectType(FirstNonEmpty(settings?.MiduoSsoSubjectType, FirstConfig("MiduoSso:SubjectType", "MIDUO_SSO_SUBJECT_TYPE", "MiduoPlanetSso:SubjectType", "MIDUO_PLANET_SSO_SUBJECT_TYPE"))),
            PasswordLoginDisabled = passwordLoginDisabled
        };
    }

    private static string? FirstNonEmpty(params string?[] values)
    {
        foreach (var value in values)
        {
            if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
        }
        return null;
    }

    private string? FirstConfig(params string[] keys)
    {
        foreach (var key in keys)
        {
            var value = _cfg[key];
            if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
        }
        return null;
    }

    private static bool IsTruthy(string? value)
    {
        return string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "on", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<MiduoPlanetProfile?> ValidateLoginTokenAsync(MiduoPlanetSsoOptions options, string token, CancellationToken ct)
    {
        var client = _httpClientFactory.CreateClient("SafeOutbound");
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
        var nonce = Guid.NewGuid().ToString("N");
        var signature = ComputeSignature(options.AppCode, options.AppSecret, timestamp, nonce, token);

        using var req = new HttpRequestMessage(HttpMethod.Post, $"{options.BaseUrl}/api/open/sso/validate-login-token");
        req.Headers.TryAddWithoutValidation("X-App-Code", options.AppCode);
        req.Headers.TryAddWithoutValidation("X-App-Timestamp", timestamp);
        req.Headers.TryAddWithoutValidation("X-App-Nonce", nonce);
        req.Headers.TryAddWithoutValidation("X-App-Signature", signature);
        req.Content = JsonContent.Create(new { token });

        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            _logger.LogWarning("Miduo Planet SSO validate-login-token failed with status {StatusCode}", (int)resp.StatusCode);
            return null;
        }

        await using var stream = await resp.Content.ReadAsStreamAsync(ct);
        using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
        if (!ReadJsonBool(doc.RootElement, "return_data.valid"))
        {
            return null;
        }

        var subject = ReadJsonPath(doc.RootElement, $"return_data.{options.SubjectType}");
        var displayName = ReadJsonPath(doc.RootElement, "return_data.userName");

        return string.IsNullOrWhiteSpace(subject)
            ? null
            : new MiduoPlanetProfile
            {
                SubjectValue = NormalizeSubjectValue(options.SubjectType, subject),
                DisplayName = displayName?.Trim()
            };
    }

    private static string ComputeSignature(string appCode, string appSecret, string timestamp, string nonce, string signedValue)
    {
        var canonical = $"{appCode}\n{timestamp}\n{nonce}\n{signedValue}";
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(appSecret));
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(canonical));
        return Convert.ToBase64String(hash);
    }

    private static string HashSsoSubject(string appCode, string subjectType, string subjectValue)
    {
        var normalized = NormalizeSubjectValue(subjectType, subjectValue);
        var material = $"miduo-planet\n{appCode.Trim().ToUpperInvariant()}\n{subjectType}\n{normalized}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static string NormalizeSubjectType(string? subjectType)
    {
        var t = (subjectType ?? string.Empty).Trim();
        return t is "wework_userid" or "employeeNo" ? t : "mobile";
    }

    private static string NormalizeSubjectValue(string subjectType, string value)
    {
        var v = (value ?? string.Empty).Trim();
        return subjectType == "mobile" ? new string(v.Where(char.IsDigit).ToArray()) : v;
    }

    private static string? NormalizeAbsoluteHttpUrl(string? value, bool trimTrailingSlash)
    {
        var raw = (value ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw) || raw.StartsWith('/')) return null;

        var withScheme = raw.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            || raw.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                ? raw
                : $"https://{raw}";
        if (!Uri.TryCreate(withScheme, UriKind.Absolute, out var uri)
            || uri.Scheme is not ("http" or "https")
            || string.IsNullOrWhiteSpace(uri.Host))
        {
            return null;
        }

        var normalized = uri.ToString();
        return trimTrailingSlash ? normalized.TrimEnd('/') : normalized;
    }

    private static string? ReadJsonPath(JsonElement root, string path)
    {
        var current = root;
        foreach (var segment in path.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
            {
                return null;
            }
        }

        return current.ValueKind switch
        {
            JsonValueKind.String => current.GetString(),
            JsonValueKind.Number => current.GetRawText(),
            _ => null
        };
    }

    private static bool ReadJsonBool(JsonElement root, string path)
    {
        var current = root;
        foreach (var segment in path.Split('.', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (current.ValueKind != JsonValueKind.Object || !current.TryGetProperty(segment, out current))
            {
                return false;
            }
        }

        return current.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String => bool.TryParse(current.GetString(), out var value) && value,
            _ => false
        };
    }

    private sealed class MiduoPlanetSsoOptions
    {
        public bool Enabled { get; set; }
        public string Label { get; set; } = string.Empty;
        public string BaseUrl { get; set; } = string.Empty;
        public string AppCode { get; set; } = string.Empty;
        public string AppSecret { get; set; } = string.Empty;
        public string RedirectUri { get; set; } = string.Empty;
        public string SubjectType { get; set; } = "mobile";
        public bool PasswordLoginDisabled { get; set; }
    }

    private sealed class MiduoPlanetProfile
    {
        public string SubjectValue { get; set; } = string.Empty;
        public string? DisplayName { get; set; }
    }
}

public class SsoOptionsResponse
{
    public List<SsoLoginOption> Items { get; set; } = new();
    public bool PasswordLoginDisabled { get; set; }
}

public class SsoLoginOption
{
    public string Provider { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public string BaseUrl { get; set; } = string.Empty;
    public string AppCode { get; set; } = string.Empty;
    public string RedirectUri { get; set; } = string.Empty;
}

public class MiduoPlanetSsoLoginRequest
{
    public string Token { get; set; } = string.Empty;
    public string ClientType { get; set; } = string.Empty;
}
