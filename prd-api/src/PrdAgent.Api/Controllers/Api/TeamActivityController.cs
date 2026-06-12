using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Filters;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 团队动态（全员工作日志时间线）。
/// 数据由 ActivityLogActionFilter 按白名单自动写入，本 Controller 只读。
/// </summary>
[ApiController]
[Route("api/team-activity")]
[Authorize]
[AdminController("team-activity", AdminPermissionCatalog.TeamActivityRead)]
public class TeamActivityController : ControllerBase
{
    private readonly MongoDbContext _db;

    public TeamActivityController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 动态列表（按时间倒序分页），支持按人 / 模块 / 时间范围筛选。
    /// </summary>
    [HttpGet("logs")]
    public async Task<IActionResult> ListLogs(
        [FromQuery] string? userId = null,
        [FromQuery] string? module = null,
        [FromQuery] DateTime? from = null,
        [FromQuery] DateTime? to = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 30)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var b = Builders<ActivityLog>.Filter;
        var filters = new List<FilterDefinition<ActivityLog>>();
        if (!string.IsNullOrWhiteSpace(userId)) filters.Add(b.Eq(x => x.ActorId, userId));
        if (!string.IsNullOrWhiteSpace(module)) filters.Add(b.Eq(x => x.Module, module));
        if (from.HasValue) filters.Add(b.Gte(x => x.CreatedAt, from.Value.ToUniversalTime()));
        if (to.HasValue) filters.Add(b.Lte(x => x.CreatedAt, to.Value.ToUniversalTime()));
        var filter = filters.Count == 0 ? b.Empty : b.And(filters);

        var total = await _db.ActivityLogs.CountDocumentsAsync(filter);
        var logs = await _db.ActivityLogs.Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        var actorIds = logs.Select(l => l.ActorId).Distinct().ToList();
        var actorMap = (await _db.Users.Find(u => actorIds.Contains(u.UserId)).ToListAsync())
            .ToDictionary(u => u.UserId, u => new { u.DisplayName, u.AvatarFileName });

        var items = logs.Select(l =>
        {
            actorMap.TryGetValue(l.ActorId, out var actor);
            return new
            {
                id = l.Id,
                actorId = l.ActorId,
                actorName = actor?.DisplayName,
                actorAvatarFileName = actor?.AvatarFileName,
                module = l.Module,
                moduleLabel = l.ModuleLabel,
                action = l.Action,
                actionLabel = l.ActionLabel,
                targetId = l.TargetId,
                targetTitle = l.TargetTitle,
                targetUrl = l.TargetUrl,
                createdAt = l.CreatedAt,
            };
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>
    /// 动态聚合统计（团队脉搏面板用）：总量 / 活跃成员 / 模块分布 / 成员排行 / 小时直方图。
    /// 模块与成员计数为精确聚合；小时直方图基于最近 HourSampleCap 条采样（覆盖今天/本周绰绰有余）。
    /// </summary>
    [HttpGet("stats")]
    public async Task<IActionResult> Stats(
        [FromQuery] string? userId = null,
        [FromQuery] string? module = null,
        [FromQuery] DateTime? from = null,
        [FromQuery] DateTime? to = null)
    {
        const int HourSampleCap = 5000;
        const int TopActorCap = 10;

        var b = Builders<ActivityLog>.Filter;
        var filters = new List<FilterDefinition<ActivityLog>>();
        if (!string.IsNullOrWhiteSpace(userId)) filters.Add(b.Eq(x => x.ActorId, userId));
        if (!string.IsNullOrWhiteSpace(module)) filters.Add(b.Eq(x => x.Module, module));
        if (from.HasValue) filters.Add(b.Gte(x => x.CreatedAt, from.Value.ToUniversalTime()));
        if (to.HasValue) filters.Add(b.Lte(x => x.CreatedAt, to.Value.ToUniversalTime()));
        var filter = filters.Count == 0 ? b.Empty : b.And(filters);

        var total = await _db.ActivityLogs.CountDocumentsAsync(filter);

        // 环比：取「同长度的上一个时间窗」总量（如今天 vs 昨天同窗、本周 vs 上周）。
        // 无 from（全部范围）时没有可比窗口，返回 null 前端不展示。
        long? previousTotal = null;
        if (from.HasValue)
        {
            var fromUtc = from.Value.ToUniversalTime();
            var endUtc = to?.ToUniversalTime() ?? DateTime.UtcNow;
            var span = endUtc - fromUtc;
            if (span > TimeSpan.Zero)
            {
                var prevFilters = new List<FilterDefinition<ActivityLog>>();
                if (!string.IsNullOrWhiteSpace(userId)) prevFilters.Add(b.Eq(x => x.ActorId, userId));
                if (!string.IsNullOrWhiteSpace(module)) prevFilters.Add(b.Eq(x => x.Module, module));
                prevFilters.Add(b.Gte(x => x.CreatedAt, fromUtc - span));
                prevFilters.Add(b.Lt(x => x.CreatedAt, fromUtc));
                previousTotal = await _db.ActivityLogs.CountDocumentsAsync(b.And(prevFilters));
            }
        }

        var moduleGroups = await _db.ActivityLogs.Aggregate()
            .Match(filter)
            .Group(x => x.Module, g => new { Module = g.Key, Count = g.Count() })
            .ToListAsync();
        var moduleLabelMap = ActivityActionRegistry.Modules.ToDictionary(m => m.Key, m => m.Label);
        var modules = moduleGroups
            .OrderByDescending(m => m.Count)
            .Select(m => new
            {
                key = m.Module,
                label = moduleLabelMap.TryGetValue(m.Module, out var label) ? label : m.Module,
                count = m.Count,
            })
            .ToList();

        var actorGroups = await _db.ActivityLogs.Aggregate()
            .Match(filter)
            .Group(x => x.ActorId, g => new { ActorId = g.Key, Count = g.Count() })
            .SortByDescending(x => x.Count)
            .ToListAsync();
        var topActors = actorGroups.Take(TopActorCap).ToList();
        var actorIds = topActors.Select(a => a.ActorId).ToList();
        var actorMap = (await _db.Users.Find(u => actorIds.Contains(u.UserId)).ToListAsync())
            .ToDictionary(u => u.UserId, u => new { u.DisplayName, u.AvatarFileName });
        var actors = topActors.Select(a =>
        {
            actorMap.TryGetValue(a.ActorId, out var actor);
            return new
            {
                actorId = a.ActorId,
                actorName = actor?.DisplayName,
                actorAvatarFileName = actor?.AvatarFileName,
                count = a.Count,
            };
        }).ToList();

        // 小时直方图：只投影 CreatedAt 在内存里数桶，避免依赖 $hour 表达式翻译；时区旋转交给前端
        var times = await _db.ActivityLogs.Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Limit(HourSampleCap)
            .Project(x => x.CreatedAt)
            .ToListAsync();
        var hourlyUtc = new int[24];
        foreach (var t in times) hourlyUtc[t.ToUniversalTime().Hour]++;

        return Ok(ApiResponse<object>.Ok(new
        {
            total,
            previousTotal,
            activeMembers = actorGroups.Count,
            modules,
            actors,
            hourlyUtc,
            sampled = total > HourSampleCap,
        }));
    }

    /// <summary>
    /// 模块筛选清单（来自白名单注册表，避免前后端模块清单漂移）。
    /// </summary>
    [HttpGet("modules")]
    public IActionResult ListModules()
    {
        var items = ActivityActionRegistry.Modules
            .Select(m => new { key = m.Key, label = m.Label })
            .ToList();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }
}
