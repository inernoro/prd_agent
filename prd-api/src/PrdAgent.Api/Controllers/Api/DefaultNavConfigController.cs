using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using System.IdentityModel.Tokens.Jwt;
using System.Text.RegularExpressions;
using PrdAgent.Api.Models.Responses;
using PrdAgent.Core.Interfaces;
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
    private readonly IAdminPermissionService _permissionService;

    public DefaultNavConfigController(MongoDbContext db, IAdminPermissionService permissionService)
    {
        _db = db;
        _permissionService = permissionService;
    }

    /// <summary>
    /// 全员总览是 GET，类级 AdminController 只会按 settings.read 放行；但它列出的是所有人的账号与偏好，
    /// 门槛必须与「所有人的默认导航」的写权限一致（settings.write 或 super），不能靠前端不显示入口。
    /// </summary>
    private async Task<bool> CanManageAllUsersNavAsync(CancellationToken ct)
    {
        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal);
        if (isRoot) return true;
        var uid = User.FindFirst(JwtRegisteredClaimNames.Sub)?.Value ?? string.Empty;
        if (string.IsNullOrWhiteSpace(uid)) return false;
        var perms = await _permissionService.GetEffectivePermissionsAsync(uid, isRoot: false, ct);
        return perms.Contains(AdminPermissionCatalog.SettingsWrite) || perms.Contains(AdminPermissionCatalog.Super);
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
            .Set(x => x.NavLayoutUpdatedAt, DateTime.UtcNow)
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
        if (!await CanManageAllUsersNavAsync(ct))
        {
            return StatusCode(StatusCodes.Status403Forbidden,
                ApiResponse<object>.Fail("FORBIDDEN", "查看全员导航需要 settings.write 权限"));
        }

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
            CustomizedCount = items.Count(i => i.Customized),
            // 全量菜单目录（不按当前管理员权限过滤）：总览用它判「已下线」，否则权限不全的管理员
            // 会把自己看不到的合法菜单当成下线项，进而经 remove-tokens 从所有人的导航里删掉（Codex P1）
            Catalog = FullMenuCatalog()
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
            .Set(x => x.NavLayoutUpdatedAt, DateTime.UtcNow)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        await _db.UserPreferences.UpdateOneAsync(x => x.UserId == userId, update, cancellationToken: ct);

        var pref = await _db.UserPreferences.Find(x => x.UserId == userId).FirstOrDefaultAsync(ct);
        return Ok(ApiResponse<UserNavLayoutItem>.Ok(UserNavLayoutItem.From(user, pref)));
    }

    /// <summary>
    /// 从「所有人的默认导航」和全部用户的个人导航（navOrder + navHidden）里拔掉指定 token。
    /// 用途：某个菜单下线后，把还挂在各处的旧 key 一次清干净，而不必重置任何人的自定义顺序。
    /// 只删指定 token，不动其余顺序；分隔符本身不可作为 token 传入。
    /// </summary>
    [HttpPost("remove-tokens")]
    public async Task<IActionResult> RemoveTokens([FromBody] RemoveNavTokensRequest? request, CancellationToken ct)
    {
        var tokens = (request?.Tokens ?? new List<string>())
            .Where(t => !string.IsNullOrWhiteSpace(t))
            .Select(t => t.Trim())
            .Where(t => t != NavDividerToken)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (tokens.Count == 0)
        {
            return BadRequest(ApiResponse<object>.Fail("INVALID_ARGUMENT", "tokens 不能为空"));
        }
        // 仍在目录里的菜单 key 不许清：这是破坏性操作，判据必须是服务端全量目录，不能信前端传来的集合
        var catalogKeys = new HashSet<string>(AdminMenuCatalog.All.Select(m => m.AppKey), StringComparer.Ordinal);
        var stillValid = tokens.Where(t => catalogKeys.Contains(StripLegacyNavPrefix(t))).ToList();
        if (stillValid.Count > 0)
        {
            return BadRequest(ApiResponse<object>.Fail(
                "NAV_TOKEN_STILL_VALID",
                $"这些 key 仍是有效菜单，拒绝清理：{string.Join("、", stillValid)}"));
        }
        var tokenSet = new HashSet<string>(tokens, StringComparer.Ordinal);

        // 1. 所有人的默认导航
        var config = await _db.DefaultNavConfigs.Find(x => x.Id == "singleton").FirstOrDefaultAsync(ct);
        var defaultRemoved = 0;
        if (config != null)
        {
            var order = config.NavOrder ?? new List<string>();
            var hidden = config.NavHidden ?? new List<string>();
            var nextOrder = CollapseDividers(order.Where(t => !tokenSet.Contains(t)).ToList());
            var nextHidden = hidden.Where(t => !tokenSet.Contains(t)).ToList();
            defaultRemoved = (order.Count - nextOrder.Count) + (hidden.Count - nextHidden.Count);
            if (defaultRemoved > 0)
            {
                config.NavOrder = nextOrder;
                config.NavHidden = nextHidden;
                config.UpdatedAt = DateTime.UtcNow;
                await _db.DefaultNavConfigs.ReplaceOneAsync(x => x.Id == "singleton", config, cancellationToken: ct);
            }
        }

        // 2. 全部用户：只 pull 指定 token，不重排、不重置
        var filter = Builders<UserPreferences>.Filter.Or(
            Builders<UserPreferences>.Filter.AnyIn(x => x.NavOrder, tokens),
            Builders<UserPreferences>.Filter.AnyIn(x => x.NavHidden, tokens));
        var update = Builders<UserPreferences>.Update
            .PullAll(x => x.NavOrder, tokens)
            .PullAll(x => x.NavHidden, tokens)
            .Set(x => x.NavLayoutUpdatedAt, DateTime.UtcNow)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        var result = await _db.UserPreferences.UpdateManyAsync(filter, update, cancellationToken: ct);

        return Ok(ApiResponse<RemoveNavTokensResponse>.Ok(new RemoveNavTokensResponse
        {
            Tokens = tokens,
            DefaultRemovedCount = defaultRemoved,
            DefaultNavOrder = config?.NavOrder ?? new List<string>(),
            DefaultNavHidden = config?.NavHidden ?? new List<string>(),
            UsersMatchedCount = result.MatchedCount,
            UsersModifiedCount = result.ModifiedCount
        }));
    }

    private const string NavDividerToken = "---";

    private static readonly Regex LegacyNavPrefix = new("^(agent|toolbox|utility|infra|builtin):", RegexOptions.Compiled);

    /// <summary>与前端 migrateLegacyNavId 同口径：去掉 v7 之前的前缀，再拿去和目录比对。</summary>
    private static string StripLegacyNavPrefix(string token) => LegacyNavPrefix.Replace(token, string.Empty);

    private static List<AdminMenuItemResponse> FullMenuCatalog() => AdminMenuCatalog.All
        .Select(x => new AdminMenuItemResponse
        {
            AppKey = x.AppKey,
            Path = x.Path,
            Label = x.Label,
            Description = x.Description,
            Icon = x.Icon,
            SortOrder = x.SortOrder,
            Group = x.Group
        })
        .ToList();

    /// <summary>去掉首尾与连续的分隔符，与前端 collapseDividers 语义一致。</summary>
    private static List<string> CollapseDividers(List<string> arr)
    {
        var result = new List<string>();
        foreach (var token in arr)
        {
            if (token == NavDividerToken)
            {
                if (result.Count == 0) continue;
                if (result[^1] == NavDividerToken) continue;
            }
            result.Add(token);
        }
        while (result.Count > 0 && result[^1] == NavDividerToken) result.RemoveAt(result.Count - 1);
        return result;
    }
}

public class RemoveNavTokensRequest
{
    public List<string>? Tokens { get; set; }
}

public class RemoveNavTokensResponse
{
    public List<string> Tokens { get; set; } = new();
    /// <summary>从所有人的默认导航里去掉的条目数（含随之收敛掉的分隔符）。</summary>
    public int DefaultRemovedCount { get; set; }
    public List<string> DefaultNavOrder { get; set; } = new();
    public List<string> DefaultNavHidden { get; set; } = new();
    public long UsersMatchedCount { get; set; }
    public long UsersModifiedCount { get; set; }
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
    /// <summary>导航布局最近一次改动时间（NavLayoutUpdatedAt）；老记录没有这个字段时为 null，排在有时间的之后。</summary>
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
            UpdatedAt = pref?.NavLayoutUpdatedAt
        };
    }
}

public class UserNavLayoutsResponse
{
    public List<UserNavLayoutItem> Items { get; set; } = new();
    public int TotalCount { get; set; }
    public int CustomizedCount { get; set; }
    /// <summary>全量菜单目录（不按调用者权限过滤），供总览判「已下线」与复演侧栏自动补齐。</summary>
    public List<AdminMenuItemResponse> Catalog { get; set; } = new();
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
