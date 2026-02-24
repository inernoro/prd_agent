using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 移动端仪表盘 — 为移动端 5-Tab 架构提供聚合数据。
///
/// 端点:
///   GET /api/mobile/feed     → 最近活动 Feed 流
///   GET /api/mobile/stats    → 使用统计卡片
///   GET /api/mobile/assets   → 聚合资产列表
/// </summary>
[ApiController]
[Route("api/mobile")]
[Authorize]
public class MobileDashboardController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<MobileDashboardController> _logger;

    public MobileDashboardController(MongoDbContext db, ILogger<MobileDashboardController> logger)
    {
        _db = db;
        _logger = logger;
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
    /// 聚合用户所有产出物：图片资产 + 附件 + 缺陷附件，按时间倒序，支持分类过滤。
    /// </summary>
    [HttpGet("assets")]
    public async Task<IActionResult> GetAssets(
        [FromQuery] string? category = null,   // image | document | attachment | null(all)
        [FromQuery] int limit = 30,
        [FromQuery] int skip = 0)
    {
        var userId = GetUserId();
        limit = Math.Clamp(limit, 1, 100);
        skip = Math.Max(skip, 0);

        var assets = new List<object>();

        // 1) 图片资产 (ImageAsset)
        if (category is null or "image")
        {
            try
            {
                var images = await _db.ImageAssets
                    .Find(a => a.OwnerUserId == userId)
                    .SortByDescending(a => a.CreatedAt)
                    .Limit(limit)
                    .ToListAsync();

                foreach (var img in images)
                {
                    assets.Add(new
                    {
                        id = $"img-{img.Id}",
                        type = "image",
                        title = img.Prompt ?? "生成图片",
                        url = img.Url,
                        thumbnailUrl = img.Url,
                        mime = img.Mime,
                        width = img.Width,
                        height = img.Height,
                        sizeBytes = img.SizeBytes,
                        createdAt = img.CreatedAt,
                        workspaceId = img.WorkspaceId,
                    });
                }
            }
            catch (Exception ex) { _logger.LogWarning(ex, "Assets: failed to load images"); }
        }

        // 2) 附件 (Attachment) — 用户上传的文件
        if (category is null or "attachment" or "document")
        {
            try
            {
                var attachments = await _db.Attachments
                    .Find(a => a.UploaderId == userId)
                    .SortByDescending(a => a.UploadedAt)
                    .Limit(limit)
                    .ToListAsync();

                foreach (var att in attachments)
                {
                    var isDoc = att.MimeType.Contains("pdf") || att.MimeType.Contains("text")
                             || att.MimeType.Contains("document") || att.MimeType.Contains("word");
                    var assetType = isDoc ? "document" : "attachment";

                    if (category != null && category != assetType) continue;

                    assets.Add(new
                    {
                        id = $"att-{att.AttachmentId}",
                        type = assetType,
                        title = att.FileName,
                        url = att.Url,
                        thumbnailUrl = att.ThumbnailUrl,
                        mime = att.MimeType,
                        width = 0,
                        height = 0,
                        sizeBytes = att.Size,
                        createdAt = att.UploadedAt,
                        workspaceId = (string?)null,
                    });
                }
            }
            catch (Exception ex) { _logger.LogWarning(ex, "Assets: failed to load attachments"); }
        }

        // 按时间排序 + 分页
        var sorted = assets
            .OrderByDescending(item =>
            {
                var prop = item.GetType().GetProperty("createdAt");
                return prop?.GetValue(item) as DateTime? ?? DateTime.MinValue;
            })
            .Skip(skip)
            .Take(limit)
            .ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            items = sorted,
            total = assets.Count,
            hasMore = assets.Count > skip + limit,
        }));
    }
}
