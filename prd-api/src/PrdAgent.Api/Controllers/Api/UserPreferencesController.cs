using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Claims;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 用户偏好设置
/// </summary>
[ApiController]
[Route("api/dashboard/user-preferences")]
[Authorize]
[AdminController("dashboard", AdminPermissionCatalog.Access)]
public class UserPreferencesController : ControllerBase
{
    private readonly MongoDbContext _db;

    public UserPreferencesController(MongoDbContext db)
    {
        _db = db;
    }

    private string? GetCurrentUserId()
    {
        return User.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? User.FindFirstValue("sub");
    }

    /// <summary>
    /// 获取当前用户的偏好设置
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> GetPreferences()
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        var prefs = await _db.UserPreferences
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync();
        var defaultNav = await _db.DefaultNavConfigs
            .Find(x => x.Id == "singleton")
            .FirstOrDefaultAsync();

        return Ok(ApiResponse<object>.Ok(new
        {
            navOrder = prefs?.NavOrder ?? new List<string>(),
            navHidden = prefs?.NavHidden ?? new List<string>(),
            defaultNavOrder = defaultNav?.NavOrder ?? new List<string>(),
            defaultNavHidden = defaultNav?.NavHidden ?? new List<string>(),
            themeConfig = prefs?.ThemeConfig,
            visualAgentPreferences = prefs?.VisualAgentPreferences,
            literaryAgentPreferences = prefs?.LiteraryAgentPreferences,
            agentSwitcherPreferences = prefs?.AgentSwitcherPreferences
        }));
    }

    /// <summary>
    /// 更新 Agent Switcher 偏好（置顶 / 最近 / 使用统计）
    /// </summary>
    [HttpPut("agent-switcher")]
    public async Task<IActionResult> UpdateAgentSwitcherPreferences([FromBody] UpdateAgentSwitcherPreferencesRequest request)
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        if (request.AgentSwitcherPreferences == null)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "agentSwitcherPreferences 不能为空"));

        // 轻量上限防御：避免不良客户端无限增长
        var p = request.AgentSwitcherPreferences;
        if (p.PinnedIds != null && p.PinnedIds.Count > 50) p.PinnedIds = p.PinnedIds.Take(50).ToList();
        if (p.RecentVisits != null && p.RecentVisits.Count > 50) p.RecentVisits = p.RecentVisits.Take(50).ToList();
        if (p.UsageCounts != null && p.UsageCounts.Count > 500)
            p.UsageCounts = p.UsageCounts.OrderByDescending(kv => kv.Value).Take(500).ToDictionary(kv => kv.Key, kv => kv.Value);

        var update = Builders<UserPreferences>.Update
            .Set(x => x.AgentSwitcherPreferences, p)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 更新导航顺序
    /// </summary>
    [HttpPut("nav-order")]
    public async Task<IActionResult> UpdateNavOrder([FromBody] UpdateNavOrderRequest request)
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        if (request.NavOrder == null)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "navOrder 不能为空"));

        var update = Builders<UserPreferences>.Update
            .Set(x => x.NavOrder, request.NavOrder)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 更新导航隐藏列表
    /// </summary>
    [HttpPut("nav-hidden")]
    public async Task<IActionResult> UpdateNavHidden([FromBody] UpdateNavHiddenRequest request)
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        if (request.NavHidden == null)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "navHidden 不能为空"));

        var update = Builders<UserPreferences>.Update
            .Set(x => x.NavHidden, request.NavHidden)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 一次性更新导航顺序 + 隐藏列表（减少网络往返）
    /// </summary>
    [HttpPut("nav-layout")]
    public async Task<IActionResult> UpdateNavLayout([FromBody] UpdateNavLayoutRequest request)
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        var update = Builders<UserPreferences>.Update
            .Set(x => x.NavOrder, request.NavOrder ?? new List<string>())
            .Set(x => x.NavHidden, request.NavHidden ?? new List<string>())
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 更新主题配置
    /// </summary>
    [HttpPut("theme")]
    public async Task<IActionResult> UpdateThemeConfig([FromBody] UpdateThemeConfigRequest request)
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        if (request.ThemeConfig == null)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "themeConfig 不能为空"));

        var update = Builders<UserPreferences>.Update
            .Set(x => x.ThemeConfig, request.ThemeConfig)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 更新视觉代理偏好
    /// </summary>
    [HttpPut("visual-agent")]
    public async Task<IActionResult> UpdateVisualAgentPreferences([FromBody] UpdateVisualAgentPreferencesRequest request)
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        if (request.VisualAgentPreferences == null)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "visualAgentPreferences 不能为空"));

        var update = Builders<UserPreferences>.Update
            .Set(x => x.VisualAgentPreferences, request.VisualAgentPreferences)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { }));
    }
    /// <summary>
    /// 更新文学创作 Agent 偏好
    /// </summary>
    [HttpPut("literary-agent")]
    public async Task<IActionResult> UpdateLiteraryAgentPreferences([FromBody] UpdateLiteraryAgentPreferencesRequest request)
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        if (request.LiteraryAgentPreferences == null)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "literaryAgentPreferences 不能为空"));

        var update = Builders<UserPreferences>.Update
            .Set(x => x.LiteraryAgentPreferences, request.LiteraryAgentPreferences)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { }));
    }
}

public class UpdateNavOrderRequest
{
    public List<string>? NavOrder { get; set; }
}

public class UpdateNavHiddenRequest
{
    public List<string>? NavHidden { get; set; }
}

public class UpdateNavLayoutRequest
{
    public List<string>? NavOrder { get; set; }
    public List<string>? NavHidden { get; set; }
}

public class UpdateThemeConfigRequest
{
    public ThemeConfig? ThemeConfig { get; set; }
}

public class UpdateVisualAgentPreferencesRequest
{
    public VisualAgentPreferences? VisualAgentPreferences { get; set; }
}

public class UpdateLiteraryAgentPreferencesRequest
{
    public LiteraryAgentPreferences? LiteraryAgentPreferences { get; set; }
}

public class UpdateAgentSwitcherPreferencesRequest
{
    public AgentSwitcherPreferences? AgentSwitcherPreferences { get; set; }
}
