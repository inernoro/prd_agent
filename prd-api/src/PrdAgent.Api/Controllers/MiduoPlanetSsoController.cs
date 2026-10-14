using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Diagnostics;
using System.Reflection;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Diagnostics;
using PrdAgent.Core.Attributes;
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
    private readonly IIdGenerator _idGenerator;
    private readonly MongoDbContext _db;
    private readonly IConfiguration _cfg;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<MiduoPlanetSsoController> _logger;
    private readonly IMiduoPlanetSsoAuditWriter _auditWriter;

    public MiduoPlanetSsoController(
        IUserService userService,
        IJwtService jwtService,
        IAuthSessionService authSessionService,
        IIdGenerator idGenerator,
        MongoDbContext db,
        IConfiguration cfg,
        IHttpClientFactory httpClientFactory,
        ILogger<MiduoPlanetSsoController> logger,
        IMiduoPlanetSsoAuditWriter auditWriter)
    {
        _userService = userService;
        _jwtService = jwtService;
        _authSessionService = authSessionService;
        _idGenerator = idGenerator;
        _db = db;
        _cfg = cfg;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
        _auditWriter = auditWriter;
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
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status502BadGateway)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status503ServiceUnavailable)]
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

        var validation = await ValidateLoginTokenAsync(options, token, clientType, ct);
        if (validation.ErrorCode != null)
        {
            var message = validation.ErrorCode switch
            {
                "SSO_AUDIT_UNAVAILABLE" => "登录诊断记录暂时不可用，请稍后重试；若持续失败，请联系管理员检查日志服务。",
                "SSO_PROVIDER_UNAVAILABLE" => "米多星球登录校验暂时不可用，请稍后重试；若持续失败，请联系管理员检查登录服务。",
                "SSO_USER_UNAVAILABLE" => "米多星球无法提供当前账号的身份信息，请联系米多星球管理员检查账号。",
                "SSO_PROFILE_INCOMPLETE" => "米多星球未提供有效的账号绑定信息，请联系米多星球管理员检查账号资料和授权字段。",
                _ => "米多星球登录凭证校验未通过，请点击米多星球重新发起登录；若持续失败，请联系米多星球管理员。"
            };
            return StatusCode(validation.ErrorCode == "SSO_AUDIT_UNAVAILABLE" ? 503 : validation.ErrorCode == "SSO_PROVIDER_UNAVAILABLE" ? 502 : 401,
                ApiResponse<object>.Fail(validation.ErrorCode, message));
        }
        var profile = validation.Profile!;

        var subjectHash = HashSsoSubject(options.AppCode, options.SubjectType, profile.SubjectValue);
        var users = await _db.Users
            .Find(u => u.MiduoSsoSubjectType == options.SubjectType && u.MiduoSsoSubjectHash == subjectHash)
            .Limit(2)
            .ToListAsync(ct);

        if (users.Count == 0)
        {
            var created = await CreateSsoUserAsync(options, profile, subjectHash);
            users = await _db.Users
                .Find(u => u.MiduoSsoSubjectType == options.SubjectType && u.MiduoSsoSubjectHash == subjectHash)
                .Limit(2)
                .ToListAsync(ct);
            if (users.Count == 0 && created != null)
            {
                users = new List<User> { created };
            }
        }
        if (users.Count == 0)
        {
            _logger.LogError("Miduo Planet SSO auto-create failed after re-read. subjectType={SubjectType}", options.SubjectType);
            return StatusCode(StatusCodes.Status409Conflict,
                ApiResponse<object>.Fail("SSO_AUTO_CREATE_FAILED", "米多星球账号自动创建失败，请稍后重试"));
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
            ExpiresIn = AuthTokenLifetimes.EffectiveAccessTokenMinutes(
                _cfg.GetValue<int>("Jwt:AccessTokenMinutes", AuthTokenLifetimes.DefaultAccessTokenMinutes),
                _cfg.GetValue<int>("Auth:SessionSlidingDays", AuthTokenLifetimes.DefaultSessionSlidingDays)) * 60,
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

    private async Task<User?> CreateSsoUserAsync(
        MiduoPlanetSsoOptions options,
        MiduoPlanetProfile profile,
        string subjectHash)
    {
        var normalizedSubject = NormalizeSubjectValue(options.SubjectType, profile.SubjectValue);
        var username = BuildAutoUsername(options.AppCode, options.SubjectType, normalizedSubject);
        var displayName = NormalizeDisplayName(profile.DisplayName, options.SubjectType, normalizedSubject, username);
        var now = DateTime.UtcNow;
        var user = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("user"),
            Username = username,
            DisplayName = displayName,
            Role = UserRole.DEV,
            Status = UserStatus.Active,
            UserType = UserType.Human,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))),
            CreatedAt = now,
            MustResetPassword = false,
            MiduoSsoSubjectType = options.SubjectType,
            MiduoSsoSubjectHash = subjectHash,
            MiduoSsoSubjectMasked = MaskSubjectValue(options.SubjectType, normalizedSubject),
            MiduoSsoDisplayNameSnapshot = displayName,
            MiduoSsoBoundAt = now
        };

        try
        {
            await _db.Users.InsertOneAsync(user, cancellationToken: CancellationToken.None);
            _logger.LogWarning("Auto-created MAP user from Miduo Planet SSO: username={Username}, subjectType={SubjectType}",
                user.Username, options.SubjectType);
            return user;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            _logger.LogWarning("Miduo Planet SSO auto-create hit duplicate key, will re-read binding. username={Username}", username);
            return null;
        }
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
            PasswordLoginDisabled = passwordLoginDisabled,
            SettingsUpdatedAt = settings?.UpdatedAt
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

    private async Task<(MiduoPlanetProfile? Profile, string? ErrorCode)> ValidateLoginTokenAsync(MiduoPlanetSsoOptions options, string token, string clientType, CancellationToken ct)
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

        var context = ControllerContext.HttpContext;
        var requestId = context?.Items["RequestId"]?.ToString() ?? context?.TraceIdentifier ?? Guid.NewGuid().ToString("N");
        var actualCommit = BuildIdentity.ParseBakedCommit(typeof(MiduoPlanetSsoController).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion);
        var expectedCommit = FirstNonEmpty(_cfg?["GIT_COMMIT"], _cfg?["COMMIT_SHA"], _cfg?["GITHUB_SHA"],
            _cfg?["SOURCE_VERSION"], _cfg?["CDS_COMMIT_SHA"]);
        var audit = new ApiRequestLog
        {
            Id = Guid.NewGuid().ToString("N"), RequestId = requestId, StartedAt = DateTime.UtcNow,
            Method = "POST", Path = req.RequestUri!.AbsolutePath, AbsoluteUrl = MiduoPlanetSsoAudit.SafeUrl(req.RequestUri.ToString()),
            Protocol = req.RequestUri.Scheme, TargetHost = req.RequestUri.Host, RequestContentType = "application/json",
            AppName = AppNames.System, AppId = options.AppCode, UserId = "anonymous", ClientType = "server",
            Direction = "outbound", Status = "running",
            RequestBody = JsonSerializer.Serialize(new
            {
                auditVersion = 1, operation = "miduo-planet.validate-login-token", parentRequestId = requestId, attempt = 1,
                config = new { appCode = options.AppCode, subjectType = options.SubjectType, label = options.Label,
                    baseUrl = MiduoPlanetSsoAudit.SafeUrl(options.BaseUrl), redirectUri = MiduoPlanetSsoAudit.SafeUrl(options.RedirectUri),
                    enabled = options.Enabled, passwordLoginDisabled = options.PasswordLoginDisabled,
                    settingsUpdatedAt = options.SettingsUpdatedAt, keyFingerprint = MiduoPlanetSsoAudit.Fingerprint("config-key:v1", options.AppSecret) },
                runtime = new { actualCommit, expectedCommit, commitMatch = BuildIdentity.ToWireValue(BuildIdentity.Compare(actualCommit, expectedCommit)),
                    environment = _cfg?["ASPNETCORE_ENVIRONMENT"], deployment = _cfg?["CDS_BRANCH_ID"], project = _cfg?["CDS_PROJECT_ID"],
                    database = _db?.Database.DatabaseNamespace.DatabaseName, instance = Environment.MachineName, processId = Environment.ProcessId },
                request = new { timestamp, nonce, clientType, signingAlgorithm = "HMAC-SHA256", tokenLength = token.Length,
                    tokenKind = token.StartsWith("exch_", StringComparison.Ordinal) ? "exchange" : "other",
                    tokenFingerprint = MiduoPlanetSsoAudit.Fingerprint("request-token:" + token, options.AppSecret),
                    timeoutMs = client.Timeout == Timeout.InfiniteTimeSpan ? (double?)null : client.Timeout.TotalMilliseconds,
                    maxCaptureBytes = MiduoPlanetSsoAudit.MaxCaptureBytes,
                    clientOrigin = context == null ? null : MiduoPlanetSsoAudit.SafeUrl($"{context.Request.Scheme}://{context.Request.Host}{context.Request.Path}"),
                    userAgent = MiduoPlanetSsoAudit.SafeText(context?.Request.Headers.UserAgent.ToString() ?? "", [token, options.AppSecret]) }
            }),
            ResponseBody = MiduoPlanetSsoAudit.BuildResponse(null, "prepared", null, options.SubjectType, options.AppSecret, token, false, 0, null, null)
        };
        if (context != null) context.Response.Headers["X-SSO-Audit-Id"] = audit.Id;
        // 日志存储不可用时先拒绝调用，避免消费一次性凭证后完全没有证据。
        if (!await _auditWriter.BeginAsync(audit))
        {
            if (context != null) context.Response.Headers["X-SSO-Audit-Status"] = "unavailable";
            return (null, "SSO_AUDIT_UNAVAILABLE");
        }

        HttpResponseMessage? resp = null;
        string? raw = null;
        string? errorCode = null;
        MiduoPlanetProfile? profile = null;
        var stage = "sending";
        var capturedBytes = 0;
        var truncated = false;
        var bodyReadComplete = false;
        var auditCompleted = false;
        var stopwatch = Stopwatch.StartNew();
        using var captured = new MemoryStream();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        if (client.Timeout != Timeout.InfiniteTimeSpan) deadline.CancelAfter(client.Timeout);
        try
        {
            resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            stage = "reading_response";
            await using var stream = await resp.Content.ReadAsStreamAsync(deadline.Token);
            var buffer = new byte[8192];
            while (captured.Length <= MiduoPlanetSsoAudit.MaxCaptureBytes)
            {
                var count = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length,
                    MiduoPlanetSsoAudit.MaxCaptureBytes + 1 - (int)captured.Length)), deadline.Token);
                if (count == 0) { bodyReadComplete = true; break; }
                captured.Write(buffer, 0, count);
                capturedBytes = (int)Math.Min(captured.Length, MiduoPlanetSsoAudit.MaxCaptureBytes);
            }
            raw = Encoding.UTF8.GetString(captured.GetBuffer(), 0, capturedBytes);
            truncated = captured.Length > MiduoPlanetSsoAudit.MaxCaptureBytes;
            if (!resp.IsSuccessStatusCode || truncated)
            {
                stage = truncated ? "response_too_large" : "http_error";
                errorCode = "SSO_PROVIDER_UNAVAILABLE";
            }
            else
            {
                stage = "parsing_response";
                using var doc = JsonDocument.Parse(raw);
                errorCode = GetValidationError(doc.RootElement, options.SubjectType);
                stage = errorCode == null ? "identity_validated" : "validation_rejected";
                if (errorCode == null)
                    profile = new MiduoPlanetProfile
                    {
                        SubjectValue = NormalizeSubjectValue(options.SubjectType, ReadJsonPath(doc.RootElement, $"return_data.{options.SubjectType}")!),
                        DisplayName = ReadJsonPath(doc.RootElement, "return_data.userName")?.Trim()
                    };
            }
        }
        catch (Exception ex)
        {
            stage = ex is OperationCanceledException ? ct.IsCancellationRequested ? "caller_cancelled" : "timeout"
                : ex is JsonException ? "parse_error" : stage == "reading_response" ? "response_read_error" : "transport_error";
            errorCode = "SSO_PROVIDER_UNAVAILABLE";
            // 原始异常可能包含地址或凭据，只记录类型；返回正文由专用审计脱敏。
            audit.ApiSummary = JsonSerializer.Serialize(new { errorType = ex.GetType().Name });
        }
        finally
        {
            // 读流失败或超时也属于不完整响应，不能把已捕获的前缀伪装成完整正文。
            truncated = truncated || (resp != null && !bodyReadComplete);
            if (raw == null && capturedBytes > 0) raw = Encoding.UTF8.GetString(captured.GetBuffer(), 0, capturedBytes);
            stopwatch.Stop();
            audit.EndedAt = DateTime.UtcNow;
            audit.DurationMs = stopwatch.ElapsedMilliseconds;
            audit.StatusCode = resp == null ? 0 : (int)resp.StatusCode;
            audit.ResponseContentType = resp?.Content.Headers.ContentType?.MediaType;
            audit.ResponseBodyBytes = capturedBytes;
            audit.ErrorCode = errorCode;
            audit.Status = errorCode == null ? "completed" : stage == "timeout" ? "timeout" : "failed";
            audit.ResponseBodyTruncated = truncated;
            audit.ResponseBody = MiduoPlanetSsoAudit.BuildResponse(raw, stage, errorCode, options.SubjectType, options.AppSecret,
                token, truncated, capturedBytes, resp?.Content.Headers.ContentLength, resp);
            auditCompleted = await _auditWriter.CompleteAsync(audit);
            if (context != null) context.Response.Headers["X-SSO-Audit-Status"] = auditCompleted ? "complete" : "unavailable";
            _logger.LogInformation("Miduo Planet SSO audit completed. auditId={AuditId}, requestId={RequestId}, stage={Stage}, errorCode={ErrorCode}, persisted={Persisted}",
                audit.Id, audit.RequestId, stage, errorCode, auditCompleted);
            resp?.Dispose();
        }
        return auditCompleted ? (profile, errorCode) : (null, "SSO_AUDIT_UNAVAILABLE");
    }

    internal static string? GetValidationError(JsonElement root, string subjectType)
    {
        // 上游业务拒绝或响应缺失校验结果不等于用户的登录凭证失效。
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("return_data", out var data)
            || data.ValueKind != JsonValueKind.Object
            || !data.TryGetProperty("valid", out var valid)
            || !(valid.ValueKind is JsonValueKind.True or JsonValueKind.False
                 || (valid.ValueKind == JsonValueKind.String && bool.TryParse(valid.GetString(), out _))))
            return "SSO_PROVIDER_UNAVAILABLE";

        if (!ReadJsonBool(root, "return_data.valid"))
        {
            var upstreamCode = ReadJsonPath(root, "return_code");
            if (upstreamCode != null && upstreamCode != "0") return "SSO_PROVIDER_UNAVAILABLE";
            // 固定协议文案只用于区分身份信息不可用；其他拒绝均保持登录失败。
            return ReadJsonPath(root, "return_data.message") == "用户不存在或不可用"
                ? "SSO_USER_UNAVAILABLE"
                : "SSO_TOKEN_INVALID";
        }

        var subject = ReadJsonPath(root, $"return_data.{subjectType}");
        return string.IsNullOrWhiteSpace(subject)
            || string.IsNullOrWhiteSpace(NormalizeSubjectValue(subjectType, subject))
                ? "SSO_PROFILE_INCOMPLETE"
                : null;
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

    internal static string BuildAutoUsername(string appCode, string subjectType, string subjectValue)
    {
        var normalized = NormalizeSubjectValue(subjectType, subjectValue);
        var material = $"miduo-planet-auto-user\n{appCode.Trim().ToUpperInvariant()}\n{subjectType}\n{normalized}";
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(material));
        return $"miduo_{Convert.ToHexString(hash).ToLowerInvariant()[..16]}";
    }

    internal static string NormalizeDisplayName(string? displayName, string subjectType, string subjectValue, string username)
    {
        var trimmed = (displayName ?? string.Empty).Trim();
        if (trimmed.Length > 50) return trimmed[..50];
        if (!string.IsNullOrWhiteSpace(trimmed)) return trimmed;

        var masked = MaskSubjectValue(subjectType, subjectValue);
        return string.IsNullOrWhiteSpace(masked) ? username : $"米多用户 {masked}";
    }

    internal static string MaskSubjectValue(string subjectType, string value)
    {
        var normalized = NormalizeSubjectValue(subjectType, value);
        if (subjectType != "mobile") return normalized.Length <= 4 ? normalized : $"{normalized[..2]}***{normalized[^2..]}";
        if (normalized.Length < 7) return normalized;
        return $"{normalized[..3]}****{normalized[^4..]}";
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
        public DateTime? SettingsUpdatedAt { get; set; }
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
