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
