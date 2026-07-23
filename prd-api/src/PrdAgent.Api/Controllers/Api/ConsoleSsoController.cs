using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 当前管理系统作为通用真人身份入口，为外部控制台签发 60 秒、单次消费的登录票据。
/// 消费方只依赖票据协议，不需要知道具体身份平台。
/// </summary>
[ApiController]
[Route("api/console-sso")]
public sealed class ConsoleSsoController : ControllerBase
{
    private static readonly TimeSpan TicketLifetime = TimeSpan.FromSeconds(60);
    private const string TicketCollectionName = "console_sso_tickets";
    private const string TicketPurpose = "external-console-login";
    private readonly MongoDbContext _db;
    private readonly IConfiguration _configuration;

    public ConsoleSsoController(MongoDbContext db, IConfiguration configuration)
    {
        _db = db;
        _configuration = configuration;
    }

    [HttpGet("authorize")]
    [Authorize]
    public async Task<IActionResult> Authorize(
        [FromQuery(Name = "client_id")] string? clientId,
        [FromQuery(Name = "redirect_uri")] string? redirectUri,
        [FromQuery] string? state,
        CancellationToken ct)
    {
        var config = await ReadConfigAsync(ct);
        if (!config.Enabled)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, "SSO 提供方尚未启用");
        }
        if (!FixedEquals(clientId, config.ClientId)
            || !TryValidateRedirect(redirectUri, config.AllowedRedirectOrigins, out var callback)
            || string.IsNullOrWhiteSpace(state)
            || state.Length is < 32 or > 256)
        {
            return BadRequest("SSO 授权请求无效");
        }

        var identity = await ResolveAdminIdentityAsync(ct);
        if (identity is null)
        {
            return StatusCode(StatusCodes.Status403Forbidden, "只有管理员可以进入外部控制台");
        }

        var now = DateTime.UtcNow;
        var code = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        var tickets = _db.Database.GetCollection<BsonDocument>(TicketCollectionName);
        await tickets.InsertOneAsync(new BsonDocument
        {
            { "_id", Guid.NewGuid().ToString("N") },
            { "CodeHash", Hash(code) },
            { "Purpose", TicketPurpose },
            { "ClientId", config.ClientId },
            { "RedirectUri", callback },
            { "Subject", identity.Value.Subject },
            { "Username", identity.Value.Username },
            { "DisplayName", identity.Value.DisplayName },
            { "Email", identity.Value.Email is null ? BsonNull.Value : identity.Value.Email },
            { "State", "issued" },
            { "CreatedAt", now },
            { "ExpiresAt", now.Add(TicketLifetime) },
            { "ConsumedAt", BsonNull.Value },
        }, cancellationToken: ct);

        var target = $"{callback}#code={Uri.EscapeDataString(code)}&state={Uri.EscapeDataString(state)}";
        return Redirect(target);
    }

    [HttpPost("token")]
    [AllowAnonymous]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status401Unauthorized)]
    public async Task<IActionResult> Token([FromBody] ConsoleSsoTokenRequest request, CancellationToken ct)
    {
        var config = await ReadConfigAsync(ct);
        if (!config.Enabled
            || !FixedEquals(request.ClientId, config.ClientId)
            || !FixedEquals(request.ClientSecret, config.ClientSecret)
            || !string.Equals(request.GrantType, "urn:cds:params:oauth:grant-type:ticket", StringComparison.Ordinal)
            || !TryValidateRedirect(request.RedirectUri, config.AllowedRedirectOrigins, out var callback)
            || string.IsNullOrWhiteSpace(request.Code)
            || request.Code.Length is < 32 or > 256)
        {
            return Unauthorized(ApiResponse<object>.Fail("SSO_CLIENT_INVALID", "SSO 客户端或一次性票据无效"));
        }

        var now = DateTime.UtcNow;
        var tickets = _db.Database.GetCollection<BsonDocument>(TicketCollectionName);
        var ticket = await tickets.FindOneAndUpdateAsync(
            Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("CodeHash", Hash(request.Code)),
                Builders<BsonDocument>.Filter.Eq("Purpose", TicketPurpose),
                Builders<BsonDocument>.Filter.Eq("ClientId", config.ClientId),
                Builders<BsonDocument>.Filter.Eq("RedirectUri", callback),
                Builders<BsonDocument>.Filter.Eq("State", "issued"),
                Builders<BsonDocument>.Filter.Gt("ExpiresAt", now)),
            Builders<BsonDocument>.Update
                .Set("State", "consumed")
                .Set("ConsumedAt", now),
            new FindOneAndUpdateOptions<BsonDocument, BsonDocument> { ReturnDocument = ReturnDocument.After },
            ct);
        if (ticket is null)
        {
            return Unauthorized(ApiResponse<object>.Fail("SSO_TICKET_INVALID", "一次性票据无效、已使用或已过期"));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            subject = ticket.GetValue("Subject", "").AsString,
            username = ticket.GetValue("Username", "").AsString,
            displayName = ticket.GetValue("DisplayName", "").AsString,
            email = ticket.TryGetValue("Email", out var email) && email.IsString ? email.AsString : null,
        }));
    }

    private async Task<(string Subject, string Username, string DisplayName, string? Email)?> ResolveAdminIdentityAsync(
        CancellationToken ct)
    {
        var clientType = User.FindFirst("clientType")?.Value;
        var sessionKey = User.FindFirst("sessionKey")?.Value;
        if (!string.Equals(clientType, "admin", StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(sessionKey))
        {
            return null;
        }

        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);
        if (isRoot) return ("admin:root", "root", "ROOT", null);

        var userId = this.GetRequiredUserId();
        var user = await _db.Users.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        if (user is null
            || user.Status != UserStatus.Active
            || user.UserType != UserType.Human
            || user.Role != UserRole.ADMIN)
        {
            return null;
        }
        return ($"admin:{user.UserId}", user.Username, user.DisplayName, user.Email);
    }

    private async Task<ProviderConfig> ReadConfigAsync(CancellationToken ct)
    {
        var settings = await _db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync(ct);
        var enabled = settings?.ConsoleSsoProviderEnabled
            ?? IsTruthy(_configuration["ConsoleSso:Enabled"] ?? _configuration["CONSOLE_SSO_ENABLED"]);
        var clientId = FirstNonEmpty(
            settings?.ConsoleSsoClientId,
            _configuration["ConsoleSso:ClientId"],
            _configuration["CONSOLE_SSO_CLIENT_ID"]);
        var clientSecret = FirstNonEmpty(
            settings?.ConsoleSsoClientSecret,
            _configuration["ConsoleSso:ClientSecret"],
            _configuration["CONSOLE_SSO_CLIENT_SECRET"]);
        var origins = FirstNonEmpty(
            settings?.ConsoleSsoAllowedRedirectOrigins,
            _configuration["ConsoleSso:AllowedRedirectOrigins"],
            _configuration["CONSOLE_SSO_ALLOWED_REDIRECT_ORIGINS"]);
        return new ProviderConfig(
            enabled && !string.IsNullOrWhiteSpace(clientId) && !string.IsNullOrWhiteSpace(clientSecret),
            clientId ?? "",
            clientSecret ?? "",
            ParseOrigins(origins));
    }

    private static bool TryValidateRedirect(string? raw, IReadOnlyList<string> allowedOrigins, out string callback)
    {
        callback = "";
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || !string.Equals(uri.AbsolutePath.TrimEnd('/'), "/auth/sso", StringComparison.Ordinal)
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment))
        {
            return false;
        }
        var origin = uri.GetLeftPart(UriPartial.Authority).TrimEnd('/');
        var allowed = allowedOrigins.Any(pattern =>
        {
            if (pattern.StartsWith("*.", StringComparison.Ordinal))
            {
                var suffix = pattern[1..];
                return uri.Host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)
                    && uri.Host.Length > suffix.Length;
            }
            return string.Equals(origin, pattern, StringComparison.OrdinalIgnoreCase);
        });
        if (!allowed) return false;
        callback = $"{origin}/auth/sso";
        return true;
    }

    private static IReadOnlyList<string> ParseOrigins(string? raw) =>
        (raw ?? "")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(value => value.StartsWith("*.", StringComparison.Ordinal)
                ? value.ToLowerInvariant()
                : Uri.TryCreate(value, UriKind.Absolute, out var uri)
                    ? uri.GetLeftPart(UriPartial.Authority).TrimEnd('/')
                    : "")
            .Where(value => value.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

    private static bool FixedEquals(string? left, string? right)
    {
        var a = Encoding.UTF8.GetBytes(left ?? "");
        var b = Encoding.UTF8.GetBytes(right ?? "");
        return a.Length == b.Length && CryptographicOperations.FixedTimeEquals(a, b);
    }

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value))?.Trim();

    private static bool IsTruthy(string? value) =>
        value is not null && value.Trim().ToLowerInvariant() is "1" or "true" or "yes" or "on";

    private sealed record ProviderConfig(
        bool Enabled,
        string ClientId,
        string ClientSecret,
        IReadOnlyList<string> AllowedRedirectOrigins);
}

public sealed class ConsoleSsoTokenRequest
{
    [System.Text.Json.Serialization.JsonPropertyName("grant_type")]
    public string GrantType { get; set; } = "";

    [System.Text.Json.Serialization.JsonPropertyName("code")]
    public string Code { get; set; } = "";

    [System.Text.Json.Serialization.JsonPropertyName("client_id")]
    public string ClientId { get; set; } = "";

    [System.Text.Json.Serialization.JsonPropertyName("client_secret")]
    public string ClientSecret { get; set; } = "";

    [System.Text.Json.Serialization.JsonPropertyName("redirect_uri")]
    public string RedirectUri { get; set; } = "";
}
