using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
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
    private readonly MongoDbContext _gatewayDb;
    private readonly ILogger<MobileDashboardController> _logger;
    private readonly IEnumerable<IAssetProvider> _assetProviders;

    public MobileDashboardController(
        MongoDbContext db,
        LlmGatewayDataContext gatewayData,
        ILogger<MobileDashboardController> logger,
        IEnumerable<IAssetProvider> assetProviders)
    {
        _db = db;
        _gatewayDb = gatewayData.Context;
        _logger = logger;
        _assetProviders = assetProviders;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>
    /// 视觉创作与文学创作共用 image_master_workspaces 集合，首页动态必须按场景区分入口。
    /// 否则 MCP 创建的文学工作区会被硬编码成视觉创作，点击后进入错误编辑器。
    /// 未知场景沿用视觉创作，保持既有工作区的兼容行为。
    /// </summary>
    // ─────────────────────────────────────────
    //  GET /api/mobile/feed — 最近活动 Feed 流
    // ─────────────────────────────────────────

    /// <summary>
    /// 聚合用户近期活动：视觉创作工作区、缺陷报告，按时间倒序合并。
    ///
    /// 不含 PRD 会话——PRD 解读智能体 Web 端已下线（前端把 /prd-agent 整条重定向回首页），
    /// 列出来只会得到一条点了没反应的条目；更糟的是它会占掉 limit 名额，
    /// 把真正能点的动态挤出这一页。
    ///
    /// 单个来源查询失败时不整体 500（另一个来源的动态照常可用），但**必须把失败如实
    /// 报出去**：`degradedSources` 列出没取到的来源。全都失败时结果是空列表，
    /// 前端若只看 HTTP 成不成功，就会把"服务挂了"渲染成"你还没用过"。
    /// </summary>
    [HttpGet("feed")]
    public async Task<IActionResult> GetFeed([FromQuery] int limit = 20)
    {
        var userId = GetUserId();
        limit = Math.Clamp(limit, 1, 50);

        var feedItems = new List<object>();
        // 哪些来源没取到——空列表到底是"真的没有"还是"查挂了"，只有这里知道
        var degradedSources = new List<string>();

        // 1) 视觉 / 文学工作区（两者共用 image_master_workspaces，按 ScenarioType 分流）
        try
        {
            var workspaces = await _db.ImageMasterWorkspaces
                .Find(w => w.OwnerUserId == userId)
                .SortByDescending(w => w.UpdatedAt)
                .Limit(limit)
                .ToListAsync();

            foreach (var w in workspaces)
            {
                var target = ImageMasterWorkspacePresentation.Resolve(w.Id, w.ScenarioType);
                feedItems.Add(new
                {
                    id = w.Id,
                    type = target.FeedType,
                    title = w.Title ?? "未命名工作区",
                    subtitle = target.Subtitle,
                    updatedAt = w.UpdatedAt,
                    navigateTo = target.Route,
                    coverAssetId = w.CoverAssetIds?.FirstOrDefault(),
                });
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Feed: failed to load visual workspaces");
            degradedSources.Add("visual-workspace");
        }

        // 2) 缺陷报告
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
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Feed: failed to load defect reports");
            degradedSources.Add("defect");
        }

        // 按时间倒序排列并截取
        var sorted = feedItems
            .OrderByDescending(item =>
            {
                var prop = item.GetType().GetProperty("updatedAt");
                return prop?.GetValue(item) as DateTime? ?? DateTime.MinValue;
            })
            .Take(limit)
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { items = sorted, degradedSources }));
    }

    // ─────────────────────────────────────────
    //  GET /api/mobile/stats — 使用统计卡片
    // ─────────────────────────────────────────

    /// <summary>
    /// 返回用户今日 / 近 7 日的使用统计（聚合值 + 按日序列,供首页迷你趋势图）。
    /// tzOffsetMinutes 取 JS 的 Date.getTimezoneOffset() 约定（UTC+8 → -480）,
    /// 日界按用户本地时区切,否则东八区用户早八点前"今天"恒为 0。
    /// </summary>
    [HttpGet("stats")]
    public async Task<IActionResult> GetStats([FromQuery] int days = 7, [FromQuery] int tzOffsetMinutes = 0)
    {
        var userId = GetUserId();
        days = Math.Clamp(days, 1, 30);
        tzOffsetMinutes = Math.Clamp(tzOffsetMinutes, -840, 840);

        // 本地日界 → UTC 窗口起点
        var localToday = DateTime.UtcNow.AddMinutes(-tzOffsetMinutes).Date;
        var localSince = localToday.AddDays(-days + 1);
        var since = localSince.AddMinutes(tzOffsetMinutes);

        DateTime LocalDay(DateTime utc) => utc.AddMinutes(-tzOffsetMinutes).Date;

        // 会话（只取时间戳,在内存按本地日分桶——单用户 7 日量级很小）
        var sessionTimes = await _db.Sessions
            .Find(s => s.OwnerUserId == userId && s.CreatedAt >= since)
            .Project(s => new { s.CreatedAt })
            .ToListAsync();

        // 消息（用户发送的）
        var messageTimes = await _db.Messages
            .Find(m => m.SenderId == userId && m.Timestamp >= since)
            .Project(m => new { m.Timestamp })
            .ToListAsync();

        // 生图任务
        var imageGenTimes = await _db.ImageGenRuns
            .Find(r => r.OwnerAdminId == userId && r.CreatedAt >= since)
            .Project(r => new { r.CreatedAt })
            .ToListAsync();

        // Token 使用量 + AI 调用次数（LLM 请求日志,一次查询两用）
        var tokenFilter = Builders<LlmRequestLog>.Filter.Eq(l => l.UserId, userId)
                        & Builders<LlmRequestLog>.Filter.Gte(l => l.StartedAt, since);
        var legacyTokenTask = _db.LlmRequestLogs
            .Find(tokenFilter)
            .Project(l => new LlmUsagePoint
            {
                Id = l.Id,
                RequestId = l.RequestId,
                StartedAt = l.StartedAt,
                Input = l.InputTokens ?? 0,
                Output = l.OutputTokens ?? 0,
            })
            .ToListAsync();
        var gatewayTokenTask = _gatewayDb.LlmRequestLogs
            .Find(tokenFilter)
            .Project(l => new LlmUsagePoint
            {
                Id = l.Id,
                RequestId = l.RequestId,
                StartedAt = l.StartedAt,
                Input = l.InputTokens ?? 0,
                Output = l.OutputTokens ?? 0,
            })
            .ToListAsync();
        await Task.WhenAll(legacyTokenTask, gatewayTokenTask);

        // llmgw 独立部署后，请求日志的权威库是 llm_gateway；迁移前以及少量进程内调用
        // 仍可能留在 MAP 主库。两边都读并按请求标识去重，避免正式环境首页恒为 0，
        // 也避免同一条日志在迁移双写期间被统计两次。gateway 放前面，冲突时采用权威记录。
        var tokenAgg = MergeLlmUsage(gatewayTokenTask.Result, legacyTokenTask.Result);
        var totalTokens = tokenAgg.Sum(t => (long)t.Input + t.Output);

        // 缺陷提报（当前高频使用的模块;会话/消息是桌面 PRD 解读时代口径,保留字段兼容但前端已换指标）
        var defectTimes = await _db.DefectReports
            .Find(d => d.ReporterId == userId && d.CreatedAt >= since && !d.IsDeleted)
            .Project(d => new { d.CreatedAt })
            .ToListAsync();

        // 按本地日分桶,补零成完整 days 天(旧→新)
        var sessionsByDay = sessionTimes.GroupBy(x => LocalDay(x.CreatedAt)).ToDictionary(g => g.Key, g => g.Count());
        var messagesByDay = messageTimes.GroupBy(x => LocalDay(x.Timestamp)).ToDictionary(g => g.Key, g => g.Count());
        var imageGensByDay = imageGenTimes.GroupBy(x => LocalDay(x.CreatedAt)).ToDictionary(g => g.Key, g => g.Count());
        var aiCallsByDay = tokenAgg.GroupBy(x => LocalDay(x.StartedAt)).ToDictionary(g => g.Key, g => g.Count());
        var defectsByDay = defectTimes.GroupBy(x => LocalDay(x.CreatedAt)).ToDictionary(g => g.Key, g => g.Count());
        var tokensByDay = tokenAgg.GroupBy(x => LocalDay(x.StartedAt)).ToDictionary(g => g.Key, g => g.Sum(t => (long)t.Input + t.Output));

        var daily = Enumerable.Range(0, days)
            .Select(i =>
            {
                var day = localSince.AddDays(i);
                return new
                {
                    date = day.ToString("yyyy-MM-dd"),
                    sessions = sessionsByDay.GetValueOrDefault(day),
                    messages = messagesByDay.GetValueOrDefault(day),
                    imageGenerations = imageGensByDay.GetValueOrDefault(day),
                    aiCalls = aiCallsByDay.GetValueOrDefault(day),
                    defects = defectsByDay.GetValueOrDefault(day),
                    tokens = tokensByDay.GetValueOrDefault(day),
                };
            })
            .ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            days,
            sessions = sessionTimes.Count,
            messages = messageTimes.Count,
            imageGenerations = imageGenTimes.Count,
            aiCalls = tokenAgg.Count,
            defects = defectTimes.Count,
            totalTokens,
            daily,
        }));
    }

    internal sealed class LlmUsagePoint
    {
        public string Id { get; init; } = string.Empty;
        public string RequestId { get; init; } = string.Empty;
        public DateTime StartedAt { get; init; }
        public int Input { get; init; }
        public int Output { get; init; }
    }

    internal static List<LlmUsagePoint> MergeLlmUsage(
        IEnumerable<LlmUsagePoint> gateway,
        IEnumerable<LlmUsagePoint> legacy)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var merged = new List<LlmUsagePoint>();

        foreach (var item in gateway.Concat(legacy))
        {
            var key = !string.IsNullOrWhiteSpace(item.RequestId)
                ? $"request:{item.RequestId}"
                : !string.IsNullOrWhiteSpace(item.Id)
                    ? $"document:{item.Id}"
                    : $"anonymous:{item.StartedAt.Ticks}:{item.Input}:{item.Output}:{merged.Count}";
            if (seen.Add(key)) merged.Add(item);
        }

        return merged;
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
