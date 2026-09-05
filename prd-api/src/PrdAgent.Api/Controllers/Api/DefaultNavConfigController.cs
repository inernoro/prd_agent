using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 全局默认导航配置。
/// </summary>
[ApiController]
[Route("api/settings/default-nav")]
[Authorize]
[AdminController("settings", AdminPermissionCatalog.SettingsRead, WritePermission = AdminPermissionCatalog.SettingsWrite)]
public class DefaultNavConfigController : ControllerBase
{
    private readonly MongoDbContext _db;

    public DefaultNavConfigController(MongoDbContext db)
    {
        _db = db;
    }

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var config = await _db.DefaultNavConfigs
            .Find(x => x.Id == "singleton")
            .FirstOrDefaultAsync(ct)
            ?? new DefaultNavConfig();

        return Ok(ApiResponse<DefaultNavConfigResponse>.Ok(DefaultNavConfigResponse.From(config)));
    }

    [HttpPut]
    public async Task<IActionResult> Put([FromBody] UpdateDefaultNavConfigRequest? request, CancellationToken ct)
    {
        var config = new DefaultNavConfig
        {
            Id = "singleton",
            NavOrder = request?.NavOrder ?? new List<string>(),
            NavHidden = request?.NavHidden ?? new List<string>(),
            UpdatedAt = DateTime.UtcNow
        };

        await _db.DefaultNavConfigs.ReplaceOneAsync(
            x => x.Id == "singleton",
            config,
            new ReplaceOptions { IsUpsert = true },
            ct);

        return Ok(ApiResponse<DefaultNavConfigResponse>.Ok(DefaultNavConfigResponse.From(config)));
    }

    [HttpPost("apply-to-all-users")]
    public async Task<IActionResult> ApplyToAllUsers(CancellationToken ct)
    {
        var update = Builders<UserPreferences>.Update
            .Set(x => x.NavOrder, new List<string>())
            .Set(x => x.NavHidden, new List<string>())
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        var result = await _db.UserPreferences.UpdateManyAsync(
            Builders<UserPreferences>.Filter.Empty,
            update,
            cancellationToken: ct);

        return Ok(ApiResponse<ApplyDefaultNavToAllUsersResponse>.Ok(new ApplyDefaultNavToAllUsersResponse
        {
            MatchedCount = result.MatchedCount,
            ModifiedCount = result.ModifiedCount
        }));
    }

    /// <summary>
    /// 全员导航总览：每个真人用户一行，自定义过导航的排在前面（按最近改动倒序），
    /// 沿用默认导航的排在后面（按显示名）。管理员下线菜单前用它看清谁的自定义顺序里还挂着旧项。
    /// </summary>
    [HttpGet("user-layouts")]
    public async Task<IActionResult> ListUserLayouts(CancellationToken ct)
    {
        var users = await _db.Users
            .Find(u => u.UserType == UserType.Human)
            .Project(u => new UserNavLayoutUserProjection
            {
                UserId = u.UserId,
                Username = u.Username,
                DisplayName = u.DisplayName,
                Role = u.Role,
                Status = u.Status
            })
            .ToListAsync(ct);

        var userIds = users.Select(u => u.UserId).ToList();
        var prefs = await _db.UserPreferences
            .Find(Builders<UserPreferences>.Filter.In(p => p.UserId, userIds))
            .ToListAsync(ct);
        var prefByUser = prefs
            .GroupBy(p => p.UserId, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.First(), StringComparer.Ordinal);

        var items = users
            .Select(u =>
            {
                prefByUser.TryGetValue(u.UserId, out var pref);
                return UserNavLayoutItem.From(u, pref);
            })
            .OrderByDescending(i => i.Customized)
            .ThenByDescending(i => i.Customized ? i.UpdatedAt : null)
            .ThenBy(i => i.DisplayName, StringComparer.Ordinal)
            .ToList();

        return Ok(ApiResponse<UserNavLayoutsResponse>.Ok(new UserNavLayoutsResponse
        {
            Items = items,
            TotalCount = items.Count,
            CustomizedCount = items.Count(i => i.Customized)
        }));
    }

    /// <summary>
    /// 把某一个用户的个人导航清空，让其回退到「所有人的默认导航」。
    /// 与 apply-to-all-users 的区别：只动这一个人，不影响其他人的自定义。
    /// </summary>
    [HttpDelete("user-layouts/{userId}")]
    public async Task<IActionResult> ResetUserLayout(string userId, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(userId))
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_ARGUMENT", "userId 不能为空"));
        }

        var user = await _db.Users
            .Find(u => u.UserId == userId)
            .Project(u => new UserNavLayoutUserProjection
            {
                UserId = u.UserId,
                Username = u.Username,
                DisplayName = u.DisplayName,
                Role = u.Role,
                Status = u.Status
            })
            .FirstOrDefaultAsync(ct);
        if (user == null)
        {
            return NotFound(ApiResponse<object>.Fail("USER_NOT_FOUND", "用户不存在"));
        }

        var update = Builders<UserPreferences>.Update
            .Set(x => x.NavOrder, new List<string>())
            .Set(x => x.NavHidden, new List<string>())
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        await _db.UserPreferences.UpdateOneAsync(x => x.UserId == userId, update, cancellationToken: ct);

        var pref = await _db.UserPreferences.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<UserNavLayoutItem>.Ok(UserNavLayoutItem.From(user, pref)));
    }
}

public class UserNavLayoutUserProjection
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public UserRole Role { get; set; }
    public UserStatus Status { get; set; }
}

public class UserNavLayoutItem
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    /// <summary>navOrder 或 navHidden 任一非空即视为自定义过。</summary>
    public bool Customized { get; set; }
    public List<string> NavOrder { get; set; } = new();
    public List<string> NavHidden { get; set; } = new();
    /// <summary>偏好记录最近一次改动时间；没有偏好记录时为 null。</summary>
    public DateTime? UpdatedAt { get; set; }

    public static UserNavLayoutItem From(UserNavLayoutUserProjection user, UserPreferences? pref)
    {
        var order = pref?.NavOrder ?? new List<string>();
        var hidden = pref?.NavHidden ?? new List<string>();
        return new UserNavLayoutItem
        {
            UserId = user.UserId,
            Username = user.Username,
            DisplayName = string.IsNullOrWhiteSpace(user.DisplayName) ? user.Username : user.DisplayName,
            Role = user.Role.ToString(),
            Status = user.Status.ToString(),
            Customized = order.Count > 0 || hidden.Count > 0,
            NavOrder = order,
            NavHidden = hidden,
            UpdatedAt = pref?.UpdatedAt
        };
    }
}

public class UserNavLayoutsResponse
{
    public List<UserNavLayoutItem> Items { get; set; } = new();
    public int TotalCount { get; set; }
    public int CustomizedCount { get; set; }
}

public class UpdateDefaultNavConfigRequest
{
    public List<string>? NavOrder { get; set; }
    public List<string>? NavHidden { get; set; }
}

public class DefaultNavConfigResponse
{
    public List<string> NavOrder { get; set; } = new();
    public List<string> NavHidden { get; set; } = new();
    public DateTime UpdatedAt { get; set; }

    public static DefaultNavConfigResponse From(DefaultNavConfig config)
    {
        return new DefaultNavConfigResponse
        {
            NavOrder = config.NavOrder ?? new List<string>(),
            NavHidden = config.NavHidden ?? new List<string>(),
            UpdatedAt = config.UpdatedAt
        };
    }
}

public class ApplyDefaultNavToAllUsersResponse
{
    public long MatchedCount { get; set; }
    public long ModifiedCount { get; set; }
}
