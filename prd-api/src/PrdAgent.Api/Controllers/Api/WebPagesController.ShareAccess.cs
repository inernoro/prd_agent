using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;

namespace PrdAgent.Api.Controllers.Api;

public partial class WebPagesController
{
    public sealed class UnlockShareRequest { public string? Password { get; set; } }

    [HttpPost("shares/{shareId}/password")]
    public async Task<IActionResult> ResetSharePassword(string shareId, [FromBody] UnlockShareRequest request, CancellationToken ct)
    {
        var password = request.Password?.Trim();
        if (string.IsNullOrEmpty(password) || password.Length < 12 || password.Length > 128)
            return BadRequest(ApiResponse<object>.Fail("INVALID_PASSWORD", "请输入 12 至 128 位新密码"));
        var hash = new SharePasswordService().Hash(password);
        var update = Builders<WebPageShareLink>.Update.Set(x => x.PasswordHash, hash.Hash)
            .Set(x => x.PasswordSalt, hash.Salt).Set(x => x.AccessLevel, "password").Unset(x => x.Password);
        var changed = await _db.WebPageShareLinks.UpdateOneAsync(x => x.Id == shareId && x.CreatedBy == GetUserId() && !x.IsRevoked,
            update, cancellationToken: ct);
        if (changed.MatchedCount != 1) return NotFound();
        Response.Headers["Cache-Control"] = "no-store";
        return Ok(ApiResponse<object>.Ok(new { password }));
    }

    [AllowAnonymous]
    [HttpPost("shares/view/{token}/access")]
    public async Task<IActionResult> UnlockShare(string token, [FromBody] UnlockShareRequest request, CancellationToken ct)
    {
        Response.Headers["Cache-Control"] = "no-store";
        var before = await _db.WebPageShareLinks.Find(x => x.Token == token).FirstOrDefaultAsync(ct);
        if (before == null) return NotFound();
        var result = await _siteService.ViewShareAsync(token, request.Password, User.Identity?.IsAuthenticated == true ? GetUserId() : null, ct: ct);
        if (result == null) return NotFound();
        if (result.Error != null)
        {
            if (result.RetryAfterSeconds is { } seconds) Response.Headers["Retry-After"] = seconds.ToString();
            return StatusCode(result.HttpStatus, ApiResponse<object>.Fail(result.HttpStatus == 429 ? "RATE_LIMITED" : result.HttpStatus == 401 ? "UNAUTHORIZED" : "SHARE_ACCESS_DENIED", result.Error));
        }
        if (before.AccessLevel != "password")
            return Ok(ApiResponse<object>.Ok(new { unlocked = true }));
        var grant = await HostedShareGrant.IssueAsync(_db, before, ct);
        Response.Cookies.Append(HostedShareGrant.CookieName(token), grant, new CookieOptions {
            HttpOnly = true, Secure = true, SameSite = SameSiteMode.Strict, Path = "/api/", MaxAge = TimeSpan.FromMinutes(30)
        });
        return Ok(ApiResponse<object>.Ok(new { unlocked = true }));
    }
}
