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
            agentSwitcherPreferences = prefs?.AgentSwitcherPreferences,
            homeLauncherPreferences = prefs?.HomeLauncherPreferences,
            documentStorePinnedIds = prefs?.DocumentStorePinnedIds ?? new List<string>()
        }));
    }

    /// <summary>
    /// 更新置顶的知识库 ID 列表（用户级，跨设备/重登录保持）
    /// </summary>
    [HttpPut("doc-store-pins")]
    public async Task<IActionResult> UpdateDocumentStorePins([FromBody] UpdateDocumentStorePinsRequest request)
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        var ids = (request.DocumentStorePinnedIds ?? new List<string>())
            .Where(s => !string.IsNullOrWhiteSpace(s))
            .Distinct()
            .Take(200)
            .ToList();

        var update = Builders<UserPreferences>.Update
            .Set(x => x.DocumentStorePinnedIds, ids)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { documentStorePinnedIds = ids }));
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
    /// 更新首页启动器偏好
    /// </summary>
    [HttpPut("home-launcher")]
    public async Task<IActionResult> UpdateHomeLauncherPreferences([FromBody] UpdateHomeLauncherPreferencesRequest request)
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        if (request.HomeLauncherPreferences == null)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "homeLauncherPreferences 不能为空"));

        var p = request.HomeLauncherPreferences;
        p.SecondaryQuickLink = NormalizeHomeSecondaryQuickLink(p.SecondaryQuickLink);
        p.QuickLinkIds = NormalizeHomeQuickLinkIds(p.QuickLinkIds, p.SecondaryQuickLink);

        var update = Builders<UserPreferences>.Update
            .Set(x => x.HomeLauncherPreferences, p)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    private static string NormalizeHomeSecondaryQuickLink(string? value)
    {
        return value is "voc" ? "voc" : "library";
    }

    private static List<string> NormalizeHomeQuickLinkIds(List<string>? ids, string secondaryQuickLink)
    {
        var result = new List<string>();
        foreach (var id in ids ?? new List<string>())
        {
            var normalizedId = id?.Trim();
            if (normalizedId is null || !IsValidHomeQuickLinkId(normalizedId) || result.Contains(normalizedId)) continue;
            result.Add(normalizedId);
            if (result.Count >= 6) break;
        }

        if (result.Count > 0) return result;

        return secondaryQuickLink == "voc"
            ? new List<string> { "marketplace", "voc", "showcase", "updates" }
            : new List<string> { "marketplace", "library", "showcase", "updates" };
    }

    private static bool IsValidHomeQuickLinkId(string id)
    {
        if (string.IsNullOrWhiteSpace(id) || id.Length > 64) return false;
        return id.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-');
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
    /// 转录词云的生效词典：系统级 ∪ 个人补充 − 个人屏蔽。
    ///
    /// 合并放后端做，前端只消费结果——前端不该自己维护业务数据映射表
    /// （frontend-architecture.md 单一数据源）。词典只做「加」不做「猜」：
    /// 它保证表里的词被完整保留，不引入新的边界猜测，
    /// 所以不会把已经治好的半截词问题带回来。
    /// </summary>
    [HttpGet("transcript-lexicon")]
    public async Task<IActionResult> GetTranscriptLexicon()
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        var settings = await _db.AppSettings.Find(x => x.Id == "global").FirstOrDefaultAsync();
        var preferences = await _db.UserPreferences.Find(x => x.UserId == userId).FirstOrDefaultAsync();

        var muted = new HashSet<string>(
            (preferences?.TranscriptLexiconMuted ?? new List<string>()).Select(x => x.Trim()).Where(x => x.Length > 0),
            StringComparer.Ordinal);
        var terms = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        void Add(IEnumerable<string>? source, bool honorMute)
        {
            foreach (var raw in source ?? Enumerable.Empty<string>())
            {
                var term = raw.Trim();
                // 单字进不了词云（本身就是分词残渣），过长的多半是整句误粘进来
                if (term.Length is < 2 or > 24) continue;
                if (honorMute && muted.Contains(term)) continue;
                if (seen.Add(term)) terms.Add(term);
            }
        }
        Add(settings?.TranscriptLexicon, honorMute: true);
        Add(preferences?.TranscriptLexicon, honorMute: false);

        return Ok(ApiResponse<object>.Ok(new
        {
            terms,
            system = settings?.TranscriptLexicon ?? new List<string>(),
            mine = preferences?.TranscriptLexicon ?? new List<string>(),
            muted = preferences?.TranscriptLexiconMuted ?? new List<string>(),
            // 前端据此决定显不显示「加入系统词典」——没有权限就不给一个点了会 403 的入口
            canManageSystem = HasSettingsWritePermission(),
        }));
    }

    /// <summary>
    /// 更新个人词典与屏蔽表。系统级词典不在这里改（那是管理员的表）。
    /// </summary>
    [HttpPut("transcript-lexicon")]
    public async Task<IActionResult> UpdateTranscriptLexicon([FromBody] UpdateTranscriptLexiconRequest request)
    {
        var userId = GetCurrentUserId();
        if (string.IsNullOrEmpty(userId))
            return Unauthorized(ApiResponse<object>.Fail("UNAUTHORIZED", "未登录"));

        static List<string> Normalize(List<string>? source) => (source ?? new List<string>())
            .Select(x => x.Trim())
            .Where(x => x.Length is >= 2 and <= 24)
            .Distinct(StringComparer.Ordinal)
            .Take(500)
            .ToList();

        var update = Builders<UserPreferences>.Update
            .Set(x => x.TranscriptLexicon, Normalize(request.Terms))
            .Set(x => x.TranscriptLexiconMuted, Normalize(request.Muted))
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId, update, new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 更新系统级词典（全局，所有人默认引用）。要 settings.write 权限。
    ///
    /// 有存储没入口就是断头：字段能存、界面上没人改得了它。
    /// 这个端点和个人词典共用同一处 UI，管理员多一个「加入系统词典」的选项而已。
    /// </summary>
    [HttpPut("transcript-lexicon/system")]
    public async Task<IActionResult> UpdateSystemTranscriptLexicon([FromBody] UpdateTranscriptLexiconRequest request)
    {
        if (!HasSettingsWritePermission())
            return StatusCode(403, ApiResponse<object>.Fail("FORBIDDEN", "需要设置写权限才能改系统词典"));

        var terms = (request.Terms ?? new List<string>())
            .Select(x => x.Trim())
            .Where(x => x.Length is >= 2 and <= 24)
            .Distinct(StringComparer.Ordinal)
            .Take(2000)
            .ToList();

        await _db.AppSettings.UpdateOneAsync(
            x => x.Id == "global",
            Builders<AppSettings>.Update
                .Set(x => x.TranscriptLexicon, terms)
                .Set(x => x.UpdatedAt, DateTime.UtcNow),
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { count = terms.Count }));
    }

    private bool HasSettingsWritePermission()
    {
        var permissions = User.FindAll("permissions").Select(x => x.Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
        return permissions.Contains(AdminPermissionCatalog.Super)
            || permissions.Contains(AdminPermissionCatalog.SettingsWrite);
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

public class UpdateDocumentStorePinsRequest
{
    public List<string>? DocumentStorePinnedIds { get; set; }
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

public class UpdateHomeLauncherPreferencesRequest
{
    public HomeLauncherPreferences? HomeLauncherPreferences { get; set; }
}

public class UpdateTranscriptLexiconRequest
{
    /// <summary>个人补充的词条</summary>
    public List<string>? Terms { get; set; }

    /// <summary>从系统级词典里屏蔽掉的词条</summary>
    public List<string>? Muted { get; set; }
}
