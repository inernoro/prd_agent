using System.IdentityModel.Tokens.Jwt;
using System.Net;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Authentication;

/// <summary>
/// 稳定冒烟专用签名认证。
/// 私钥只存在执行机安全凭据库；服务端仅保存公钥，且只接受合成登录、网关短票据与定向通知端点。
/// </summary>
public sealed class StableSmokeAuthenticationHandler
    : AuthenticationHandler<StableSmokeAuthenticationOptions>
{
    public const string SchemeName = "StableSmokeSignature";
    public const string ClaimTypeIsStableSmokeAccess = "isStableSmokeAccess";
    public const string HeaderKeyId = "X-Stable-Smoke-Key-Id";
    public const string HeaderTimestamp = "X-Stable-Smoke-Timestamp";
    public const string HeaderNonce = "X-Stable-Smoke-Nonce";
    public const string HeaderSignature = "X-Stable-Smoke-Signature";

    private const long MaximumClockSkewSeconds = 120;
    private const long MaximumBodyBytes = 64 * 1024;
    private const string LegacyFixturePrefix = "/api/v1/auth/synthetic/testing/web-pages/";
    private const string LegacyFixtureSuffix = "/legacy-entry";

    private static readonly HashSet<(string Method, string Path)> AllowedRequests = new()
    {
        (HttpMethods.Post, "/api/v1/auth/synthetic/ticket"),
        (HttpMethods.Post, "/api/v1/auth/synthetic/gateway-ticket"),
        (HttpMethods.Post, "/api/dashboard/notifications/events"),
    };

    private readonly IConfiguration _configuration;
    private readonly IUserService _userService;
    private readonly IIdGenerator _idGenerator;
    private readonly IAdminPermissionService _permissionService;
    private readonly MongoDbContext _db;

    public StableSmokeAuthenticationHandler(
        IOptionsMonitor<StableSmokeAuthenticationOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder,
        IConfiguration configuration,
        IUserService userService,
        IIdGenerator idGenerator,
        IAdminPermissionService permissionService,
        MongoDbContext db)
        : base(options, logger, encoder)
    {
        _configuration = configuration;
        _userService = userService;
        _idGenerator = idGenerator;
        _permissionService = permissionService;
        _db = db;
    }

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Headers.TryGetValue(HeaderKeyId, out var keyIdHeader))
            return AuthenticateResult.NoResult();

        var path = Request.Path.Value ?? string.Empty;
        if (!IsAllowedRequest(Request.Method, path))
            return Fail("endpoint_not_allowed");

        var keyId = keyIdHeader.ToString().Trim();
        var matchingKeys = ReadKeys(_configuration)
            .Where(item => string.Equals(item.KeyId, keyId, StringComparison.Ordinal))
            .Take(2)
            .ToList();
        var key = matchingKeys.Count == 1 ? matchingKeys[0] : null;
        if (key is null || !key.IsComplete)
            return Fail("key_not_configured");
        if (!IsAllowedHost(key.AllowedHost, ResolveRequestHost(Request), _configuration))
            return Fail("host_mismatch");

        if (!TryReadSignatureHeaders(Request, out var timestamp, out var nonce, out var signature))
            return Fail("invalid_headers");
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (Math.Abs(now - timestamp) > MaximumClockSkewSeconds)
            return Fail("expired_signature");
        if (Request.ContentLength is > MaximumBodyBytes)
            return Fail("body_too_large");

        // Content-Length 对分块传输可以为空。缓冲层本身必须设置硬上限，避免在验签前
        // 将代理允许的大请求完整写入内存或临时文件。
        Request.EnableBuffering(
            bufferThreshold: 32 * 1024,
            bufferLimit: MaximumBodyBytes);
        string body;
        try
        {
            using var reader = new StreamReader(
                Request.Body,
                Encoding.UTF8,
                detectEncodingFromByteOrderMarks: false,
                leaveOpen: true);
            body = await reader.ReadToEndAsync(Context.RequestAborted);
            Request.Body.Position = 0;
        }
        catch (IOException)
        {
            return Fail("body_too_large");
        }
        if (Encoding.UTF8.GetByteCount(body) > MaximumBodyBytes)
            return Fail("body_too_large");

        var canonical = BuildCanonicalRequest(Request.Method, path, timestamp, nonce, key.Username, body);
        if (!VerifySignature(key.PublicKey, canonical, signature))
            return Fail("invalid_signature");
        if (!await TryConsumeNonceAsync(keyId, nonce, Context.RequestAborted))
            return Fail("replayed_signature");

        var user = await GetOrProvisionUserAsync(key, Context.RequestAborted);
        if (user is null || user.Status != UserStatus.Active || user.UserType != UserType.Human)
            return Fail("account_unavailable");

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.UserId),
            new(JwtRegisteredClaimNames.UniqueName, user.Username),
            new("displayName", user.DisplayName),
            new("role", user.Role.ToString()),
            new("clientType", "stable-smoke"),
            new(ClaimTypeIsStableSmokeAccess, "1"),
            new("stableSmokeKeyId", key.KeyId),
            new("authType", "stable-smoke-signature"),
        };
        var identity = new ClaimsIdentity(claims, Scheme.Name);
        return AuthenticateResult.Success(
            new AuthenticationTicket(new ClaimsPrincipal(identity), Scheme.Name));
    }

    private AuthenticateResult Fail(string reasonCode)
    {
        Logger.LogWarning(
            "Stable smoke signature rejected. reason={ReasonCode}, path={Path}, requestId={RequestId}",
            reasonCode,
            Request.Path.Value,
            Context.TraceIdentifier);
        var publicCode = reasonCode switch
        {
            "key_not_configured" => AuthorizationFailureContract.StableSmokeNotConfigured,
            "expired_signature" or "replayed_signature" => AuthorizationFailureContract.StableSmokeSignatureExpired,
            "invalid_signature" or "host_mismatch" => AuthorizationFailureContract.StableSmokeSignatureInvalid,
            "account_unavailable" => AuthorizationFailureContract.StableSmokeIdentityUnavailable,
            _ => AuthorizationFailureContract.StableSmokeRequestInvalid,
        };
        AuthorizationFailureContract.Set(Context, publicCode);
        return AuthenticateResult.Fail("Stable smoke signature authentication failed");
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties) =>
        AuthorizationFailureContract.WriteChallengeAsync(Context);

    internal static IReadOnlyList<StableSmokePublicKeyOptions> ReadKeys(IConfiguration configuration) =>
        configuration.GetSection("StableSmokeAuthentication:Keys")
            .Get<List<StableSmokePublicKeyOptions>>() ?? new List<StableSmokePublicKeyOptions>();

    internal static bool IsAllowedRequest(string method, string path)
    {
        if (AllowedRequests.Contains((method, path))) return true;
        if (method != HttpMethods.Post && method != HttpMethods.Delete) return false;
        if (!path.StartsWith(LegacyFixturePrefix, StringComparison.Ordinal)
            || !path.EndsWith(LegacyFixtureSuffix, StringComparison.Ordinal))
            return false;

        var siteId = path[LegacyFixturePrefix.Length..^LegacyFixtureSuffix.Length];
        return siteId.Length == 32 && siteId.All(Uri.IsHexDigit);
    }

    internal static bool IsAllowedHost(
        string configuredHost,
        string requestHost,
        IConfiguration configuration)
    {
        var expectedHost = configuredHost.Trim();
        if (string.Equals(expectedHost, "@deployment", StringComparison.Ordinal))
        {
            var deploymentUrl = configuration["CDS_PREVIEW_URL"]
                ?? configuration["PUBLIC_BASE_URL"];
            if (!Uri.TryCreate(deploymentUrl, UriKind.Absolute, out var parsed)) return false;
            expectedHost = parsed.Host;
        }
        return expectedHost.Length > 0
            && string.Equals(requestHost, expectedHost, StringComparison.OrdinalIgnoreCase);
    }

    internal static string ResolveRequestHost(HttpRequest request)
    {
        var peer = request.HttpContext.Connection.RemoteIpAddress;
        if (peer is not null && IsTrustedProxyPeer(peer))
        {
            var forwardedHost = request.Headers["X-Forwarded-Host"].FirstOrDefault();
            var firstHost = forwardedHost?.Split(',')[0].Trim();
            if (!string.IsNullOrWhiteSpace(firstHost)
                && Uri.TryCreate($"https://{firstHost}", UriKind.Absolute, out var parsed))
            {
                return parsed.Host;
            }
        }

        return request.Host.Host;
    }

    private static bool IsTrustedProxyPeer(IPAddress peer)
    {
        if (IPAddress.IsLoopback(peer)) return true;
        if (peer.IsIPv4MappedToIPv6) peer = peer.MapToIPv4();
        if (peer.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var bytes = peer.GetAddressBytes();
            return bytes[0] == 10
                || bytes[0] == 172 && bytes[1] is >= 16 and <= 31
                || bytes[0] == 192 && bytes[1] == 168
                || bytes[0] == 169 && bytes[1] == 254;
        }

        if (peer.IsIPv6LinkLocal || peer.IsIPv6SiteLocal) return true;
        return (peer.GetAddressBytes()[0] & 0xFE) == 0xFC;
    }

    internal static string BuildCanonicalRequest(
        string method,
        string path,
        long timestamp,
        string nonce,
        string username,
        string body)
    {
        var bodyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(body)))
            .ToLowerInvariant();
        return string.Join('\n', method.ToUpperInvariant(), path, timestamp, nonce, username, bodyHash);
    }

    internal static bool VerifySignature(string publicKey, string canonical, byte[] signature)
    {
        try
        {
            using var rsa = RSA.Create();
            rsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(publicKey), out _);
            return rsa.VerifyData(
                Encoding.UTF8.GetBytes(canonical),
                signature,
                HashAlgorithmName.SHA256,
                RSASignaturePadding.Pss);
        }
        catch (FormatException)
        {
            return false;
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    private static bool TryReadSignatureHeaders(
        HttpRequest request,
        out long timestamp,
        out string nonce,
        out byte[] signature)
    {
        timestamp = 0;
        nonce = string.Empty;
        signature = Array.Empty<byte>();
        if (!request.Headers.TryGetValue(HeaderTimestamp, out var timestampHeader)
            || !long.TryParse(timestampHeader.ToString(), out timestamp)
            || !request.Headers.TryGetValue(HeaderNonce, out var nonceHeader)
            || !request.Headers.TryGetValue(HeaderSignature, out var signatureHeader))
            return false;

        nonce = nonceHeader.ToString().Trim();
        if (nonce.Length is < 22 or > 128 || nonce.Any(ch => !(char.IsLetterOrDigit(ch) || ch is '-' or '_')))
            return false;
        try
        {
            signature = Convert.FromBase64String(signatureHeader.ToString().Trim());
            return signature.Length >= 256;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private async Task<bool> TryConsumeNonceAsync(string keyId, string nonce, CancellationToken ct)
    {
        var nonceHash = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes($"{keyId}:{nonce}"))).ToLowerInvariant();
        try
        {
            await _db.ConsoleSsoTickets.InsertOneAsync(new BsonDocument
            {
                { "_id", $"stable-smoke-nonce-{nonceHash}" },
                { "CodeHash", nonceHash },
                { "Purpose", "stable-smoke-request-nonce" },
                { "State", "consumed" },
                { "CreatedAt", DateTime.UtcNow },
                { "ExpiresAt", DateTime.UtcNow.AddMinutes(10) },
            }, cancellationToken: ct);
            return true;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return false;
        }
    }

    private async Task<User?> GetOrProvisionUserAsync(StableSmokePublicKeyOptions key, CancellationToken ct)
    {
        var existing = await _userService.GetByUsernameAsync(key.Username);
        if (existing is not null)
        {
            return key.ManagePermissions ? await ReconcilePermissionsAsync(existing, key, ct) : existing;
        }
        if (!key.AutoProvision) return null;

        var user = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("user"),
            Username = key.Username,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(
                Convert.ToBase64String(RandomNumberGenerator.GetBytes(48))),
            DisplayName = string.IsNullOrWhiteSpace(key.DisplayName) ? "稳定冒烟账号" : key.DisplayName.Trim(),
            Role = UserRole.QA,
            SystemRoleKey = StableSmokeIdentityPolicy.ProvisionedSystemRoleKey,
            // 角色只给 Agent 体验者，矩阵要的管理类权限走显式放行清单：
            // 旧构建也认 PermAllow，同一份共享库里新老部署对这个账号的判断一致。
            PermAllow = key.ManagePermissions ? StableSmokeIdentityPolicy.RequiredPermissions.ToList() : null,
            UserType = UserType.Human,
            Status = UserStatus.Active,
            MustResetPassword = false,
            CreatedAt = DateTime.UtcNow,
        };
        try
        {
            await _db.Users.InsertOneAsync(user, cancellationToken: ct);
            Logger.LogWarning(
                "Stable smoke account provisioned. username={Username}, keyId={KeyId}, permAllow={PermAllow}, requestId={RequestId}",
                user.Username,
                key.KeyId,
                string.Join(",", user.PermAllow ?? new List<string>()),
                Context.TraceIdentifier);
            return user;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return await _userService.GetByUsernameAsync(key.Username);
        }
    }

    /// <summary>
    /// 存量巡检账号补齐矩阵权限。
    ///
    /// 2026-09-14 的事故：<c>stsmk_cds</c> 在 09-01 由本处理器自动开号，拿到的只有「Agent 体验者」角色，
    /// 没有文档空间与用户管理权限，48 小时巡检里录音、文件、短视频、会话权限四个模块 30 余项
    /// 全部在业务动作之前被权限中间件挡成「无权限」，报告只看到现象看不到外因。
    /// 这里在每次签名认证通过后按 <see cref="StableSmokeIdentityPolicy"/> 核对一次，缺什么补什么，
    /// 只加不减：显式放行进 <c>PermAllow</c>，被拒绝清单里的同名项一并移出，并把补齐动作写进日志。
    /// 签名身份本来就能为这个账号签发登录票据，把它的权限对齐到配置声明的契约不是越权，
    /// 而是让「配置说它能跑矩阵」与「库里它真能跑矩阵」重新成为同一件事。
    /// </summary>
    private async Task<User> ReconcilePermissionsAsync(User user, StableSmokePublicKeyOptions key, CancellationToken ct)
    {
        var effective = await _permissionService.GetEffectivePermissionsAsync(user.UserId, isRoot: false, ct);
        var missing = StableSmokeIdentityPolicy.MissingPermissions(effective);
        if (missing.Count == 0) return user;

        // 只做原子增删，不整表覆盖：管理员同时改了别的放行 / 拒绝项时，整表 Set 会把那次修改静默吞掉。
        // 更新定义见 StableSmokePermissionReconcileUpdate：存量账号这两个字段常是 BSON null，
        // $addToSet / $pullAll 会直接报错，必须走对 null 安全的管道更新。
        await _db.Users.UpdateOneAsync(
            Builders<User>.Filter.Eq(item => item.UserId, user.UserId),
            StableSmokePermissionReconcileUpdate.Build(missing, StableSmokeIdentityPolicy.RequiredPermissions),
            cancellationToken: ct);
        var allow = new List<string>(user.PermAllow ?? new List<string>());
        foreach (var permission in missing)
        {
            if (!allow.Contains(permission, StringComparer.Ordinal)) allow.Add(permission);
        }
        user.PermAllow = allow;
        user.PermDeny = (user.PermDeny ?? new List<string>())
            .Where(item => !StableSmokeIdentityPolicy.RequiredPermissions.Contains(item, StringComparer.Ordinal))
            .ToList();

        Logger.LogWarning(
            "稳定冒烟账号 {Username} 缺少巡检矩阵所需权限，已按 StableSmokeIdentityPolicy 补齐：{Missing}。"
            + "外因：账号由签名认证自动开号时只带 Agent 体验者角色；keyId={KeyId}, requestId={RequestId}",
            user.Username,
            string.Join(",", missing),
            key.KeyId,
            Context.TraceIdentifier);
        return user;
    }
}

public sealed class StableSmokeAuthenticationOptions : AuthenticationSchemeOptions;

public sealed class StableSmokePublicKeyOptions
{
    public string KeyId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string AllowedHost { get; set; } = string.Empty;
    public string PublicKey { get; set; } = string.Empty;
    public bool AutoProvision { get; set; }

    /// <summary>
    /// 是否由平台按 <see cref="PrdAgent.Core.Security.StableSmokeIdentityPolicy"/> 托管该账号的权限：
    /// 开号时写入显式放行清单，存量账号缺项时补齐。默认开启；只读环境（如正式环境只给只读巡检）
    /// 在配置里显式置为 false，此时账号权限完全由管理员手工决定。
    /// </summary>
    public bool ManagePermissions { get; set; } = true;

    public bool IsComplete =>
        !string.IsNullOrWhiteSpace(KeyId)
        && !string.IsNullOrWhiteSpace(Username)
        && !string.IsNullOrWhiteSpace(AllowedHost)
        && !string.IsNullOrWhiteSpace(PublicKey);
}
