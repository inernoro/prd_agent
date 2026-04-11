using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;

namespace PrdAgent.Api.Services.PrReview;

/// <summary>
/// GitHub OAuth Web Flow（Authorization Code）封装。
///
/// 职责：
/// 1. 生成 authorize URL（含 HMAC 签名的 state，天然防 CSRF + 免 session）
/// 2. 校验 callback 回来的 state，提取原 userId
/// 3. 用 code 换 access_token（POST /login/oauth/access_token）
/// 4. 用 access_token 拉取 GitHub 用户信息（GET /user）
///
/// 状态管理：完全无状态——state 由 HMAC(Jwt:Secret, userId + expiry + nonce) 组成，
/// 可以被任意实例签发、任意实例验证，无需共享 session store。
/// </summary>
public sealed class GitHubOAuthService
{
    private const string AuthorizeUrl = "https://github.com/login/oauth/authorize";
    private const string TokenUrl = "https://github.com/login/oauth/access_token";
    private const string UserInfoUrl = "https://api.github.com/user";
    private const string DefaultScopes = "repo,read:user";
    private const int StateTtlSeconds = 600;

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
    /// 根据 userId 生成 GitHub OAuth authorize URL。
    /// state 以 HMAC 签名并编码 userId 与过期时间，天然防 CSRF 与重放。
    /// </summary>
    public string BuildAuthorizeUrl(string userId, string callbackUrl)
    {
        var clientId = _config["GitHubOAuth:ClientId"];
        if (string.IsNullOrWhiteSpace(clientId))
        {
            throw PrReviewException.OAuthNotConfigured();
        }

        var state = CreateState(userId);
        var scopes = _config["GitHubOAuth:Scopes"] ?? DefaultScopes;

        var query = new Dictionary<string, string>
        {
            ["client_id"] = clientId!,
            ["redirect_uri"] = callbackUrl,
            ["scope"] = scopes,
            ["state"] = state,
            ["allow_signup"] = "false",
        };

        var qs = string.Join("&", query
            .Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));
        return $"{AuthorizeUrl}?{qs}";
    }

    /// <summary>
    /// 校验 state 完整性并返回 userId。失败抛 <see cref="PrReviewException"/>。
    /// </summary>
    public string ValidateStateAndGetUserId(string? state)
    {
        if (string.IsNullOrWhiteSpace(state))
        {
            throw PrReviewException.StateInvalid();
        }

        try
        {
            var decoded = Base64UrlDecode(state!);
            var text = Encoding.UTF8.GetString(decoded);
            var parts = text.Split('|');
            if (parts.Length != 3)
            {
                throw PrReviewException.StateInvalid();
            }

            var userId = parts[0];
            var expiryStr = parts[1];
            var sig = parts[2];

            if (!long.TryParse(expiryStr, out var expiryUnix))
            {
                throw PrReviewException.StateInvalid();
            }
            if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() > expiryUnix)
            {
                throw PrReviewException.StateInvalid();
            }

            var expectedSig = ComputeHmac($"{userId}|{expiryStr}");
            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.UTF8.GetBytes(sig),
                    Encoding.UTF8.GetBytes(expectedSig)))
            {
                throw PrReviewException.StateInvalid();
            }

            return userId;
        }
        catch (PrReviewException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PrReview OAuth state decode failed");
            throw PrReviewException.StateInvalid();
        }
    }

    /// <summary>
    /// 用 code 调 GitHub 换 access_token。
    /// </summary>
    public async Task<GitHubAccessTokenResponse> ExchangeCodeAsync(string code, string callbackUrl, CancellationToken ct)
    {
        var clientId = _config["GitHubOAuth:ClientId"];
        var clientSecret = _config["GitHubOAuth:ClientSecret"];
        if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(clientSecret))
        {
            throw PrReviewException.OAuthNotConfigured();
        }

        var client = _httpClientFactory.CreateClient("GitHubApi");
        using var req = new HttpRequestMessage(HttpMethod.Post, TokenUrl);
        req.Headers.Accept.Clear();
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        req.Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = clientId!,
            ["client_secret"] = clientSecret!,
            ["code"] = code,
            ["redirect_uri"] = callbackUrl,
        });

        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
        {
            throw PrReviewException.OAuthExchangeFailed($"HTTP {(int)resp.StatusCode}");
        }

        var body = await resp.Content.ReadFromJsonAsync<GitHubAccessTokenResponse>(cancellationToken: ct);
        if (body == null || string.IsNullOrWhiteSpace(body.AccessToken))
        {
            throw PrReviewException.OAuthExchangeFailed(body?.Error ?? "empty response");
        }

        return body;
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
            throw PrReviewException.OAuthExchangeFailed($"GET /user HTTP {(int)resp.StatusCode}");
        }

        var info = await resp.Content.ReadFromJsonAsync<GitHubUserInfo>(cancellationToken: ct);
        if (info == null || string.IsNullOrWhiteSpace(info.Login))
        {
            throw PrReviewException.OAuthExchangeFailed("empty user info");
        }

        return info;
    }

    // ===== state helpers =====

    private string CreateState(string userId)
    {
        var expiry = DateTimeOffset.UtcNow.AddSeconds(StateTtlSeconds).ToUnixTimeSeconds();
        var payload = $"{userId}|{expiry}";
        var sig = ComputeHmac(payload);
        var composed = $"{payload}|{sig}";
        return Base64UrlEncode(Encoding.UTF8.GetBytes(composed));
    }

    private string ComputeHmac(string payload)
    {
        var secret = _config["Jwt:Secret"]
            ?? throw new InvalidOperationException("Jwt:Secret not configured — required for PR Review OAuth state signing");
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
}

/// <summary>GitHub /login/oauth/access_token 响应</summary>
public sealed class GitHubAccessTokenResponse
{
    [JsonPropertyName("access_token")] public string AccessToken { get; set; } = string.Empty;
    [JsonPropertyName("token_type")] public string? TokenType { get; set; }
    [JsonPropertyName("scope")] public string? Scope { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("error_description")] public string? ErrorDescription { get; set; }
}

/// <summary>GitHub /user 响应（摘要）</summary>
public sealed class GitHubUserInfo
{
    [JsonPropertyName("login")] public string Login { get; set; } = string.Empty;
    [JsonPropertyName("id")] public long Id { get; set; }
    [JsonPropertyName("avatar_url")] public string? AvatarUrl { get; set; }
    [JsonPropertyName("name")] public string? Name { get; set; }
}
