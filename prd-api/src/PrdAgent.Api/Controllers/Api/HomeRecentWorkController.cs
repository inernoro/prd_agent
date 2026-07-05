using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 首页「继续上次」聚合端点。
/// 唯一数据源是每用户「最近打开」台账（home_recent_opens，打开工作区/工作流详情时打点）。
/// 禁止退回实体全局时间戳（UpdatedAt / LastOpenedAt / LastExecutedAt）作为排序依据：
/// 那些字段任何共享成员编辑、定时工作流自跑都会变，会把"别人/机器的活跃"顶进
/// 当前用户的继续上次，造成"人人看到同一批内容、且不是自己上次操作的"（2026-07-05 用户实测反馈）。
/// 实体集合只用于标题富化 + 当前权限复核；台账为空（新用户/从未打开过）就返回空，前端隐藏区块。
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

    /// <summary>当前用户最近打开的工作实体（最多 limit 条，按本人打开时间倒序）。</summary>
    [HttpGet("recent-work")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> RecentWork([FromQuery] int limit = 8, CancellationToken ct = default)
    {
        limit = Math.Clamp(limit, 1, 12);
        var userId = this.GetRequiredUserId();

        // 台账多取一些冗余：富化阶段会丢弃已删除/已失去权限的实体
        var opens = await _db.UserRecentOpens
            .Find(x => x.UserId == userId)
            .SortByDescending(x => x.LastOpenedAt)
            .Limit(limit * 3)
            .ToListAsync(ct);

        if (opens.Count == 0)
            return Ok(ApiResponse<object>.Ok(new { items = Array.Empty<RecentWorkItem>() }));

        var wsIds = opens.Where(o => o.AgentKey is "visual-agent" or "literary-agent").Select(o => o.EntityId).Distinct().ToList();
        var wfIds = opens.Where(o => o.AgentKey == "workflow-agent").Select(o => o.EntityId).Distinct().ToList();

        // 标题富化 + 权限复核（工作区：本人是 owner 或 member；工作流：本人创建）
        var wsTitles = new Dictionary<string, string>(StringComparer.Ordinal);
        if (wsIds.Count > 0)
        {
            var wsFilter = Builders<ImageMasterWorkspace>.Filter.And(
                Builders<ImageMasterWorkspace>.Filter.In(x => x.Id, wsIds),
                Builders<ImageMasterWorkspace>.Filter.Or(
                    Builders<ImageMasterWorkspace>.Filter.Eq(x => x.OwnerUserId, userId),
                    Builders<ImageMasterWorkspace>.Filter.AnyEq(x => x.MemberUserIds, userId)));
            var wss = await _db.ImageMasterWorkspaces.Find(wsFilter)
                .Project(x => new { x.Id, x.Title })
                .ToListAsync(ct);
            foreach (var w in wss) wsTitles[w.Id] = w.Title;
        }

        var wfTitles = new Dictionary<string, string>(StringComparer.Ordinal);
        if (wfIds.Count > 0)
        {
            var wfs = await _db.Workflows
                .Find(x => wfIds.Contains(x.Id) && x.CreatedBy == userId)
                .Project(x => new { x.Id, x.Name })
                .ToListAsync(ct);
            foreach (var w in wfs) wfTitles[w.Id] = w.Name;
        }

        var items = new List<RecentWorkItem>();
        foreach (var open in opens)
        {
            string? title = open.AgentKey == "workflow-agent"
                ? (wfTitles.TryGetValue(open.EntityId, out var wf) ? wf : null)
                : (wsTitles.TryGetValue(open.EntityId, out var ws) ? ws : null);
            if (title == null) continue; // 已删除或已失去权限：从继续上次里消失

            var route = open.AgentKey switch
            {
                "literary-agent" => $"/literary-agent/{open.EntityId}",
                "workflow-agent" => $"/workflow-agent/{open.EntityId}",
                _ => $"/visual-agent/{open.EntityId}",
            };
            items.Add(new RecentWorkItem(
                Route: route,
                AgentKey: open.AgentKey,
                Title: string.IsNullOrWhiteSpace(title) ? "未命名" : title,
                LastActiveAt: open.LastOpenedAt));
            if (items.Count >= limit) break;
        }

        return Ok(ApiResponse<object>.Ok(new { items }));
    }
}
