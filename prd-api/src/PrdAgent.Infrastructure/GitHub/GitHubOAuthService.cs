using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace PrdAgent.Infrastructure.GitHub;

/// <summary>
/// GitHub OAuth Device Flow（RFC 8628）封装 —— <see cref="IGitHubOAuthService"/> 的默认实现。
///
/// 为什么用 Device Flow 而不是 Web Flow：
///   本项目前后端部署在动态域名（CDS 预览环境，每条分支一个域名）。
///   Web Flow 要求在 GitHub OAuth App 中预先注册 Callback URL，不支持通配符，
///   而 CDS 每条分支域名都不一样，无法预注册。
///   Device Flow 完全不需要 Callback URL，本地/CDS/生产共用一套代码，
///   是为 CLI/动态环境量身定制的 OAuth 变体（GitHub CLI `gh auth login` 正是用它）。
///
/// 流程（RFC 8628 §3）：
///   1. Start：后端 POST github.com/login/device/code?client_id=&amp;scope=repo,read:user
///      → 得到 device_code (保密，不给前端看) + user_code (给用户看) + verification_uri
///      → 后端签名 device_code + userId 成 flow_token 回传前端
///   2. 前端显示 user_code，引导用户在新 tab 打开 verification_uri 粘贴授权
///   3. Poll：后端每 N 秒 POST github.com/login/oauth/access_token (grant_type=device_code)
///      → authorization_pending → 继续轮询
///      → slow_down → 调大轮询间隔
///      → access_denied / expired_token → 失败
///      → success → 拿到 access_token，存库
///
/// 安全：flow_token 用 HMAC(Jwt:Secret) 签名，绑定发起用户，多实例部署无需共享 session。
///       device_code 永远不出后端，前端只看到无状态的 flow_token。
/// </summary>
public sealed class GitHubOAuthService : IGitHubOAuthService
{
    private const string DeviceCodeUrl = "https://github.com/login/device/code";
    private const string TokenUrl = "https://github.com/login/oauth/access_token";
    private const string VerificationUriDefault = "https://github.com/login/device";
    private const string UserInfoUrl = "https://api.github.com/user";
    private const string DefaultScopes = "repo,read:user";
    private const int FlowTokenTtlSeconds = 900;

    private readonly IConfiguration _config;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<GitHubOAuthService> _logger;

    public GitHubOAuthService(
        IConfiguration config,
        IHttpClientFactory httpClientFactory,
        ILogger<GitHubOAuthService> logger)
    {
        _config = config;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    /// <summary>
    /// 向 GitHub 请求 device code。
    /// 返回给前端的 flow_token 是签名后的 (device_code, userId, expiry) 三元组，
    /// 前端在 poll 时原样回传，后端验签后解出 device_code 继续和 GitHub 交互。
    /// </summary>
    public async Task<DeviceFlowStartResult> StartDeviceFlowAsync(string userId, CancellationToken ct)
    {
        var clientId = _config["GitHubOAuth:ClientId"];
        if (string.IsNullOrWhiteSpace(clientId))
        {
            throw GitHubException.OAuthNotConfigured();
        }

        var scopes = _config["GitHubOAuth:Scopes"] ?? DefaultScopes;
        var client = _httpClientFactory.CreateClient("GitHubApi");
        using var req = new HttpRequestMessage(HttpMethod.Post, DeviceCodeUrl);
        req.Headers.Accept.Clear();
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        req.Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = clientId!,
            ["scope"] = scopes,
        });

        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            var body = await SafeReadBodyAsync(resp, ct);
            _logger.LogWarning("PrReview device_code request failed: HTTP {Status} body={Body}", (int)resp.StatusCode, body);
            throw GitHubException.DeviceFlowRequestFailed($"HTTP {(int)resp.StatusCode}");
        }

        var dto = await resp.Content.ReadFromJsonAsync<GitHubDeviceCodeResponse>(cancellationToken: ct);
        if (dto == null || string.IsNullOrWhiteSpace(dto.DeviceCode) || string.IsNullOrWhiteSpace(dto.UserCode))
        {
            throw GitHubException.DeviceFlowRequestFailed("empty device_code response");
        }

        var expiryUnix = DateTimeOffset.UtcNow.AddSeconds(Math.Min(dto.ExpiresIn, FlowTokenTtlSeconds)).ToUnixTimeSeconds();
        var flowToken = EncodeFlowToken(dto.DeviceCode!, userId, expiryUnix);

        // 构造一个便捷地址，让用户点开后在 GitHub 页面直接 paste 授权码。
        var verificationUri = string.IsNullOrWhiteSpace(dto.VerificationUri) ? VerificationUriDefault : dto.VerificationUri!;
        var verificationUriComplete = $"{verificationUri}?user_code={Uri.EscapeDataString(dto.UserCode!)}";

        return new DeviceFlowStartResult(
            UserCode: dto.UserCode!,
            VerificationUri: verificationUri,
            VerificationUriComplete: verificationUriComplete,
            IntervalSeconds: Math.Max(1, dto.Interval),
            ExpiresInSeconds: dto.ExpiresIn,
            FlowToken: flowToken);
    }

    /// <summary>
    /// 验证 flow_token 并向 GitHub 轮询一次。返回规范化的结果枚举：
    /// Pending（继续轮询） / SlowDown（调大间隔） / Expired / Denied / Done(token)
    /// </summary>
    public async Task<DeviceFlowPollResult> PollDeviceFlowAsync(
        string userId,
        string flowToken,
        CancellationToken ct)
    {
        if (!TryDecodeFlowToken(flowToken, out var deviceCode, out var tokenUserId, out var expiryUnix))
        {
            throw GitHubException.DeviceFlowTokenInvalid();
        }
        if (!string.Equals(tokenUserId, userId, StringComparison.Ordinal))
        {
            throw GitHubException.DeviceFlowTokenInvalid();
        }
        if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() > expiryUnix)
        {
            return DeviceFlowPollResult.Expired();
        }

        var clientId = _config["GitHubOAuth:ClientId"];
        var clientSecret = _config["GitHubOAuth:ClientSecret"];
        if (string.IsNullOrWhiteSpace(clientId))
        {
            throw GitHubException.OAuthNotConfigured();
        }

        var client = _httpClientFactory.CreateClient("GitHubApi");
        using var req = new HttpRequestMessage(HttpMethod.Post, TokenUrl);
        req.Headers.Accept.Clear();
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        // Device Flow 的 client_secret 对"公有客户端"可选。私有 OAuth App 可以带；
        // 带了更严格，不带也能通过（GitHub 官方文档声明 client_secret 不强制）。
        var form = new Dictionary<string, string>
        {
            ["client_id"] = clientId!,
            ["device_code"] = deviceCode,
            ["grant_type"] = "urn:ietf:params:oauth:grant-type:device_code",
        };
        if (!string.IsNullOrWhiteSpace(clientSecret))
        {
            form["client_secret"] = clientSecret!;
        }
        req.Content = new FormUrlEncodedContent(form);

        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            var body = await SafeReadBodyAsync(resp, ct);
            _logger.LogWarning("PrReview device poll failed: HTTP {Status} body={Body}", (int)resp.StatusCode, body);
            throw GitHubException.DeviceFlowRequestFailed($"HTTP {(int)resp.StatusCode}");
        }

        var dto = await resp.Content.ReadFromJsonAsync<GitHubAccessTokenResponse>(cancellationToken: ct);
        if (dto == null)
        {
            throw GitHubException.DeviceFlowRequestFailed("empty poll response");
        }

        // GitHub 在 Device Flow 轮询里用 error 字段表达"还没授权"等状态，
        // 这些不是真正的失败——继续轮询即可。
        if (!string.IsNullOrWhiteSpace(dto.Error))
        {
            return dto.Error switch
            {
                "authorization_pending" => DeviceFlowPollResult.Pending(),
                "slow_down" => DeviceFlowPollResult.SlowDown(),
                "expired_token" => DeviceFlowPollResult.Expired(),
                "access_denied" => DeviceFlowPollResult.Denied(),
                _ => throw GitHubException.DeviceFlowRequestFailed(dto.Error!)
            };
        }

        if (string.IsNullOrWhiteSpace(dto.AccessToken))
        {
            return DeviceFlowPollResult.Pending();
        }

        return DeviceFlowPollResult.Done(dto.AccessToken!, dto.Scope ?? string.Empty);
    }

    /// <summary>
    /// 用 access_token 拉取当前 GitHub 用户信息（login / id / avatar）。
    /// </summary>
    public async Task<GitHubUserInfo> FetchUserInfoAsync(string accessToken, CancellationToken ct)
    {
        var client = _httpClientFactory.CreateClient("GitHubApi");
        using var req = new HttpRequestMessage(HttpMethod.Get, UserInfoUrl);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            throw GitHubException.DeviceFlowRequestFailed($"GET /user HTTP {(int)resp.StatusCode}");
        }

        var info = await resp.Content.ReadFromJsonAsync<GitHubUserInfo>(cancellationToken: ct);
        if (info == null || string.IsNullOrWhiteSpace(info.Login))
        {
            throw GitHubException.DeviceFlowRequestFailed("empty user info");
        }

        return info;
    }

    // ===== Flow token helpers =====

    private string EncodeFlowToken(string deviceCode, string userId, long expiryUnix)
    {
        var payload = $"{deviceCode}|{userId}|{expiryUnix}";
        var sig = ComputeHmac(payload);
        var full = $"{payload}|{sig}";
        return Base64UrlEncode(Encoding.UTF8.GetBytes(full));
    }

    private bool TryDecodeFlowToken(string flowToken, out string deviceCode, out string userId, out long expiryUnix)
    {
        deviceCode = string.Empty;
        userId = string.Empty;
        expiryUnix = 0;

        if (string.IsNullOrWhiteSpace(flowToken)) return false;

        try
        {
            var raw = Encoding.UTF8.GetString(Base64UrlDecode(flowToken));
            var parts = raw.Split('|');
            if (parts.Length != 4) return false;

            var dc = parts[0];
            var uid = parts[1];
            var expStr = parts[2];
            var sig = parts[3];

            if (!long.TryParse(expStr, out var exp)) return false;

            var expected = ComputeHmac($"{dc}|{uid}|{expStr}");
            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.UTF8.GetBytes(sig),
                    Encoding.UTF8.GetBytes(expected)))
            {
                return false;
            }

            deviceCode = dc;
            userId = uid;
            expiryUnix = exp;
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PrReview device flow token decode failed");
            return false;
        }
    }

    private string ComputeHmac(string payload)
    {
        var secret = _config["Jwt:Secret"]
            ?? throw new InvalidOperationException("Jwt:Secret not configured — required for PR Review device flow token signing");
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(payload));
        return Convert.ToHexString(hash);
    }

    private static string Base64UrlEncode(byte[] bytes)
    {
        return Convert.ToBase64String(bytes)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        var mod = padded.Length % 4;
        if (mod > 0)
        {
            padded += new string('=', 4 - mod);
        }
        return Convert.FromBase64String(padded);
    }

    private static async Task<string> SafeReadBodyAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        try
        {
            var body = await resp.Content.ReadAsStringAsync(ct);
            return body.Length > 500 ? body[..500] : body;
        }
        catch
        {
            return "(unreadable)";
        }
    }
}

// ===== Public result types =====

public sealed record DeviceFlowStartResult(
    string UserCode,
    string VerificationUri,
    string VerificationUriComplete,
    int IntervalSeconds,
    int ExpiresInSeconds,
    string FlowToken);

public enum DeviceFlowPollStatus
{
    Pending,
    SlowDown,
    Expired,
    Denied,
    Done,
}

public sealed class DeviceFlowPollResult
{
    public DeviceFlowPollStatus Status { get; private init; }
    public string? AccessToken { get; private init; }
    public string? Scope { get; private init; }

    public static DeviceFlowPollResult Pending() => new() { Status = DeviceFlowPollStatus.Pending };
    public static DeviceFlowPollResult SlowDown() => new() { Status = DeviceFlowPollStatus.SlowDown };
    public static DeviceFlowPollResult Expired() => new() { Status = DeviceFlowPollStatus.Expired };
    public static DeviceFlowPollResult Denied() => new() { Status = DeviceFlowPollStatus.Denied };
    public static DeviceFlowPollResult Done(string accessToken, string scope) =>
        new() { Status = DeviceFlowPollStatus.Done, AccessToken = accessToken, Scope = scope };
}

// ===== GitHub API DTOs =====

internal sealed class GitHubDeviceCodeResponse
{
    [JsonPropertyName("device_code")] public string? DeviceCode { get; set; }
    [JsonPropertyName("user_code")] public string? UserCode { get; set; }
    [JsonPropertyName("verification_uri")] public string? VerificationUri { get; set; }
    [JsonPropertyName("expires_in")] public int ExpiresIn { get; set; }
    [JsonPropertyName("interval")] public int Interval { get; set; }
}

internal sealed class GitHubAccessTokenResponse
{
    [JsonPropertyName("access_token")] public string? AccessToken { get; set; }
    [JsonPropertyName("token_type")] public string? TokenType { get; set; }
    [JsonPropertyName("scope")] public string? Scope { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("error_description")] public string? ErrorDescription { get; set; }
}

public sealed class GitHubUserInfo
{
    [JsonPropertyName("login")] public string Login { get; set; } = string.Empty;
    [JsonPropertyName("id")] public long Id { get; set; }
    [JsonPropertyName("avatar_url")] public string? AvatarUrl { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
}
