using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 首页「继续上次」聚合端点。
/// 汇总当前用户最近活跃的工作实体（视觉/文学工作区、工作流），按最近活跃时间倒序
/// 返回统一列表，供登录后首页一键回到上次的工作现场。
/// 工作区归属口径与前端列表页一致：scenarioType == article-illustration 归文学（/literary-agent/:id），
/// 其余归视觉（/visual-agent/:id）；两者底层共用 image_master_workspaces 集合。
/// behavior_events 里的路由是脱敏的（实体段已归一为 :id），拿不到具体工作区，
/// 因此本端点直接查实体集合的归属 + 时间字段，不依赖行为流水。
/// </summary>
[ApiController]
[Route("api/home")]
[Authorize]
public sealed class HomeRecentWorkController : ControllerBase
{
    private readonly MongoDbContext _db;

    public HomeRecentWorkController(MongoDbContext db)
    {
        _db = db;
    }

    public record RecentWorkItem(string Route, string AgentKey, string Title, DateTime LastActiveAt);

    /// <summary>最近活跃的工作实体（合并视觉/文学工作区与工作流，最多 limit 条）。</summary>
    [HttpGet("recent-work")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> RecentWork([FromQuery] int limit = 8, CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 12);
        var userId = this.GetRequiredUserId();

        var wsFilter = Builders<ImageMasterWorkspace>.Filter.Or(
            Builders<ImageMasterWorkspace>.Filter.Eq(x => x.OwnerUserId, userId),
            Builders<ImageMasterWorkspace>.Filter.AnyEq(x => x.MemberUserIds, userId));

        // 「最近活跃」= 打开（LastOpenedAt）或编辑（UpdatedAt）的较大者。
        // Mongo 端按两个字段各取一批，内存里按 Id 合并去重后取较大时间。
        var wsByUpdated = await _db.ImageMasterWorkspaces.Find(wsFilter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(limit)
            .Project(x => new { x.Id, x.Title, x.ScenarioType, x.UpdatedAt, x.LastOpenedAt })
            .ToListAsync(ct);
        var wsByOpened = await _db.ImageMasterWorkspaces.Find(wsFilter)
            .SortByDescending(x => x.LastOpenedAt)
            .Limit(limit)
            .Project(x => new { x.Id, x.Title, x.ScenarioType, x.UpdatedAt, x.LastOpenedAt })
            .ToListAsync(ct);
        var workflows = await _db.Workflows.Find(x => x.CreatedBy == userId)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(limit)
            .Project(x => new { x.Id, x.Name, x.UpdatedAt, x.LastExecutedAt })
            .ToListAsync(ct);

        var items = new List<RecentWorkItem>();

        var seenWs = new HashSet<string>(StringComparer.Ordinal);
        foreach (var ws in wsByUpdated.Concat(wsByOpened))
        {
            if (!seenWs.Add(ws.Id)) continue;
            var lastActive = ws.LastOpenedAt.HasValue && ws.LastOpenedAt.Value > ws.UpdatedAt
                ? ws.LastOpenedAt.Value
                : ws.UpdatedAt;
            var isLiterary = string.Equals(ws.ScenarioType, "article-illustration", StringComparison.Ordinal);
            items.Add(new RecentWorkItem(
                Route: isLiterary ? $"/literary-agent/{ws.Id}" : $"/visual-agent/{ws.Id}",
                AgentKey: isLiterary ? "literary-agent" : "visual-agent",
                Title: string.IsNullOrWhiteSpace(ws.Title) ? "未命名" : ws.Title,
                LastActiveAt: lastActive));
        }

        foreach (var wf in workflows)
        {
            var lastActive = wf.LastExecutedAt.HasValue && wf.LastExecutedAt.Value > wf.UpdatedAt
                ? wf.LastExecutedAt.Value
                : wf.UpdatedAt;
            items.Add(new RecentWorkItem(
                Route: $"/workflow-agent/{wf.Id}",
                AgentKey: "workflow-agent",
                Title: string.IsNullOrWhiteSpace(wf.Name) ? "未命名工作流" : wf.Name,
                LastActiveAt: lastActive));
        }

        var merged = items
            .OrderByDescending(x => x.LastActiveAt)
            .Take(limit)
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { items = merged }));
    }
}
