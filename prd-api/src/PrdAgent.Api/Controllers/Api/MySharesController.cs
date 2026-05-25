using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 分享总管理 — 个人视角："我一共分享了什么"。
///
/// 用户提的核心诉求（2026-05-21）：
///   "分享的地方很多，方便进行分类。我一共分享了什么，我得知道，
///    或者管理员也知道所有人分享了什么，这样更方便进行管理。分享总管理是很重要的事情。"
///
/// 设计：跨 4 类 ShareLink 集合（web_page / report / document_store / workflow）按
/// CreatedBy == 当前用户聚合，关联 ShortLink 全局索引拿到数字 Seq，
/// 输出统一形态 + 4 种 URL 形态供前端展示。
///
/// 管理员的"全部分享总览"走 /api/admin/short-links（已有），与本端点互不冲突。
/// </summary>
[ApiController]
[Route("api/my/shares")]
[Authorize]
public class MySharesController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly IShortLinkService _shortLinks;
    private readonly ILogger<MySharesController> _logger;

    public MySharesController(MongoDbContext db, IShortLinkService shortLinks, ILogger<MySharesController> logger)
    {
        _db = db;
        _shortLinks = shortLinks;
        _logger = logger;
    }

    /// <summary>
    /// 列出当前用户的所有分享（跨 4 类聚合）。
    /// 默认按创建时间倒序。targetType 可选过滤。
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> ListMine(
        [FromQuery] string? targetType,
        [FromQuery] bool includeRevoked = true,
        CancellationToken ct = default)
    {
        var userId = this.GetRequiredUserId();
        var rows = new List<MyShareItem>();

        // 故意查询全部 4 类（不在查询阶段按 targetType 短路），这样下面的 byType 统计
        // 始终反映用户全量分享清单；targetType 仅用于过滤最终返回的 items（见末尾），
        // 不影响 chip 计数 —— 否则切了某类型 filter 后其它 chip 会消失、"全部"总数变错。
        bool wantType(string _) => true;

        // ── 1. 网页托管 ──
        if (wantType(ShortLinkTargetTypes.WebPage))
        {
            var f = Builders<WebPageShareLink>.Filter.And(
                Builders<WebPageShareLink>.Filter.Eq(x => x.CreatedBy, userId),
                // 「访问」便捷链不算用户主动分享，过滤掉（与 WebPagesController 列表口径一致）
                Builders<WebPageShareLink>.Filter.Ne(x => x.Purpose, "visit"));
            var list = await _db.WebPageShareLinks.Find(f).ToListAsync(ct);
            foreach (var s in list)
            {
                if (!includeRevoked && s.IsRevoked) continue;
                rows.Add(new MyShareItem
                {
                    TargetType = ShortLinkTargetTypes.WebPage,
                    Token = s.Token,
                    Title = s.Title ?? "（未命名网页分享）",
                    Subtitle = s.ShareType == "collection" ? $"合集 {s.SiteIds.Count} 个站点" : "单站点",
                    AccessLevel = s.AccessLevel,
                    ViewCount = s.ViewCount,
                    IsRevoked = s.IsRevoked,
                    ExpiresAt = s.ExpiresAt,
                    CreatedAt = s.CreatedAt,
                    PrimaryPath = $"/s/wp/{s.Token}",
                });
            }
        }

        // ── 2. 周报分享 ──
        if (wantType(ShortLinkTargetTypes.Report))
        {
            var f = Builders<ReportShareLink>.Filter.Eq(x => x.CreatedBy, userId);
            var list = await _db.ReportShareLinks.Find(f).ToListAsync(ct);
            foreach (var s in list)
            {
                if (!includeRevoked && s.IsRevoked) continue;
                rows.Add(new MyShareItem
                {
                    TargetType = ShortLinkTargetTypes.Report,
                    Token = s.Token,
                    Title = $"周报 · 团队 {s.TeamId[..Math.Min(8, s.TeamId.Length)]}",
                    Subtitle = $"访问级别 {s.AccessLevel}",
                    AccessLevel = s.AccessLevel,
                    ViewCount = s.ViewCount,
                    IsRevoked = s.IsRevoked,
                    ExpiresAt = s.ExpiresAt,
                    CreatedAt = s.CreatedAt,
                    PrimaryPath = $"/s/report-team/{s.Token}",
                });
            }
        }

        // ── 3. 知识库分享 ──
        if (wantType(ShortLinkTargetTypes.DocumentStore))
        {
            var f = Builders<DocumentStoreShareLink>.Filter.Eq(x => x.CreatedBy, userId);
            var list = await _db.DocumentStoreShareLinks.Find(f).ToListAsync(ct);
            foreach (var s in list)
            {
                if (!includeRevoked && s.IsRevoked) continue;
                rows.Add(new MyShareItem
                {
                    TargetType = ShortLinkTargetTypes.DocumentStore,
                    Token = s.Token,
                    Title = s.Title ?? s.StoreName ?? "（未命名知识库分享）",
                    Subtitle = $"知识库 {s.StoreName}",
                    AccessLevel = "public",
                    ViewCount = s.ViewCount,
                    IsRevoked = s.IsRevoked,
                    ExpiresAt = s.ExpiresAt,
                    CreatedAt = s.CreatedAt,
                    // 知识库历史路径 /library/share/{token}，但 App.tsx 当前没有该 SPA 路由
                    //（debt -1），访客打开看到 SPA fallback。标 Viewable=false 如实告知用户。
                    PrimaryPath = $"/library/share/{s.Token}",
                    Viewable = false,
                });
            }
        }

        // ── 4. 工作流分享 ──
        if (wantType(ShortLinkTargetTypes.Workflow))
        {
            var f = Builders<ShareLink>.Filter.Eq(x => x.CreatedBy, userId);
            var list = await _db.ShareLinks.Find(f).ToListAsync(ct);
            foreach (var s in list)
            {
                if (!includeRevoked && s.IsRevoked) continue;
                rows.Add(new MyShareItem
                {
                    TargetType = ShortLinkTargetTypes.Workflow,
                    Token = s.Token,
                    Title = s.Title ?? "（未命名工作流分享）",
                    Subtitle = s.ResourceType,
                    AccessLevel = s.AccessLevel,
                    ViewCount = s.ViewCount,
                    IsRevoked = s.IsRevoked,
                    ExpiresAt = s.ExpiresAt,
                    CreatedAt = s.CreatedAt,
                    PrimaryPath = $"/s/{s.Token}",
                    // 工作流分享没有前端展示页（ShortLinkRouter 走 UnsupportedTargetError），
                    // 标 Viewable=false 告知用户链接暂不可用（详见 debt）。
                    Viewable = false,
                });
            }
        }

        // ── 5. 一次 In 查询 ShortLink 索引，补齐每条 share 的 Seq（用于"超短链"形态） ──
        var allTokens = rows.Select(r => r.Token).Distinct().ToList();
        if (allTokens.Count > 0)
        {
            var shortLinks = await _db.ShortLinks
                .Find(Builders<ShortLink>.Filter.In(x => x.TargetId, allTokens))
                .ToListAsync(ct);
            var byToken = shortLinks.ToDictionary(s => s.TargetId, s => s.Seq);
            foreach (var r in rows)
            {
                if (byToken.TryGetValue(r.Token, out var seq)) r.ShortSeq = seq;
            }
        }

        // ── 6. 倒序 + 返回 ──
        // byType 基于全量 allSorted（chip 计数恒为全量）；items 才按 targetType 过滤。
        var allSorted = rows.OrderByDescending(r => r.CreatedAt).ToList();
        var byType = allSorted.GroupBy(r => r.TargetType)
            .Select(g => new { targetType = g.Key, count = g.Count() })
            .ToList();
        var items = string.IsNullOrEmpty(targetType)
            ? allSorted
            : allSorted.Where(r => r.TargetType == targetType).ToList();
        return Ok(ApiResponse<object>.Ok(new
        {
            items,
            total = items.Count,
            byType,
        }));
    }
}

/// <summary>个人视角的分享统一记录（跨 4 类聚合后的形态）。</summary>
public class MyShareItem
{
    public string TargetType { get; set; } = string.Empty;
    public string Token { get; set; } = string.Empty;
    /// <summary>分配到的全局数字 Seq（0 表示该 share 尚未注册到 ShortLink，仅历史旧分享会出现）</summary>
    public long ShortSeq { get; set; }
    public string Title { get; set; } = string.Empty;
    public string? Subtitle { get; set; }
    public string AccessLevel { get; set; } = "public";
    public long ViewCount { get; set; }
    public bool IsRevoked { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public DateTime CreatedAt { get; set; }
    /// <summary>默认带分类前缀的主要 URL（前端拼 origin 后即为完整链接）</summary>
    public string PrimaryPath { get; set; } = string.Empty;
    /// <summary>该类型是否有可用的前端展示页。false = 链接打开看不到内容（历史 debt），前端应禁用打开/复制并提示"展示功能开发中"。</summary>
    public bool Viewable { get; set; } = true;
}
