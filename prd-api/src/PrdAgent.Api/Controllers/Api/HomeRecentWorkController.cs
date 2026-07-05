using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 首页「继续上次」聚合端点。
/// 唯一数据源是每用户「最近打开」台账（home_recent_opens）。
/// 埋点位置（打开详情即打点）：视觉/文学工作区、工作流、缺陷、周报、产品评审、知识库。
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
        // 上限 30：首页默认收起一行，「浏览全部脚印」展开后允许翻看更长的足迹
        limit = Math.Clamp(limit, 1, 30);
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
        var defectIds = opens.Where(o => o.AgentKey == "defect-agent").Select(o => o.EntityId).Distinct().ToList();
        var reportIds = opens.Where(o => o.AgentKey == "report-agent").Select(o => o.EntityId).Distinct().ToList();
        var reviewIds = opens.Where(o => o.AgentKey == "review-agent").Select(o => o.EntityId).Distinct().ToList();
        var docStoreIds = opens.Where(o => o.AgentKey == "document-store").Select(o => o.EntityId).Distinct().ToList();

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

        // 缺陷/周报/评审：打点发生在各详情端点的权限检查之后（打开即有权看），
        // 这里只做存在性复核（缺陷排除回收站），点击深链后由目标页再做权威鉴权。
        var defectTitles = new Dictionary<string, string>(StringComparer.Ordinal);
        if (defectIds.Count > 0)
        {
            var defects = await _db.DefectReports
                .Find(x => defectIds.Contains(x.Id) && !x.IsDeleted)
                .Project(x => new { x.Id, x.Title })
                .ToListAsync(ct);
            foreach (var d in defects) defectTitles[d.Id] = string.IsNullOrWhiteSpace(d.Title) ? "未命名缺陷" : d.Title!;
        }

        var reportTitles = new Dictionary<string, string>(StringComparer.Ordinal);
        if (reportIds.Count > 0)
        {
            var reports = await _db.WeeklyReports
                .Find(x => reportIds.Contains(x.Id))
                .Project(x => new { x.Id, x.WeekYear, x.WeekNumber, x.TeamName })
                .ToListAsync(ct);
            foreach (var r in reports)
            {
                var team = string.IsNullOrWhiteSpace(r.TeamName) ? "" : $"{r.TeamName} · ";
                reportTitles[r.Id] = $"{team}{r.WeekYear}-W{r.WeekNumber:D2} 周报";
            }
        }

        var reviewTitles = new Dictionary<string, string>(StringComparer.Ordinal);
        if (reviewIds.Count > 0)
        {
            var subs = await _db.ReviewSubmissions
                .Find(x => reviewIds.Contains(x.Id))
                .Project(x => new { x.Id, x.Title })
                .ToListAsync(ct);
            foreach (var r in subs) reviewTitles[r.Id] = string.IsNullOrWhiteSpace(r.Title) ? "未命名评审" : r.Title;
        }

        var docStoreTitles = new Dictionary<string, string>(StringComparer.Ordinal);
        if (docStoreIds.Count > 0)
        {
            var stores = await _db.DocumentStores
                .Find(x => docStoreIds.Contains(x.Id))
                .Project(x => new { x.Id, x.Name })
                .ToListAsync(ct);
            foreach (var st in stores) docStoreTitles[st.Id] = string.IsNullOrWhiteSpace(st.Name) ? "未命名知识库" : st.Name;
        }

        var items = new List<RecentWorkItem>();
        foreach (var open in opens)
        {
            string? title = open.AgentKey switch
            {
                "workflow-agent" => wfTitles.TryGetValue(open.EntityId, out var wf) ? wf : null,
                "defect-agent" => defectTitles.TryGetValue(open.EntityId, out var df) ? df : null,
                "report-agent" => reportTitles.TryGetValue(open.EntityId, out var rp) ? rp : null,
                "review-agent" => reviewTitles.TryGetValue(open.EntityId, out var rv) ? rv : null,
                "document-store" => docStoreTitles.TryGetValue(open.EntityId, out var ds) ? ds : null,
                _ => wsTitles.TryGetValue(open.EntityId, out var ws) ? ws : null,
            };
            if (title == null) continue; // 已删除或已失去权限：从继续上次里消失

            var route = open.AgentKey switch
            {
                "literary-agent" => $"/literary-agent/{open.EntityId}",
                "workflow-agent" => $"/workflow-agent/{open.EntityId}",
                "defect-agent" => $"/defect-agent?defectId={open.EntityId}",
                "report-agent" => $"/report-agent/report/{open.EntityId}",
                "review-agent" => $"/review-agent/submissions/{open.EntityId}",
                "document-store" => $"/document-store?store={open.EntityId}",
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
