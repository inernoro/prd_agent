using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - desktop 在线状态/最近请求（Redis）
/// </summary>
[ApiController]
[Route("api/v1/admin/desktop/presence")]
[Authorize(Roles = "ADMIN")]
public class AdminDesktopPresenceController : ControllerBase
{
    private readonly ICacheManager _cache;

    public AdminDesktopPresenceController(ICacheManager cache)
    {
        _cache = cache;
    }

    private static string PresenceKeyPatternAll => "desktop:presence:*";
    private static string PresenceKeyPatternUser(string userId) => $"desktop:presence:{userId}:*";

    [HttpGet]
    public async Task<IActionResult> List()
    {
        var keys = _cache.GetKeys(PresenceKeyPatternAll).Take(2000).ToArray();
        var items = new List<DesktopPresenceEntry>();
        foreach (var k in keys)
        {
            var v = await _cache.GetAsync<DesktopPresenceEntry>(k);
            if (v != null) items.Add(v);
        }

        var sorted = items
            .OrderByDescending(x => x.LastSeenAt)
            .ThenBy(x => x.UserId, StringComparer.OrdinalIgnoreCase)
            .ThenBy(x => x.ClientId, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { items = sorted, total = sorted.Count }));
    }

    [HttpGet("{userId}")]
    public async Task<IActionResult> ByUser(string userId)
    {
        var keys = _cache.GetKeys(PresenceKeyPatternUser(userId)).Take(200).ToArray();
        var items = new List<DesktopPresenceEntry>();
        foreach (var k in keys)
        {
            var v = await _cache.GetAsync<DesktopPresenceEntry>(k);
            if (v != null) items.Add(v);
        }

        var sorted = items
            .OrderByDescending(x => x.LastSeenAt)
            .ThenBy(x => x.ClientId, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { userId, items = sorted, total = sorted.Count }));
    }
}


