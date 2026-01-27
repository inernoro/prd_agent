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

        return Ok(ApiResponse<object>.Ok(new
        {
            navOrder = prefs?.NavOrder ?? new List<string>(),
            themeConfig = prefs?.ThemeConfig,
            visualAgentPreferences = prefs?.VisualAgentPreferences
        }));
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
}

public class UpdateNavOrderRequest
{
    public List<string>? NavOrder { get; set; }
}

public class UpdateThemeConfigRequest
{
    public ThemeConfig? ThemeConfig { get; set; }
}

public class UpdateVisualAgentPreferencesRequest
{
    public VisualAgentPreferences? VisualAgentPreferences { get; set; }
}
