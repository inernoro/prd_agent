using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 移动端仪表盘 — 为移动端 5-Tab 架构提供聚合数据。
///
/// 端点:
///   GET /api/mobile/feed     → 最近活动 Feed 流
///   GET /api/mobile/stats    → 使用统计卡片
///   GET /api/mobile/assets   → 聚合资产列表（通过 IAssetProvider 被动披露）
/// </summary>
[ApiController]
[Route("api/mobile")]
[Authorize]
public class MobileDashboardController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<MobileDashboardController> _logger;
    private readonly IEnumerable<IAssetProvider> _assetProviders;

    public MobileDashboardController(
        MongoDbContext db,
        ILogger<MobileDashboardController> logger,
        IEnumerable<IAssetProvider> assetProviders)
    {
        _db = db;
        _logger = logger;
        _assetProviders = assetProviders;
    }

    private string GetUserId() =>
        User.FindFirst("sub")?.Value
        ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? "unknown";

    // ─────────────────────────────────────────
    //  GET /api/mobile/feed — 最近活动 Feed 流
    // ─────────────────────────────────────────

    /// <summary>
    /// 聚合用户近期活动：PRD 会话、视觉创作工作区、缺陷报告，按时间倒序合并。
    /// </summary>
    [HttpGet("feed")]
    public async Task<IActionResult> GetFeed([FromQuery] int limit = 20)
    {
        var userId = GetUserId();
        limit = Math.Clamp(limit, 1, 50);

        var feedItems = new List<object>();

        // 1) PRD 会话 (sessions)
        try
        {
            var sessions = await _db.Sessions
                .Find(s => s.OwnerUserId == userId && s.DeletedAtUtc == null && s.ArchivedAtUtc == null)
                .SortByDescending(s => s.LastActiveAt)
                .Limit(limit)
                .ToListAsync();

            foreach (var s in sessions)
            {
                feedItems.Add(new
                {
                    id = s.SessionId,
                    type = "prd-session",
                    title = s.Title ?? "PRD 会话",
                    subtitle = "PRD Agent",
                    updatedAt = s.LastActiveAt,
                    navigateTo = $"/prd-agent",
                });
            }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Feed: failed to load PRD sessions"); }

        // 2) 视觉创作工作区
        try
        {
            var workspaces = await _db.ImageMasterWorkspaces
                .Find(w => w.OwnerUserId == userId)
                .SortByDescending(w => w.UpdatedAt)
                .Limit(limit)
                .ToListAsync();

            foreach (var w in workspaces)
            {
                feedItems.Add(new
                {
                    id = w.Id,
                    type = "visual-workspace",
                    title = w.Title ?? "未命名工作区",
                    subtitle = "视觉创作",
                    updatedAt = w.UpdatedAt,
                    navigateTo = $"/visual-agent/{w.Id}",
                    coverAssetId = w.CoverAssetIds?.FirstOrDefault(),
                });
            }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Feed: failed to load visual workspaces"); }

        // 3) 缺陷报告
        try
        {
            var defects = await _db.DefectReports
                .Find(d => d.ReporterId == userId)
                .SortByDescending(d => d.UpdatedAt)
                .Limit(limit)
                .ToListAsync();

            foreach (var d in defects)
            {
                feedItems.Add(new
                {
                    id = d.Id,
                    type = "defect",
                    title = d.Title ?? d.DefectNo ?? "缺陷报告",
                    subtitle = $"缺陷管理 · {d.Status}",
                    updatedAt = d.UpdatedAt,
                    navigateTo = "/defect-agent",
                });
            }
        }
        catch (Exception ex) { _logger.LogWarning(ex, "Feed: failed to load defect reports"); }

        // 按时间倒序排列并截取
        var sorted = feedItems
            .OrderByDescending(item =>
            {
                var prop = item.GetType().GetProperty("updatedAt");
                return prop?.GetValue(item) as DateTime? ?? DateTime.MinValue;
            })
            .Take(limit)
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { items = sorted }));
    }

    // ─────────────────────────────────────────
    //  GET /api/mobile/stats — 使用统计卡片
    // ─────────────────────────────────────────

    /// <summary>
    /// 返回用户今日 / 近 7 日的使用统计。
    /// </summary>
    [HttpGet("stats")]
    public async Task<IActionResult> GetStats([FromQuery] int days = 7)
    {
        var userId = GetUserId();
        days = Math.Clamp(days, 1, 30);
        var since = DateTime.UtcNow.Date.AddDays(-days + 1);

        // 会话数
        var sessionCount = await _db.Sessions
            .CountDocumentsAsync(s => s.OwnerUserId == userId && s.CreatedAt >= since);

        // 消息数（用户发送的）
        var messageCount = await _db.Messages
            .CountDocumentsAsync(m => m.SenderId == userId && m.Timestamp >= since);

        // 生图任务数
        var imageGenCount = await _db.ImageGenRuns
            .CountDocumentsAsync(r => r.OwnerAdminId == userId && r.CreatedAt >= since);

        // Token 使用量（LLM 请求日志）
        var tokenFilter = Builders<LlmRequestLog>.Filter.Eq(l => l.UserId, userId)
                        & Builders<LlmRequestLog>.Filter.Gte(l => l.StartedAt, since);
        var tokenAgg = await _db.LlmRequestLogs
            .Find(tokenFilter)
            .Project(l => new { input = l.InputTokens ?? 0, output = l.OutputTokens ?? 0 })
            .ToListAsync();
        var totalTokens = tokenAgg.Sum(t => (long)t.input + t.output);

        return Ok(ApiResponse<object>.Ok(new
        {
            days,
            sessions = sessionCount,
            messages = messageCount,
            imageGenerations = imageGenCount,
            totalTokens,
        }));
    }

    // ─────────────────────────────────────────
    //  GET /api/mobile/assets — 聚合资产列表
    // ─────────────────────────────────────────

    /// <summary>
    /// 聚合用户所有产出物，通过 IAssetProvider 被动披露。
    /// 新模块只需实现 IAssetProvider 并注册 DI，即可自动出现在此列表中。
    /// </summary>
    [HttpGet("assets")]
    public async Task<IActionResult> GetAssets(
        [FromQuery] string? category = null,   // image | document | attachment | null(all)
        [FromQuery] int limit = 30,
        [FromQuery] int skip = 0,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        limit = Math.Clamp(limit, 1, 100);
        skip = Math.Max(skip, 0);

        // 用较大上限收集所有 Provider 的资产（保证计数准确）
        const int internalLimit = 500;
        var allAssets = new List<UnifiedAsset>();

        foreach (var provider in _assetProviders)
        {
            try
            {
                var items = await provider.GetAssetsAsync(userId, internalLimit, ct);
                allAssets.AddRange(items);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Assets: failed to load from {Source}", provider.Source);
            }
        }

        // ── 全局统计（始终基于全量数据，不受 category 参数影响） ──
        var categoryCounts = new Dictionary<string, int>
        {
            ["image"] = allAssets.Count(a => a.Type == "image"),
            ["document"] = allAssets.Count(a => a.Type == "document"),
            ["attachment"] = allAssets.Count(a => a.Type == "attachment"),
            ["webpage"] = allAssets.Count(a => a.Type == "webpage"),
        };
        var totalSizeBytes = allAssets.Sum(a => a.SizeBytes);

        // 来源分布
        var sourceCounts = allAssets
            .Where(a => !string.IsNullOrEmpty(a.Source))
            .GroupBy(a => a.Source)
            .ToDictionary(g => g.Key, g => g.Count());

        // 最近活动时间
        var latestActivity = allAssets.Count > 0
            ? allAssets.Max(a => a.CreatedAt)
            : (DateTime?)null;

        // ── 按 category 过滤（仅影响 items 分页，不影响统计） ──
        var filtered = category != null
            ? allAssets.Where(a => a.Type == category).ToList()
            : allAssets;

        // 按时间排序 + 分页
        var sorted = filtered
            .OrderByDescending(a => a.CreatedAt)
            .Skip(skip)
            .Take(limit)
            .ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            items = sorted,
            total = filtered.Count,
            hasMore = filtered.Count > skip + limit,
            categoryCounts,
            totalSizeBytes,
            sourceCounts,
            latestActivity,
        }));
    }
}
