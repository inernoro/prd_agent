using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// Desktop 在线状态（心跳）
/// </summary>
[ApiController]
[Route("api/v1/desktop/presence")]
[Authorize]
public class DesktopPresenceController : ControllerBase
{
    private readonly ICacheManager _cache;

    // online TTL：心跳 30s，TTL 90s，允许短暂抖动
    private static readonly TimeSpan PresenceTtl = TimeSpan.FromSeconds(90);

    public DesktopPresenceController(ICacheManager cache)
    {
        _cache = cache;
    }

    private static string? GetUserId(ClaimsPrincipal user)
    {
        return user.FindFirst(JwtRegisteredClaimNames.Sub)?.Value
               ?? user.FindFirst("sub")?.Value
               ?? user.FindFirst(ClaimTypes.NameIdentifier)?.Value
               ?? user.FindFirst("nameid")?.Value;
    }

    private static string PresenceKey(string userId, string clientId) => $"desktop:presence:{userId}:{clientId}";

    [HttpPost("heartbeat")]
    public async Task<IActionResult> Heartbeat()
    {
        var userId = GetUserId(User) ?? "anonymous";
        var clientType = (Request.Headers["X-Client"].ToString() ?? "").Trim();
        if (string.IsNullOrWhiteSpace(clientType)) clientType = "desktop";
        var clientId = (Request.Headers["X-Client-Id"].ToString() ?? "").Trim();
        if (string.IsNullOrWhiteSpace(clientId)) clientId = "unknown";

        var key = PresenceKey(userId, clientId);
        var now = DateTime.UtcNow;

        var existing = await _cache.GetAsync<DesktopPresenceEntry>(key);
        if (existing == null)
        {
            existing = new DesktopPresenceEntry
            {
                UserId = userId,
                ClientId = clientId,
                ClientType = clientType,
                LastSeenAt = now,
            };
        }
        else
        {
            existing.LastSeenAt = now;
            existing.ClientType = clientType;
        }

        await _cache.SetAsync(key, existing, PresenceTtl);

        return Ok(ApiResponse<object>.Ok(new
        {
            userId,
            clientId,
            clientType,
            lastSeenAt = now,
            ttlSeconds = (int)PresenceTtl.TotalSeconds
        }));
    }
}


