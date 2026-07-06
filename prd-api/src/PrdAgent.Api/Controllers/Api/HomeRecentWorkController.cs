using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Authentication;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
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
    private readonly ITeamService _teams;
    private readonly IAdminPermissionService _permissions;

    public HomeRecentWorkController(MongoDbContext db, ITeamService teams, IAdminPermissionService permissions)
    {
        _db = db;
        _teams = teams;
        _permissions = permissions;
    }

    public record RecentWorkItem(string Route, string AgentKey, string Title, DateTime LastActiveAt);

    /// <summary>
    /// 各脚印类型对应的模块门禁，与各详情控制器的 [AdminController] 读权限一一对应。
    /// 被收回模块权限后详情路由已 403，这里同步让该模块的脚印整体消失（Codex P2：防标题泄漏 + 死链）。
    /// 不在表内的 agentKey 一律默认拒绝。
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> ModuleGate = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["visual-agent"] = AdminPermissionCatalog.VisualAgentUse,
        ["literary-agent"] = AdminPermissionCatalog.LiteraryAgentUse,
        ["workflow-agent"] = AdminPermissionCatalog.WorkflowAgentUse,
        ["defect-agent"] = AdminPermissionCatalog.DefectAgentUse,
        ["report-agent"] = AdminPermissionCatalog.ReportAgentUse,
        ["review-agent"] = AdminPermissionCatalog.ReviewAgentUse,
        ["document-store"] = AdminPermissionCatalog.DocumentStoreRead,
    };

    /// <summary>
    /// 加载当前用户的有效权限集。
    /// 本路由没有 [AdminController] 标注，AdminPermissionMiddleware 的扫描器匹配不到所需权限，
    /// 不会把 permissions 注入 User claims —— 所以这里必须走 IAdminPermissionService 直查，
    /// 禁止改回 User.FindAll("permissions")（在本路由上永远是空集，会让所有权限判定失真）。
    /// root / AI 超级访问的兜底口径与中间件 IsRoot 一致。
    /// </summary>
    private async Task<HashSet<string>> LoadEffectivePermissionsAsync(string userId, CancellationToken ct)
    {
        var isRoot = string.Equals(User.FindFirst("isRoot")?.Value, "1", StringComparison.Ordinal)
                     || string.Equals(User.FindFirst(AiAccessKeyAuthenticationHandler.ClaimTypeIsAiSuperAccess)?.Value, "1", StringComparison.Ordinal);
        var perms = await _permissions.GetEffectivePermissionsAsync(userId, isRoot, ct);
        return perms.ToHashSet(StringComparer.Ordinal);
    }

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

        // 权限口径与 AdminPermissionMiddleware 一致：先过 access 总闸，再看 Super / 具体权限
        var perms = await LoadEffectivePermissionsAsync(userId, ct);
        var hasAccess = perms.Contains(AdminPermissionCatalog.Super) || perms.Contains(AdminPermissionCatalog.Access);
        bool Has(string permission) => hasAccess
            && (perms.Contains(AdminPermissionCatalog.Super) || perms.Contains(permission));

        // 模块门禁：详情路由已 403 的模块，脚印（标题 + 深链）整体不返回
        opens = opens.Where(o => ModuleGate.TryGetValue(o.AgentKey, out var gate) && Has(gate)).ToList();
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
            // 同 GetWorkflow：本人创建，或持有 workflow-agent.manage（管理员可打开他人工作流，
            // 打点后富化也要认，否则管理场景下继续上次静默失效，Codex P2）
            var canManageWorkflows = Has(AdminPermissionCatalog.WorkflowAgentManage);
            var wfFilter = canManageWorkflows
                ? Builders<Workflow>.Filter.In(x => x.Id, wfIds)
                : Builders<Workflow>.Filter.And(
                    Builders<Workflow>.Filter.In(x => x.Id, wfIds),
                    Builders<Workflow>.Filter.Eq(x => x.CreatedBy, userId));
            var wfs = await _db.Workflows
                .Find(wfFilter)
                .Project(x => new { x.Id, x.Name })
                .ToListAsync(ct);
            foreach (var w in wfs) wfTitles[w.Id] = w.Name;
        }

        // 缺陷/周报/评审/知识库的复核口径与各详情端点一致：打点只代表"当时有权看"，
        // 这里必须按当前权限重判，否则被改派/移出团队/收权后仍会泄漏标题并留下死链（Codex P2）。
        var defectTitles = new Dictionary<string, string>(StringComparer.Ordinal);
        if (defectIds.Count > 0)
        {
            // 同 GetDefect：reporter / assignee / 缺陷管理权限
            var canManageDefects = Has(AdminPermissionCatalog.DefectAgentManage);
            var defectFilter = Builders<DefectReport>.Filter.And(
                Builders<DefectReport>.Filter.In(x => x.Id, defectIds),
                Builders<DefectReport>.Filter.Eq(x => x.IsDeleted, false));
            if (!canManageDefects)
            {
                defectFilter = Builders<DefectReport>.Filter.And(
                    defectFilter,
                    Builders<DefectReport>.Filter.Or(
                        Builders<DefectReport>.Filter.Eq(x => x.ReporterId, userId),
                        Builders<DefectReport>.Filter.Eq(x => x.AssigneeId, userId)));
            }
            var defects = await _db.DefectReports
                .Find(defectFilter)
                .Project(x => new { x.Id, x.Title })
                .ToListAsync(ct);
            foreach (var d in defects) defectTitles[d.Id] = string.IsNullOrWhiteSpace(d.Title) ? "未命名缺陷" : d.Title!;
        }

        var reportTitles = new Dictionary<string, string>(StringComparer.Ordinal);
        if (reportIds.Count > 0)
        {
            // 同 GetReport：本人周报直通；他人周报仅当团队可见性不是 LeadersOnly，
            // 或本人是该团队队长/副队长，或持有 report-agent.view.all
            var canViewAllReports = Has(AdminPermissionCatalog.ReportAgentViewAll);
            var reports = await _db.WeeklyReports
                .Find(x => reportIds.Contains(x.Id))
                .Project(x => new { x.Id, x.UserId, x.TeamId, x.WeekYear, x.WeekNumber, x.TeamName })
                .ToListAsync(ct);
            var foreignTeamIds = reports.Where(r => r.UserId != userId).Select(r => r.TeamId).Distinct().ToList();
            var leadersOnlyTeamIds = new HashSet<string>(StringComparer.Ordinal);
            var myLeaderTeamIds = new HashSet<string>(StringComparer.Ordinal);
            if (foreignTeamIds.Count > 0 && !canViewAllReports)
            {
                var teams = await _db.ReportTeams
                    .Find(t => foreignTeamIds.Contains(t.Id) && t.ReportVisibility == ReportVisibilityMode.LeadersOnly)
                    .Project(t => new { t.Id })
                    .ToListAsync(ct);
                foreach (var t in teams) leadersOnlyTeamIds.Add(t.Id);
                if (leadersOnlyTeamIds.Count > 0)
                {
                    var loTeamIds = leadersOnlyTeamIds.ToList();
                    var leaderships = await _db.ReportTeamMembers
                        .Find(m => loTeamIds.Contains(m.TeamId) && m.UserId == userId
                                   && (m.Role == ReportTeamRole.Leader || m.Role == ReportTeamRole.Deputy))
                        .Project(m => new { m.TeamId })
                        .ToListAsync(ct);
                    foreach (var m in leaderships) myLeaderTeamIds.Add(m.TeamId);
                }
            }
            foreach (var r in reports)
            {
                var visible = r.UserId == userId
                              || canViewAllReports
                              || !leadersOnlyTeamIds.Contains(r.TeamId)
                              || myLeaderTeamIds.Contains(r.TeamId);
                if (!visible) continue;
                var team = string.IsNullOrWhiteSpace(r.TeamName) ? "" : $"{r.TeamName} · ";
                reportTitles[r.Id] = $"{team}{r.WeekYear}-W{r.WeekNumber:D2} 周报";
            }
        }

        var reviewTitles = new Dictionary<string, string>(StringComparer.Ordinal);
        if (reviewIds.Count > 0)
        {
            // 同 GetSubmission：本人提交，或持有 review-agent.view-all
            var canViewAllReviews = Has(AdminPermissionCatalog.ReviewAgentViewAll);
            var reviewFilter = canViewAllReviews
                ? Builders<ReviewSubmission>.Filter.In(x => x.Id, reviewIds)
                : Builders<ReviewSubmission>.Filter.And(
                    Builders<ReviewSubmission>.Filter.In(x => x.Id, reviewIds),
                    Builders<ReviewSubmission>.Filter.Eq(x => x.SubmitterId, userId));
            var subs = await _db.ReviewSubmissions
                .Find(reviewFilter)
                .Project(x => new { x.Id, x.Title })
                .ToListAsync(ct);
            foreach (var r in subs) reviewTitles[r.Id] = string.IsNullOrWhiteSpace(r.Title) ? "未命名评审" : r.Title;
        }

        // 知识库：按详情端点同口径的主通道复核（owner / 公开 / 团队共享），
        // 用户被移出团队或库转私有后，名称不再出现在继续上次（Codex P2：防库名泄漏 + 死链）。
        // PM 项目 / 产品知识库 / 师徒库等专用访问通道不在此复刻（逻辑深耦合在
        // DocumentStoreController 私有方法里），宁可让这几类从脚印里消失也不泄漏。
        var docStoreTitles = new Dictionary<string, string>(StringComparer.Ordinal);
        if (docStoreIds.Count > 0)
        {
            var myTeamIds = await _teams.GetMyTeamIdsAsync(userId);
            var storeFilter = Builders<DocumentStore>.Filter.And(
                Builders<DocumentStore>.Filter.In(x => x.Id, docStoreIds),
                Builders<DocumentStore>.Filter.Or(
                    Builders<DocumentStore>.Filter.Eq(x => x.OwnerId, userId),
                    Builders<DocumentStore>.Filter.Eq(x => x.IsPublic, true),
                    Builders<DocumentStore>.Filter.AnyIn(x => x.SharedTeamIds, myTeamIds)));
            var stores = await _db.DocumentStores
                .Find(storeFilter)
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
