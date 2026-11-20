using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.IdentityModel.Tokens;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;

namespace PrdAgent.Api.Controllers;

[ApiController]
[AllowAnonymous]
[ResponseCache(Location = ResponseCacheLocation.None, NoStore = true)]
[Route(CdsSsoSettings.AuthPath)]
public sealed class CdsSsoController(
    CdsSsoSettings settings, CdsSsoClient client, CdsSsoSessions sessions, IDataProtectionProvider protection,
    IUserService users, IJwtService jwt, IAuthSessionService localSessions, IConfiguration config,
    ILogger<CdsSsoController> logger) : ControllerBase
{
    private const string FlowCookie = "__Host-map-cds-flow";
    private const string ReadyCookie = "__Host-map-cds-ready";
    private static readonly TimeSpan FlowLifetime = TimeSpan.FromMinutes(5);
    private readonly ITimeLimitedDataProtector _flowProtector = protection.CreateProtector("MAP.CdsSso.Flow.v1", settings.Scope).ToTimeLimitedDataProtector();

    [HttpGet("start")]
    public async Task<IActionResult> Start(string? returnUrl, bool switchAccount, CancellationToken ct)
    {
        if (!settings.IsForHost(Request.Host)) return NotFound();
        Response.Headers["Referrer-Policy"] = "no-referrer";
        var local = SafeReturnUrl(returnUrl);
        var flow = new CdsSsoFlow(RandomProof(), RandomProof(), RandomProof(), RandomProof(), local);
        try
        {
            var authorizeUrl = await client.AuthorizationUrlAsync(flow, switchAccount, ct);
            Response.Cookies.Delete(ReadyCookie, Cookie());
            Response.Cookies.Append(FlowCookie, _flowProtector.Protect(JsonSerializer.Serialize(flow), FlowLifetime), Cookie(FlowLifetime));
            return Redirect(authorizeUrl);
        }
        catch (Exception ex) when (IsUpstreamFailure(ex, ct))
        {
            logger.LogWarning("CDS SSO authorization unavailable ({Reason})", ex.GetBaseException().GetType().Name);
            return Back("unavailable", local);
        }
    }

    [HttpGet("callback")]
    public async Task<IActionResult> Callback(string? state, string? code, string? error, CancellationToken ct)
    {
        if (!settings.IsForHost(Request.Host)) return NotFound();
        Response.Headers["Referrer-Policy"] = "no-referrer";
        var flow = ReadFlow();
        if (flow is null || flow.State != state) return Back("expired", "/");

        Response.Cookies.Delete(FlowCookie, Cookie());
        if (error == "access_denied") return Back("cancelled", flow.ReturnUrl);
        if (error is not null || string.IsNullOrEmpty(code) || code.Length > 4096) return Back("denied", flow.ReturnUrl);

        try
        {
            var delegation = await client.RedeemAsync(code, flow, ct);
            if (delegation is null || await sessions.FindLoginUserAsync(delegation.LocalAccount, ct) is null)
            {
                logger.LogInformation("CDS SSO denied because the authorization or MAP account is invalid");
                return Back("denied", flow.ReturnUrl);
            }

            if (!await sessions.AddAsync(CdsSsoSessions.SessionKey(flow.SessionProof), delegation, ct))
                return Back("expired", flow.ReturnUrl);

            Response.Cookies.Append(ReadyCookie, flow.SessionProof, Cookie(CdsSsoSessions.RedeemLifetime));
            return Back("complete", flow.ReturnUrl);
        }
        catch (SecurityTokenException)
        {
            logger.LogWarning("CDS SSO rejected an invalid ID token");
            return Back("denied", flow.ReturnUrl);
        }
        catch (Exception ex) when (IsUpstreamFailure(ex, ct))
        {
            logger.LogWarning("CDS SSO callback unavailable ({Reason})", ex.GetBaseException().GetType().Name);
            return Back("unavailable", flow.ReturnUrl);
        }
    }

    [HttpPost("complete")]
    public async Task<IActionResult> Complete(CancellationToken ct)
    {
        if (!settings.IsForHost(Request.Host)) return NotFound();
        if (Request.Headers.Origin.ToString() != settings.RedirectUri!.GetLeftPart(UriPartial.Authority)) return Forbid();

        if (!Request.Cookies.TryGetValue(ReadyCookie, out var proof) || proof.Length != 43)
            return InvalidLogin();

        Response.Cookies.Delete(ReadyCookie, Cookie());
        var sessionKey = CdsSsoSessions.SessionKey(proof);
        try
        {
            var delegation = await sessions.RedeemAsync(sessionKey, ct);
            if (delegation is null) return InvalidLogin();
            var user = await sessions.FindLoginUserAsync(delegation.LocalAccount, ct);
            if (user is null || !await sessions.IsAuthorizedAsync(delegation, ct)) return InvalidLogin();

            var expires = (int)(delegation.ExpiresAt - DateTime.UtcNow).TotalMinutes;
            if (expires < 1) return InvalidLogin();

            const string clientType = "admin";
            var tokenVersion = await localSessions.GetTokenVersionAsync(user.UserId, clientType, ct);
            var mapLimit = AuthTokenLifetimes.EffectiveAccessTokenMinutes(
                config.GetValue<int>("Jwt:AccessTokenMinutes", AuthTokenLifetimes.DefaultAccessTokenMinutes),
                config.GetValue<int>("Auth:SessionSlidingDays", AuthTokenLifetimes.DefaultSessionSlidingDays));
            expires = Math.Min(expires, mapLimit);
            var accessToken = jwt.GenerateAccessToken(user, clientType, sessionKey, tokenVersion, expiresInMinutes: expires);
            await users.UpdateLastLoginAsync(user.UserId);
            await users.UpdateLastActiveAsync(user.UserId);
            logger.LogInformation("MAP user {UserId} logged in via CDS SSO", user.UserId);

            return Ok(ApiResponse<LoginResponse>.Ok(new LoginResponse
            {
                AccessToken = accessToken,
                // Local refresh must never convert a CDS login into a password session.
                RefreshToken = "",
                SessionKey = sessionKey,
                ClientType = clientType,
                ExpiresIn = expires * 60,
                User = new UserInfo
                {
                    UserId = user.UserId,
                    Username = user.Username,
                    DisplayName = user.DisplayName,
                    Role = user.Role,
                    UserType = user.UserType,
                    AvatarFileName = user.AvatarFileName,
                    AvatarUrl = AvatarUrlBuilder.Build(config, user)
                }
            }));
        }
        catch (Exception ex) when (IsUpstreamFailure(ex, ct))
        {
            logger.LogWarning("CDS SSO completion unavailable ({Reason})", ex.GetBaseException().GetType().Name);
            return StatusCode(503, ApiResponse<object>.Fail("CDS_SSO_UNAVAILABLE", "暂时无法验证 CDS 登录，请稍后重试。"));
        }
    }

    private CdsSsoFlow? ReadFlow()
    {
        if (!Request.Cookies.TryGetValue(FlowCookie, out var encrypted)) return null;
        try { return JsonSerializer.Deserialize<CdsSsoFlow>(_flowProtector.Unprotect(encrypted)); }
        catch (Exception ex) when (ex is CryptographicException or JsonException) { return null; }
    }

    internal static string SafeReturnUrl(string? value) => value is { Length: > 0 and <= 2048 } && value[0] == '/'
        && !value.StartsWith("//", StringComparison.Ordinal) && !value.Contains('\\') && !value.Contains('#')
        && !value.Contains("%5c", StringComparison.OrdinalIgnoreCase)
        && value.Split('?', 2)[0] is not ("/login" or "/login/")
        && !value.Any(char.IsControl) ? value : "/";

    private IActionResult Back(string status, string returnUrl) => LocalRedirect(QueryHelpers.AddQueryString("/login",
        new Dictionary<string, string?> { ["cdsSso"] = status, ["returnUrl"] = returnUrl }));

    private UnauthorizedObjectResult InvalidLogin() =>
        Unauthorized(ApiResponse<object>.Fail("CDS_SSO_INVALID", "CDS 登录已失效或该账号未获授权，请重新登录。"));

    private static CookieOptions Cookie(TimeSpan? maxAge = null) => new()
    {
        Path = "/", Secure = true, HttpOnly = true, SameSite = SameSiteMode.Lax, MaxAge = maxAge, IsEssential = true
    };

    private static string RandomProof() => WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    private static bool IsUpstreamFailure(Exception ex, CancellationToken ct) =>
        ex is HttpRequestException or InvalidOperationException or JsonException or MongoDB.Driver.MongoException
        || (ex is OperationCanceledException && !ct.IsCancellationRequested);
}
