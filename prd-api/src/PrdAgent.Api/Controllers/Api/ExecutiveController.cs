using System.Linq.Expressions;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 总裁面板 - 全景数据控制器
/// </summary>
[ApiController]
[Route("api/executive")]
[Authorize]
[AdminController("executive", AdminPermissionCatalog.ExecutiveRead)]
public class ExecutiveController : ControllerBase
{
    private readonly MongoDbContext _db;

    /// <summary>
    /// AppCallerCode 前缀归一化：将 LLM 日志中的别名映射到标准 appKey
    /// </summary>
    private static readonly Dictionary<string, string> AppKeyAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        { "prd-agent-desktop", "prd-agent" },
        { "prd-agent-web", "prd-agent" },
        { "open-platform-agent", "open-platform" },
        { "workflow-agent", "ai-toolbox" },
        { "tutorial-email", "ai-toolbox" },
    };

    /// <summary>
    /// 已知的合法 Agent appKey（用于过滤脏数据，不在此列表中的归入 "admin"）
    /// </summary>
    private static readonly HashSet<string> KnownAgentKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "prd-agent", "visual-agent", "literary-agent", "defect-agent",
        "ai-toolbox", "open-platform", "report-agent", "video-agent",
    };

    /// <summary>
    /// 从原始 AppCallerCode 前缀提取并归一化 appKey
    /// </summary>
    private static string NormalizeAppKey(string appCallerCode, bool fallbackToAdmin = true)
    {
        var dotIndex = appCallerCode.IndexOf('.');
        var key = dotIndex > 0 ? appCallerCode[..dotIndex] : appCallerCode;
        if (AppKeyAliases.TryGetValue(key, out var normalized)) key = normalized;
        if (fallbackToAdmin && !KnownAgentKeys.Contains(key)) key = "admin";
        return key;
    }

    public ExecutiveController(MongoDbContext db)
    {
        _db = db;
    }

    /// <summary>
    /// 服务端聚合：$match + $group by 用户字段 → { userId: count }。
    /// 关键点：分组在 MongoDB 内完成，只把 (userId,count) 拉回，
    /// 不再 Find().ToListAsync() 把整个大集合搬进内存。
    /// </summary>
    private static async Task<Dictionary<string, int>> CountByUserAsync<T>(
        IMongoCollection<T> col,
        Expression<Func<T, bool>> match,
        Expression<Func<T, string?>> userKey,
        HashSet<string> userIds)
    {
        var grouped = await col.Aggregate()
            .Match(match)
            .Group(userKey, g => new { Uid = g.Key, C = g.Count() })
            .ToListAsync();

        var dict = new Dictionary<string, int>();
        foreach (var row in grouped)
        {
            if (string.IsNullOrEmpty(row.Uid) || !userIds.Contains(row.Uid)) continue;
            dict[row.Uid] = row.C;
        }
        return dict;
    }

    /// <summary>
    /// 维度口径元数据（SSOT）：前端问号 tooltip 直接渲染这些文案，
    /// 不在前端硬编码。desc=怎么算的 / how=怎么操作会+1 / anomaly=排除了什么异常。
    /// </summary>
    private static readonly Dictionary<string, (string Desc, string How, string Anomaly)> DimMeta =
        new(StringComparer.OrdinalIgnoreCase)
    {
        ["prd-agent"]          = ("PRD 解读 Agent 的使用次数（LLM 对话 + 写操作合计）", "在 PRD 解读中发起对话或执行操作", "已排除 Bot 账号与匿名请求"),
        ["visual-agent"]       = ("视觉创作 Agent 的使用次数（LLM + 写操作合计）", "在视觉创作中生成或编辑作品", "已排除 Bot 账号与匿名请求"),
        ["literary-agent"]     = ("文学创作 Agent 的使用次数（LLM + 写操作合计）", "在文学创作中发起创作", "已排除 Bot 账号与匿名请求"),
        ["ai-toolbox"]         = ("AI 百宝箱使用次数：工作流执行、教程邮件等百宝箱内工具的调用", "在百宝箱中运行工作流或使用其中的工具", "已排除 Bot 账号与匿名请求"),
        ["report-agent"]       = ("周报 Agent 的使用次数（LLM + 写操作合计）", "在周报中生成或提交周报", "已排除 Bot 账号与匿名请求"),
        ["video-agent"]        = ("视频 Agent 的使用次数（LLM + 写操作合计）", "在视频生成中发起任务", "已排除 Bot 账号与匿名请求"),
        ["defects"]            = ("真实缺陷贡献 = 你提交的缺陷数 + 你解决的缺陷数", "在缺陷管理中提交新缺陷，或把缺陷标记为已解决", "只统计真实提交/解决；未解决的缺陷不计入解决数，已排除 Bot 账号"),
        ["images"]             = ("名下生成的图片总数（所有来源合计）", "在视觉或文学创作中生成图片", "已排除 Bot 账号"),
        ["image-gen-visual"]   = ("视觉创作 AI 生图的成功次数", "在视觉创作中成功生成图片", "只统计成功完成的生图，失败或排队中的不计入"),
        ["image-gen-literary"] = ("文学创作配图的成功次数", "在文学创作中成功生成配图", "只统计成功完成的生图"),
        ["image-upload"]       = ("上传的参考图数量", "在创作中上传参考图", "只统计参考图（input_image），不含生成结果"),
        ["workflows"]          = ("触发的工作流执行次数", "在百宝箱中运行工作流", "已排除 Bot 账号"),
        ["arena"]              = ("模型竞技场的对战次数", "在模型竞技场发起对战", "已排除 Bot 账号"),
    };

    private static object MakeDim(string key, string name, string category,
        Dictionary<string, int> values, object? subValues = null)
    {
        DimMeta.TryGetValue(key, out var m);
        if (subValues == null)
            return new { key, name, category, values, description = m.Desc ?? "", howToIncrease = m.How ?? "", anomalyNote = m.Anomaly ?? "" };
        return new { key, name, category, values, description = m.Desc ?? "", howToIncrease = m.How ?? "", anomalyNote = m.Anomaly ?? "", subValues };
    }

    /// <summary>
    /// 全局概览 KPI
    /// </summary>
    [HttpGet("overview")]
    public async Task<IActionResult> GetOverview([FromQuery] int days = 0)
    {
        if (days < 0) days = 0;
        var now = DateTime.UtcNow;
        var today = now.Date;
        var periodStart = days > 0 ? today.AddDays(-days + 1) : DateTime.MinValue;
        var prevPeriodStart = days > 0 ? periodStart.AddDays(-days) : DateTime.MinValue;

        // 用户统计
        var totalUsers = await _db.Users.CountDocumentsAsync(_ => true);
        var activeUsers = await _db.Users.CountDocumentsAsync(u => u.LastActiveAt >= periodStart);
        var prevActiveUsers = await _db.Users.CountDocumentsAsync(u => u.LastActiveAt >= prevPeriodStart && u.LastActiveAt < periodStart);

        // 本期消息数 (合并 PRD 对话 + 缺陷消息 + 视觉创作消息)
        var prdMessages = await _db.Messages.CountDocumentsAsync(m => m.Timestamp >= periodStart);
        var defectMsgCount = await _db.DefectMessages.CountDocumentsAsync(m => m.CreatedAt >= periodStart);
        var visualMsgCount = await _db.ImageMasterMessages.CountDocumentsAsync(m => m.CreatedAt >= periodStart);
        var periodMessages = prdMessages + defectMsgCount + visualMsgCount;

        var prevPrdMessages = await _db.Messages.CountDocumentsAsync(m => m.Timestamp >= prevPeriodStart && m.Timestamp < periodStart);
        var prevDefectMsgCount = await _db.DefectMessages.CountDocumentsAsync(m => m.CreatedAt >= prevPeriodStart && m.CreatedAt < periodStart);
        var prevVisualMsgCount = await _db.ImageMasterMessages.CountDocumentsAsync(m => m.CreatedAt >= prevPeriodStart && m.CreatedAt < periodStart);
        var prevMessages = prevPrdMessages + prevDefectMsgCount + prevVisualMsgCount;

        // 本期 Token 用量 (from messages)
        var tokenFilter = Builders<Message>.Filter.Gte(m => m.Timestamp, periodStart) &
                          Builders<Message>.Filter.Eq(m => m.Role, MessageRole.Assistant) &
                          Builders<Message>.Filter.Ne(m => m.TokenUsage, null);
        var tokenItems = await _db.Messages
            .Find(tokenFilter)
            .Project(m => new { input = m.TokenUsage!.Input, output = m.TokenUsage!.Output })
            .ToListAsync();
        var periodTokens = tokenItems.Sum(t => (long)t.input + t.output);

        var prevTokenFilter = Builders<Message>.Filter.Gte(m => m.Timestamp, prevPeriodStart) &
                              Builders<Message>.Filter.Lt(m => m.Timestamp, periodStart) &
                              Builders<Message>.Filter.Eq(m => m.Role, MessageRole.Assistant) &
                              Builders<Message>.Filter.Ne(m => m.TokenUsage, null);
        var prevTokenItems = await _db.Messages
            .Find(prevTokenFilter)
            .Project(m => new { input = m.TokenUsage!.Input, output = m.TokenUsage!.Output })
            .ToListAsync();
        var prevTokens = prevTokenItems.Sum(t => (long)t.input + t.output);

        // LLM 调用数 (from llm_request_logs)
        var llmCalls = await _db.LlmRequestLogs.CountDocumentsAsync(l => l.StartedAt >= periodStart);

        // 缺陷统计
        var totalDefects = await _db.DefectReports.CountDocumentsAsync(_ => true);
        var resolvedDefects = await _db.DefectReports.CountDocumentsAsync(d => d.Status == DefectStatus.Resolved || d.Status == DefectStatus.Closed);
        var defectResolutionRate = totalDefects > 0 ? Math.Round((double)resolvedDefects / totalDefects * 100, 1) : 0;

        // 图片生成数
        var periodImages = await _db.ImageGenRuns.CountDocumentsAsync(r => r.CreatedAt >= periodStart);

        return Ok(ApiResponse<object>.Ok(new
        {
            totalUsers,
            activeUsers,
            prevActiveUsers,
            periodMessages,
            prevMessages,
            periodTokens,
            prevTokens,
            llmCalls,
            totalDefects,
            resolvedDefects,
            defectResolutionRate,
            periodImages,
            days,
        }));
    }

    /// <summary>
    /// 每日使用趋势
    /// </summary>
    [HttpGet("trends")]
    public async Task<IActionResult> GetTrends([FromQuery] int days = 90)
    {
        if (days <= 0) days = 90; // 趋势图不支持全部时间，默认 90 天
        days = Math.Clamp(days, 7, 365);
        var startDate = DateTime.UtcNow.Date.AddDays(-days + 1);

        // 消息按天 (合并三个消息集合)
        var prdMsgs = await _db.Messages.Find(m => m.Timestamp >= startDate)
            .Project(m => new { m.Timestamp })
            .ToListAsync();
        var defectMsgs = await _db.DefectMessages.Find(m => m.CreatedAt >= startDate)
            .Project(m => new { Timestamp = m.CreatedAt })
            .ToListAsync();
        var visualMsgs = await _db.ImageMasterMessages.Find(m => m.CreatedAt >= startDate)
            .Project(m => new { Timestamp = m.CreatedAt })
            .ToListAsync();
        var messages = prdMsgs.Concat(defectMsgs).Concat(visualMsgs).ToList();

        // Token 按天
        var tokenFilter = Builders<Message>.Filter.Gte(m => m.Timestamp, startDate) &
                          Builders<Message>.Filter.Eq(m => m.Role, MessageRole.Assistant) &
                          Builders<Message>.Filter.Ne(m => m.TokenUsage, null);
        var tokens = await _db.Messages.Find(tokenFilter)
            .Project(m => new { m.Timestamp, input = m.TokenUsage!.Input, output = m.TokenUsage!.Output })
            .ToListAsync();

        var trend = Enumerable.Range(0, days)
            .Select(i => startDate.AddDays(i))
            .Select(date => new
            {
                date = date.ToString("yyyy-MM-dd"),
                messages = messages.Count(m => m.Timestamp.Date == date),
                tokens = tokens.Where(t => t.Timestamp.Date == date).Sum(t => t.input + t.output),
            })
            .ToList();

        return Ok(ApiResponse<object>.Ok(trend));
    }

    /// <summary>
    /// 团队成员洞察
    /// </summary>
    [HttpGet("team")]
    public async Task<IActionResult> GetTeam([FromQuery] int days = 0)
    {
        if (days < 0) days = 0;
        var periodStart = days > 0 ? DateTime.UtcNow.Date.AddDays(-days + 1) : DateTime.MinValue;

        var users = await _db.Users.Find(_ => true).ToListAsync();
        var humanUsers = users.Where(u => u.UserType != UserType.Bot).ToList();
        var userIds = humanUsers.Select(u => u.UserId).ToHashSet();

        // 每个指标一次服务端 $group，彻底消除原来的 per-user N+1（用户数 × 5 次查询）
        var messagesByUser = await CountByUserAsync(_db.Messages,
            m => m.Timestamp >= periodStart, m => m.SenderId, userIds);
        var sessionsByUser = await CountByUserAsync(_db.Sessions,
            s => s.CreatedAt >= periodStart, s => s.OwnerUserId, userIds);
        var defectsCreatedByUser = await CountByUserAsync(_db.DefectReports,
            d => d.CreatedAt >= periodStart, d => d.ReporterId, userIds);
        // 口径修正：未解决的缺陷 ResolvedById/ResolvedAt 为 null，原 `ResolvedAt >= MinValue`
        // 在 days=0 时会把未解决缺陷也算进"已解决"。显式要求 ResolvedById/ResolvedAt 非空。
        var defectsResolvedByUser = await CountByUserAsync(_db.DefectReports,
            d => d.ResolvedById != null && d.ResolvedAt != null && d.ResolvedAt >= periodStart,
            d => d.ResolvedById, userIds);
        var imageRunsByUser = await CountByUserAsync(_db.ImageGenRuns,
            r => r.CreatedAt >= periodStart, r => r.OwnerAdminId, userIds);

        var result = humanUsers.Select(user => (object)new
        {
            userId = user.UserId,
            username = user.Username,
            displayName = user.DisplayName ?? user.Username,
            role = user.Role.ToString(),
            avatarFileName = user.AvatarFileName,
            lastActiveAt = user.LastActiveAt,
            isActive = user.LastActiveAt >= periodStart,
            messages = messagesByUser.GetValueOrDefault(user.UserId),
            sessions = sessionsByUser.GetValueOrDefault(user.UserId),
            defectsCreated = defectsCreatedByUser.GetValueOrDefault(user.UserId),
            defectsResolved = defectsResolvedByUser.GetValueOrDefault(user.UserId),
            imageRuns = imageRunsByUser.GetValueOrDefault(user.UserId),
        }).ToList();

        var sorted = result.OrderByDescending(u => ((dynamic)u).messages).ToList();
        return Ok(ApiResponse<object>.Ok(sorted));
    }

    /// <summary>
    /// Agent 使用统计
    /// </summary>
    [HttpGet("agents")]
    public async Task<IActionResult> GetAgents([FromQuery] int days = 0)
    {
        if (days < 0) days = 0;
        var periodStart = days > 0 ? DateTime.UtcNow.Date.AddDays(-days + 1) : DateTime.MinValue;

        // 已知 Agent 路由前缀 → appKey 映射
        var agentRoutePrefixes = new Dictionary<string, string>
        {
            { "/api/prd-agent/", "prd-agent" },
            { "/api/visual-agent/", "visual-agent" },
            { "/api/literary-agent/", "literary-agent" },
            { "/api/defect-agent/", "defect-agent" },
            { "/api/ai-toolbox/", "ai-toolbox" },
            { "/api/open-platform/", "open-platform" },
            { "/api/v1/open-platform/", "open-platform" }, // 开放平台 Chat API (OpenPlatformChatController)
            { "/api/report-agent/", "report-agent" },
            { "/api/video-agent/", "video-agent" },
        };

        // ── 1. LLM 调用统计 (llm_request_logs) ──
        var llmLogs = await _db.LlmRequestLogs
            .Find(l => l.StartedAt >= periodStart && l.AppCallerCode != null)
            .Project(l => new
            {
                l.AppCallerCode,
                l.UserId,
                l.InputTokens,
                l.OutputTokens,
                l.DurationMs,
            })
            .ToListAsync();

        var llmByAgent = llmLogs
            .GroupBy(l => NormalizeAppKey(l.AppCallerCode ?? ""))
            .Where(g => !string.IsNullOrEmpty(g.Key))
            .ToDictionary(g => g.Key, g =>
            {
                var withDuration = g.Where(l => l.DurationMs.HasValue).ToList();
                return new
                {
                    llmCalls = g.Count(),
                    llmUsers = g.Select(l => l.UserId).Where(u => u != null).Distinct().Count(),
                    tokens = g.Sum(l => (long)(l.InputTokens ?? 0) + (l.OutputTokens ?? 0)),
                    avgDurationMs = withDuration.Count > 0 ? withDuration.Average(l => l.DurationMs!.Value) : 0d,
                };
            });

        // ── 2. API 调用统计 (api_request_logs) ──
        // 只查写操作 (POST/PUT/DELETE)，排除纯读取 GET 请求，更能反映真实使用量
        var apiLogs = await _db.ApiRequestLogs
            .Find(l => l.StartedAt >= periodStart
                        && l.Method != "GET"
                        && l.StatusCode >= 200 && l.StatusCode < 400)
            .Project(l => new { l.Path, l.UserId })
            .ToListAsync();

        var apiByAgent = apiLogs
            .Select(l =>
            {
                foreach (var kv in agentRoutePrefixes)
                    if (l.Path.StartsWith(kv.Key, StringComparison.OrdinalIgnoreCase))
                        return new { AppKey = kv.Value, l.UserId };
                return null;
            })
            .Where(x => x != null)
            .GroupBy(x => x!.AppKey)
            .ToDictionary(g => g.Key, g => new
            {
                apiCalls = g.Count(),
                apiUsers = g.Select(x => x!.UserId).Where(u => u != null && u != "anonymous").Distinct().Count(),
            });

        // ── 3. 合并：以两个数据源的并集为准 ──
        var allAppKeys = llmByAgent.Keys.Union(apiByAgent.Keys).ToHashSet();

        var agentGroups = allAppKeys
            .Select(appKey =>
            {
                llmByAgent.TryGetValue(appKey, out var llm);
                apiByAgent.TryGetValue(appKey, out var api);
                return new
                {
                    appKey,
                    name = ResolveAgentName(appKey),
                    calls = (api?.apiCalls ?? 0) + (llm?.llmCalls ?? 0),
                    users = Math.Max(llm?.llmUsers ?? 0, api?.apiUsers ?? 0),
                    tokens = llm?.tokens ?? 0L,
                    avgDurationMs = llm?.avgDurationMs ?? 0d,
                    llmCalls = llm?.llmCalls ?? 0,
                    apiCalls = api?.apiCalls ?? 0,
                };
            })
            .OrderByDescending(a => a.calls)
            .ToList();

        return Ok(ApiResponse<object>.Ok(agentGroups));
    }

    /// <summary>
    /// 模型使用统计（含成本估算）
    /// </summary>
    [HttpGet("models")]
    public async Task<IActionResult> GetModels([FromQuery] int days = 0)
    {
        if (days < 0) days = 0;
        var periodStart = days > 0 ? DateTime.UtcNow.Date.AddDays(-days + 1) : DateTime.MinValue;

        // 1) 查日志（增加 ImageSuccessCount 用于图片成本计算）
        var logs = await _db.LlmRequestLogs
            .Find(l => l.StartedAt >= periodStart && l.Model != null)
            .Project(l => new { l.Model, l.InputTokens, l.OutputTokens, l.DurationMs, l.ImageSuccessCount })
            .ToListAsync();

        // 2) 构建模型→定价查找表（从 ModelGroup 中读取已配置的价格）
        var allGroups = await _db.ModelGroups.Find(_ => true).ToListAsync();
        var pricingLookup = new Dictionary<string, (decimal? inputPricePerM, decimal? outputPricePerM, decimal? pricePerCall)>();
        foreach (var mg in allGroups)
        {
            foreach (var item in mg.Models)
            {
                if (!string.IsNullOrEmpty(item.ModelId) && !pricingLookup.ContainsKey(item.ModelId))
                {
                    if (item.InputPricePerMillion.HasValue || item.OutputPricePerMillion.HasValue || item.PricePerCall.HasValue)
                    {
                        pricingLookup[item.ModelId] = (item.InputPricePerMillion, item.OutputPricePerMillion, item.PricePerCall);
                    }
                }
            }
        }

        // 3) 分组聚合 + 成本计算
        var modelGroups = logs
            .GroupBy(l => l.Model ?? "unknown")
            .Select(g =>
            {
                var withDuration = g.Where(l => l.DurationMs.HasValue).ToList();
                var inputTokens = g.Sum(l => (long)(l.InputTokens ?? 0));
                var outputTokens = g.Sum(l => (long)(l.OutputTokens ?? 0));
                var imageCount = g.Sum(l => l.ImageSuccessCount ?? 0);
                var calls = g.Count();

                // 成本计算：Token 成本 + 调用成本
                decimal tokenCost = 0;
                decimal callCost = 0;
                bool hasPricing = pricingLookup.TryGetValue(g.Key, out var pricing);

                if (hasPricing)
                {
                    if (pricing.inputPricePerM.HasValue)
                        tokenCost += (decimal)inputTokens / 1_000_000m * pricing.inputPricePerM.Value;
                    if (pricing.outputPricePerM.HasValue)
                        tokenCost += (decimal)outputTokens / 1_000_000m * pricing.outputPricePerM.Value;
                    if (pricing.pricePerCall.HasValue)
                        callCost = calls * pricing.pricePerCall.Value;
                }

                return new
                {
                    model = g.Key,
                    calls,
                    inputTokens,
                    outputTokens,
                    totalTokens = inputTokens + outputTokens,
                    avgDurationMs = withDuration.Count > 0 ? Math.Round(withDuration.Average(l => l.DurationMs!.Value), 1) : 0,
                    imageCount,
                    tokenCost = Math.Round(tokenCost, 4),
                    callCost = Math.Round(callCost, 4),
                    totalCost = Math.Round(tokenCost + callCost, 4),
                    hasPricing,
                };
            })
            .OrderByDescending(m => m.calls)
            .ToList();

        return Ok(ApiResponse<object>.Ok(modelGroups));
    }

    /// <summary>
    /// 排行榜矩阵 — 每个用户在每个维度的使用量
    /// </summary>
    [HttpGet("leaderboard")]
    public async Task<IActionResult> GetLeaderboard([FromQuery] int days = 0)
    {
        // days=0 表示全部时间, >0 表示最近 N 天
        if (days < 0) days = 0;
        var now = DateTime.UtcNow;
        var today = now.Date;
        // periodStart: days=0 → 不限时间(用 MinValue), >0 → 最近 N 天
        var periodStart = days > 0 ? today.AddDays(-days + 1) : DateTime.MinValue;

        // 所有非 Bot 用户
        var allUsers = await _db.Users.Find(_ => true).ToListAsync();
        var humanUsers = allUsers.Where(u => u.UserType != UserType.Bot).ToList();
        var userIds = humanUsers.Select(u => u.UserId).ToHashSet();

        // --- Agent 使用量 (llm_request_logs + api_request_logs 合并) ---
        var agentRoutePrefixes = new Dictionary<string, string>
        {
            { "/api/prd-agent/", "prd-agent" },
            { "/api/visual-agent/", "visual-agent" },
            { "/api/literary-agent/", "literary-agent" },
            { "/api/defect-agent/", "defect-agent" },
            { "/api/ai-toolbox/", "ai-toolbox" },
            { "/api/report-agent/", "report-agent" },
            { "/api/video-agent/", "video-agent" },
        };

        var aggOpts = new AggregateOptions { AllowDiskUse = true };

        // LLM 维度：服务端按 {AppCallerCode,UserId} 分组（基数 = 不同 appcaller×用户，
        // 远小于日志条数），再在内存做 NormalizeAppKey 归一。不再把整张 llmrequestlogs 拉回。
        var llmGroups = await _db.LlmRequestLogs.Aggregate(aggOpts)
            .Match(l => l.StartedAt >= periodStart && l.AppCallerCode != null && l.UserId != null)
            .Group(l => new { l.AppCallerCode, l.UserId },
                   g => new { g.Key.AppCallerCode, g.Key.UserId, C = g.Count() })
            .ToListAsync();

        var llmAgentUserCounts = new Dictionary<string, Dictionary<string, int>>();
        foreach (var row in llmGroups)
        {
            if (row.UserId == null || !userIds.Contains(row.UserId)) continue;
            var appKey = NormalizeAppKey(row.AppCallerCode ?? "");
            if (string.IsNullOrEmpty(appKey)) continue;
            if (!llmAgentUserCounts.TryGetValue(appKey, out var inner))
                llmAgentUserCounts[appKey] = inner = new Dictionary<string, int>();
            inner[row.UserId] = inner.GetValueOrDefault(row.UserId) + row.C;
        }

        // API 维度（写操作）：Path 含资源 GUID（如 /api/prd-agent/sessions/{guid}/messages），
        // 若按原始 Path 分组基数≈文档数，既失去聚合意义又会撞 $group 100MB 内存上限。
        // 改为在管道内用 $switch 把 Path 前缀直接归一成 appKey，再按 {appKey,UserId} 分组，
        // 基数收敛到 ≈7×用户数（与 LLM 维度同量级）。
        var apiPrefixRegex = "^(" + string.Join("|", agentRoutePrefixes.Keys.Select(Regex.Escape)) + ")";
        var switchBranches = new BsonArray(agentRoutePrefixes.Select(kv => new BsonDocument
        {
            { "case", new BsonDocument("$regexMatch", new BsonDocument
                {
                    { "input", "$Path" },
                    { "regex", "^" + Regex.Escape(kv.Key) },
                    { "options", "i" },
                }) },
            { "then", kv.Value },
        }));

        var apiPipeline = new BsonDocument[]
        {
            new("$match", new BsonDocument
            {
                { "StartedAt", new BsonDocument("$gte", periodStart) },
                { "Method", new BsonDocument("$ne", "GET") },
                { "StatusCode", new BsonDocument { { "$gte", 200 }, { "$lt", 400 } } },
                { "UserId", new BsonDocument("$nin", new BsonArray { BsonNull.Value, "anonymous" }) },
                { "Path", new BsonRegularExpression(apiPrefixRegex, "i") },
            }),
            new("$set", new BsonDocument("_ak", new BsonDocument("$switch", new BsonDocument
            {
                { "branches", switchBranches },
                { "default", BsonNull.Value },
            }))),
            new("$match", new BsonDocument("_ak", new BsonDocument("$ne", BsonNull.Value))),
            new("$group", new BsonDocument
            {
                { "_id", new BsonDocument { { "ak", "$_ak" }, { "u", "$UserId" } } },
                { "c", new BsonDocument("$sum", 1) },
            }),
        };

        var apiGroups = await _db.ApiRequestLogs
            .Aggregate<BsonDocument>(apiPipeline, aggOpts)
            .ToListAsync();

        var apiAgentUserCounts = new Dictionary<string, Dictionary<string, int>>();
        foreach (var row in apiGroups)
        {
            var id = row["_id"].AsBsonDocument;
            var matchedKey = id["ak"].AsString;
            var uid = id["u"].IsString ? id["u"].AsString : null;
            if (string.IsNullOrEmpty(uid) || !userIds.Contains(uid)) continue;
            var c = row["c"].ToInt32();
            if (!apiAgentUserCounts.TryGetValue(matchedKey, out var inner))
                apiAgentUserCounts[matchedKey] = inner = new Dictionary<string, int>();
            inner[uid] = inner.GetValueOrDefault(uid) + c;
        }

        // 合并两个数据源
        var agentUserCounts = new Dictionary<string, Dictionary<string, int>>();
        foreach (var appKey in llmAgentUserCounts.Keys.Union(apiAgentUserCounts.Keys))
        {
            llmAgentUserCounts.TryGetValue(appKey, out var llmVals);
            apiAgentUserCounts.TryGetValue(appKey, out var apiVals);
            var merged = new Dictionary<string, int>();
            foreach (var uid in (llmVals?.Keys ?? Enumerable.Empty<string>()).Union(apiVals?.Keys ?? Enumerable.Empty<string>()))
            {
                var llmCount = llmVals != null && llmVals.TryGetValue(uid, out var lv) ? lv : 0;
                var apiCount = apiVals != null && apiVals.TryGetValue(uid, out var av) ? av : 0;
                merged[uid] = llmCount + apiCount;
            }
            agentUserCounts[appKey] = merged;
        }

        // --- 各活动维度：全部走服务端 $group，不再 Find().ToListAsync() 全量进内存 ---
        var defectsCreatedByUser = await CountByUserAsync(_db.DefectReports,
            d => d.CreatedAt >= periodStart, d => d.ReporterId, userIds);
        // 口径修正：未解决缺陷 ResolvedById/ResolvedAt 为 null。原 `ResolvedAt >= periodStart`
        // 在 days=0(periodStart=MinValue) 时会把未解决缺陷也算进"已解决"。显式要求非空。
        var defectsResolvedByUser = await CountByUserAsync(_db.DefectReports,
            d => d.ResolvedById != null && d.ResolvedAt != null && d.ResolvedAt >= periodStart,
            d => d.ResolvedById, userIds);
        var imageByUser = await CountByUserAsync(_db.ImageAssets,
            r => r.CreatedAt >= periodStart, r => r.OwnerUserId, userIds);
        var visualGenByUser = await CountByUserAsync(_db.ImageGenRuns,
            r => r.CreatedAt >= periodStart && r.AppKey == "visual-agent" && r.Status == ImageGenRunStatus.Completed,
            r => r.OwnerAdminId, userIds);
        var literaryGenByUser = await CountByUserAsync(_db.ImageGenRuns,
            r => r.CreatedAt >= periodStart && r.AppKey == "literary-agent" && r.Status == ImageGenRunStatus.Completed,
            r => r.OwnerAdminId, userIds);
        var uploadByUser = await CountByUserAsync(_db.UploadArtifacts,
            r => r.CreatedAt >= periodStart && r.Kind == "input_image", r => r.CreatedByAdminId, userIds);
        var workflowByUser = await CountByUserAsync(_db.WorkflowExecutions,
            w => w.CreatedAt >= periodStart, w => w.TriggeredBy, userIds);
        var arenaByUser = await CountByUserAsync(_db.ArenaBattles,
            a => a.CreatedAt >= periodStart, a => a.UserId, userIds);

        // 用户列表 (按活跃度排序)
        var userList = humanUsers
            .OrderByDescending(u => u.LastActiveAt)
            .Select(u => new
            {
                userId = u.UserId,
                username = u.Username,
                displayName = u.DisplayName ?? u.Username,
                role = u.Role.ToString(),
                avatarFileName = u.AvatarFileName,
                lastActiveAt = u.LastActiveAt,
                isActive = u.LastActiveAt >= periodStart,
            })
            .ToList();

        // 构建维度。缺陷三列（defect-agent LLM 调用 / 缺陷提交 / 缺陷解决）合并为
        // 单列「缺陷」= 真实提交数 + 解决数；defect-agent 不再单列（口径混乱）。
        var knownAgents = new[] { "prd-agent", "visual-agent", "literary-agent", "ai-toolbox", "report-agent", "video-agent" };
        var dimensions = new List<object>();

        foreach (var appKey in knownAgents)
        {
            agentUserCounts.TryGetValue(appKey, out var vals);
            dimensions.Add(MakeDim(appKey, ResolveAgentName(appKey), "agent", vals ?? new Dictionary<string, int>()));
        }

        // 缺陷合并：values = 提交 + 解决；subValues 给 tooltip 拆解显示
        var defectValues = new Dictionary<string, int>();
        var defectSub = new Dictionary<string, object>();
        foreach (var uid in defectsCreatedByUser.Keys.Union(defectsResolvedByUser.Keys))
        {
            var c = defectsCreatedByUser.GetValueOrDefault(uid);
            var r = defectsResolvedByUser.GetValueOrDefault(uid);
            defectValues[uid] = c + r;
            defectSub[uid] = new { created = c, resolved = r };
        }
        dimensions.Add(MakeDim("defects", "缺陷", "activity", defectValues, defectSub));
        dimensions.Add(MakeDim("images", "图片合计", "activity", imageByUser));
        dimensions.Add(MakeDim("image-gen-visual", "视觉生图", "image", visualGenByUser));
        dimensions.Add(MakeDim("image-gen-literary", "文学配图", "image", literaryGenByUser));
        dimensions.Add(MakeDim("image-upload", "上传参考图", "image", uploadByUser));
        dimensions.Add(MakeDim("workflows", "工作流执行", "activity", workflowByUser));
        dimensions.Add(MakeDim("arena", "竞技场对战", "activity", arenaByUser));

        // 计算实际天数: days>0 时等于 days; days=0 时从最早的 LLM 日志到今天
        int totalDays;
        if (days > 0)
        {
            totalDays = days;
        }
        else
        {
            var earliest = await _db.LlmRequestLogs
                .Find(_ => true)
                .SortBy(l => l.StartedAt)
                .Limit(1)
                .Project(l => l.StartedAt)
                .FirstOrDefaultAsync();
            totalDays = earliest != default ? Math.Max(1, (int)(today - earliest.Date).TotalDays + 1) : 1;
        }

        return Ok(ApiResponse<object>.Ok(new { users = userList, dimensions, totalDays }));
    }

    // ─────────────────────────────────────────────────────────────────────
    // 团队洞察（结论优先四段式）
    //   A 团队状态 / B 需要关注 / C 成员画像 / D 价值流
    // 全部字段来自真实集合聚合；无法从 MAP 取到的指标（如 CDS 验收通过率）
    // 一律不出现在返回体，改在 meta.unavailable 中显式声明缺什么、为什么。
    // ─────────────────────────────────────────────────────────────────────

    /// <summary>单个成员在统计窗口内的原始聚合量（内部中间态，不直接出参）</summary>
    private sealed class MemberAgg
    {
        public int Docs, Sites, Reports, RunsCompleted;
        public int RunsDone, RunsFailed;
        public int DefectsReported, DefectsAssigned, DefectsResolved, DefectsBacklog;
        public int LlmCalls, LlmErrors;
        public long InputTokens, OutputTokens;
        public decimal Cost;
        public readonly HashSet<DateTime> OutputDays = new();
    }

    /// <summary>需要关注卡片：现象 + 证据 + 建议 + 下钻入口</summary>
    private sealed record AttentionItem(
        string Severity, string Key, string Title, string Evidence,
        string Suggestion, string LinkLabel, string LinkTo);

    /// <summary>价值流「环节」分组：appKey → 环节名</summary>
    private static string ResolveFlowStage(string appKey) => appKey switch
    {
        "prd-agent" => "需求梳理",
        "visual-agent" or "literary-agent" or "video-agent" => "内容生成",
        "report-agent" or "ai-toolbox" => "汇报与工具",
        "defect-agent" => "缺陷处理",
        _ => "其他",
    };

    /// <summary>把小时数按量级说人话：不足 1 小时给分钟，不足 1 天给小时，否则给天。</summary>
    private static string FormatDuration(double hours)
    {
        if (hours < 1) return $"{Math.Round(hours * 60, 0)} 分钟";
        if (hours < 24) return $"{Math.Round(hours, 1)} 小时";
        return $"{Math.Round(hours / 24, 1)} 天";
    }

    private static double? Median(List<double> values)
    {
        if (values.Count == 0) return null;
        var sorted = values.OrderBy(v => v).ToList();
        var mid = sorted.Count / 2;
        return sorted.Count % 2 == 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2.0;
    }

    /// <summary>
    /// 团队洞察面板 — 结论优先的四段式聚合。
    /// days=0 表示全部时间（无环比、无日序列）；days>0 时同时算出等长上一窗用于环比。
    /// </summary>
    [HttpGet("team-insights")]
    public async Task<IActionResult> GetTeamInsights([FromQuery] int days = 0)
    {
        if (days < 0) days = 0;
        var now = DateTime.UtcNow;
        var today = now.Date;
        var start = days > 0 ? today.AddDays(-days + 1) : DateTime.MinValue;
        var prevStart = days > 0 ? start.AddDays(-days) : DateTime.MinValue;
        var hasPrev = days > 0;
        // 日序列只在窗口有界且不太长时给；超长窗口返回空数组而不是编造
        var wantSeries = days > 0 && days <= 45;

        var allUsers = await _db.Users.Find(_ => true).ToListAsync();
        var humanUsers = allUsers.Where(u => u.UserType != UserType.Bot).ToList();
        var userIds = humanUsers.Select(u => u.UserId).ToHashSet();
        var agg = new Dictionary<string, MemberAgg>();
        MemberAgg Bucket(string uid)
        {
            if (!agg.TryGetValue(uid, out var m)) agg[uid] = m = new MemberAgg();
            return m;
        }

        // ── 产出侧：四类小集合，逐条取时间戳（同时供日序列与产出天数使用） ──
        var docRows = await _db.DocumentEntries
            .Find(d => d.CreatedAt >= start)
            .Project(d => new { d.CreatedBy, d.CreatedAt })
            .ToListAsync();
        var siteRows = await _db.HostedSites
            .Find(s => s.CreatedAt >= start)
            .Project(s => new { s.OwnerUserId, s.CreatedAt })
            .ToListAsync();
        var reportRows = await _db.WeeklyReports
            .Find(r => r.SubmittedAt != null && r.SubmittedAt >= start)
            .Project(r => new { r.UserId, r.SubmittedAt })
            .ToListAsync();
        var runRows = await _db.ImageGenRuns
            .Find(r => r.CreatedAt >= start)
            .Project(r => new { r.OwnerAdminId, r.CreatedAt, r.Status, r.Done, r.Failed })
            .ToListAsync();

        foreach (var r in docRows)
        {
            if (r.CreatedBy == null || !userIds.Contains(r.CreatedBy)) continue;
            var m = Bucket(r.CreatedBy); m.Docs++; m.OutputDays.Add(r.CreatedAt.Date);
        }
        foreach (var r in siteRows)
        {
            if (r.OwnerUserId == null || !userIds.Contains(r.OwnerUserId)) continue;
            var m = Bucket(r.OwnerUserId); m.Sites++; m.OutputDays.Add(r.CreatedAt.Date);
        }
        foreach (var r in reportRows)
        {
            if (r.UserId == null || !userIds.Contains(r.UserId) || r.SubmittedAt == null) continue;
            var m = Bucket(r.UserId); m.Reports++; m.OutputDays.Add(r.SubmittedAt.Value.Date);
        }
        foreach (var r in runRows)
        {
            if (r.OwnerAdminId == null || !userIds.Contains(r.OwnerAdminId)) continue;
            var m = Bucket(r.OwnerAdminId);
            m.RunsDone += r.Done; m.RunsFailed += r.Failed;
            if (r.Status == ImageGenRunStatus.Completed) { m.RunsCompleted++; m.OutputDays.Add(r.CreatedAt.Date); }
        }

        // ── 缺陷：解决时长 / 积压 / 提交与解决归属 ──
        var resolvedDefects = await _db.DefectReports
            .Find(d => d.ResolvedAt != null && d.ResolvedAt >= start)
            .Project(d => new { d.AssigneeId, d.ReporterId, d.CreatedAt, d.ResolvedAt })
            .ToListAsync();
        var openStatuses = new[] { DefectStatus.Assigned, DefectStatus.Processing, DefectStatus.Verifying, DefectStatus.Submitted };
        var openDefects = await _db.DefectReports
            .Find(d => openStatuses.Contains(d.Status))
            .Project(d => new { d.AssigneeId, d.CreatedAt })
            .ToListAsync();
        var reportedDefects = await CountByUserAsync(_db.DefectReports,
            d => d.CreatedAt >= start, d => d.ReporterId, userIds);
        var assignedDefects = await CountByUserAsync(_db.DefectReports,
            d => d.CreatedAt >= start && d.AssigneeId != null, d => d.AssigneeId, userIds);

        foreach (var kv in reportedDefects) Bucket(kv.Key).DefectsReported = kv.Value;
        foreach (var kv in assignedDefects) Bucket(kv.Key).DefectsAssigned = kv.Value;
        foreach (var d in resolvedDefects)
        {
            var owner = d.AssigneeId ?? d.ReporterId;
            if (owner == null || !userIds.Contains(owner)) continue;
            var m = Bucket(owner); m.DefectsResolved++;
            if (d.ResolvedAt != null) m.OutputDays.Add(d.ResolvedAt.Value.Date);
        }
        foreach (var d in openDefects)
        {
            if (d.AssigneeId == null || !userIds.Contains(d.AssigneeId)) continue;
            if ((today - d.CreatedAt.Date).TotalDays >= 7) Bucket(d.AssigneeId).DefectsBacklog++;
        }

        // ── LLM：调用量 / 失败率 / Token 与成本（按 {用户,模型} 分组后在内存套价） ──
        var aggOpts2 = new AggregateOptions { AllowDiskUse = true };
        var llmByUserModel = await _db.LlmRequestLogs.Aggregate(aggOpts2)
            .Match(l => l.StartedAt >= start && l.UserId != null && l.Model != null)
            .Group(l => new { l.UserId, l.Model },
                   g => new { g.Key.UserId, g.Key.Model, C = g.Count(), In = g.Sum(x => x.InputTokens ?? 0), Out = g.Sum(x => x.OutputTokens ?? 0) })
            .ToListAsync();
        var llmErrByUser = await _db.LlmRequestLogs.Aggregate(aggOpts2)
            .Match(l => l.StartedAt >= start && l.UserId != null && l.StatusCode >= 400)
            .Group(l => l.UserId, g => new { Uid = g.Key, C = g.Count() })
            .ToListAsync();
        var llmByCaller = await _db.LlmRequestLogs.Aggregate(aggOpts2)
            .Match(l => l.StartedAt >= start && l.AppCallerCode != null)
            .Group(l => l.AppCallerCode, g => new { K = g.Key, C = g.Count() })
            .ToListAsync();

        var pricingLookup = new Dictionary<string, (decimal? In, decimal? Out, decimal? PerCall)>();
        foreach (var mg in await _db.ModelGroups.Find(_ => true).ToListAsync())
        {
            foreach (var item in mg.Models)
            {
                if (string.IsNullOrEmpty(item.ModelId) || pricingLookup.ContainsKey(item.ModelId)) continue;
                if (item.InputPricePerMillion.HasValue || item.OutputPricePerMillion.HasValue || item.PricePerCall.HasValue)
                    pricingLookup[item.ModelId] = (item.InputPricePerMillion, item.OutputPricePerMillion, item.PricePerCall);
            }
        }
        decimal CostOf(string? model, long inTok, long outTok, int calls)
        {
            if (model == null || !pricingLookup.TryGetValue(model, out var p)) return 0m;
            decimal c = 0m;
            if (p.In.HasValue) c += (decimal)inTok / 1_000_000m * p.In.Value;
            if (p.Out.HasValue) c += (decimal)outTok / 1_000_000m * p.Out.Value;
            if (p.PerCall.HasValue) c += calls * p.PerCall.Value;
            return c;
        }

        long totalIn = 0, totalOut = 0;
        int totalCalls = 0;
        decimal totalCost = 0m;
        int pricedCalls = 0;
        foreach (var row in llmByUserModel)
        {
            long inTok = row.In; long outTok = row.Out;
            totalIn += inTok; totalOut += outTok; totalCalls += row.C;
            var cost = CostOf(row.Model, inTok, outTok, row.C);
            totalCost += cost;
            if (row.Model != null && pricingLookup.ContainsKey(row.Model)) pricedCalls += row.C;
            if (row.UserId == null || !userIds.Contains(row.UserId)) continue;
            var m = Bucket(row.UserId);
            m.LlmCalls += row.C; m.InputTokens += inTok; m.OutputTokens += outTok; m.Cost += cost;
        }
        foreach (var row in llmErrByUser)
        {
            if (row.Uid == null || !userIds.Contains(row.Uid)) continue;
            Bucket(row.Uid).LlmErrors = row.C;
        }
        var totalErrors = llmErrByUser.Sum(r => r.C);

        // ── 成员画像 ──
        var userMap = humanUsers.ToDictionary(u => u.UserId);
        var memberRows = new List<(User U, MemberAgg A, int Output, double? Quality)>();
        foreach (var u in humanUsers)
        {
            agg.TryGetValue(u.UserId, out var a);
            a ??= new MemberAgg();
            var output = a.Docs + a.Sites + a.Reports + a.RunsCompleted + a.DefectsResolved;

            // 结果质量只由「结果型」信号构成：缺陷是否真的解决、生图是否真的成功。
            // 模型调用成功率几乎恒为 100%，区分度接近零，单独存在时不足以支撑一个质量分——
            // 只有已经有结果型信号时才作为附加项参与平均，否则本窗判为数据不足。
            var outcomeSignals = new List<double>();
            if (a.DefectsAssigned > 0) outcomeSignals.Add((double)a.DefectsResolved / a.DefectsAssigned);
            if (a.RunsDone + a.RunsFailed > 0) outcomeSignals.Add((double)a.RunsDone / (a.RunsDone + a.RunsFailed));
            double? quality = null;
            if (outcomeSignals.Count > 0)
            {
                var signals = new List<double>(outcomeSignals);
                if (a.LlmCalls > 0) signals.Add(1.0 - (double)a.LlmErrors / a.LlmCalls);
                quality = Math.Round(signals.Average() * 100, 0);
            }
            if (output == 0 && a.LlmCalls == 0) continue; // 本窗完全无痕迹的用户不进画像
            memberRows.Add((u, a, output, quality));
        }

        // 中位数只在「进得了画像的人」里取：把大量本窗零产出的旁观者算进来会让中位塌到 0，
        // 「产出 ≥ 中位」变成恒真，四象限随之失效。
        var plotted = memberRows.Where(r => r.Quality != null).ToList();
        var medOutput = Median(plotted.Select(r => (double)r.Output).ToList()) ?? 0;
        var medQuality = Median(plotted.Select(r => r.Quality!.Value).ToList()) ?? 0;
        var medCost = Median(memberRows.Select(r => (double)r.A.Cost).ToList()) ?? 0;
        var medCalls = Median(memberRows.Select(r => (double)r.A.LlmCalls).ToList()) ?? 0;
        // 产出阈值至少为 1：零产出不该被算作「达到中位」
        var outputThreshold = Math.Max(1, medOutput);
        // 样本少于 3 人时中位数几乎等于当事人自己，四象限没有判别力，整体降级为「样本不足」
        var quadrantReliable = plotted.Count >= 3;

        var members = memberRows.Select(r =>
        {
            var (u, a, output, quality) = r;
            string quadrant;
            if (quality == null) quadrant = "数据不足";
            else if (!quadrantReliable) quadrant = "样本不足";
            else if (output >= outputThreshold && quality >= medQuality) quadrant = "主力产出";
            else if (output < outputThreshold && quality >= medQuality) quadrant = "精工型";
            else if (output >= outputThreshold && quality < medQuality) quadrant = "高量低果";
            else quadrant = "低活跃";

            var highlights = new List<string>();
            if (a.Docs > 0) highlights.Add($"知识库文档 {a.Docs} 篇");
            if (a.Sites > 0) highlights.Add($"网页站点 {a.Sites} 个");
            if (a.RunsCompleted > 0) highlights.Add($"生图任务完成 {a.RunsCompleted} 次（出图 {a.RunsDone} 张）");
            if (a.Reports > 0) highlights.Add($"周报已提交 {a.Reports} 篇");
            if (a.DefectsResolved > 0) highlights.Add($"缺陷已解决 {a.DefectsResolved} 个");
            if (a.DefectsBacklog > 0) highlights.Add($"名下 {a.DefectsBacklog} 个缺陷停留超 7 天");
            if (highlights.Count == 0) highlights.Add($"本窗仅有 {a.LlmCalls} 次模型调用，未产生可统计产出");

            return new
            {
                userId = u.UserId,
                displayName = string.IsNullOrEmpty(u.DisplayName) ? u.Username : u.DisplayName,
                role = u.Role.ToString(),
                avatarFileName = u.AvatarFileName,
                output,
                quality,
                quadrant,
                outputDays = a.OutputDays.Count,
                llmCalls = a.LlmCalls,
                llmErrors = a.LlmErrors,
                cost = Math.Round(a.Cost, 2),
                tokens = a.InputTokens + a.OutputTokens,
                breakdown = new
                {
                    docs = a.Docs,
                    sites = a.Sites,
                    reports = a.Reports,
                    imageRuns = a.RunsCompleted,
                    imagesDone = a.RunsDone,
                    imagesFailed = a.RunsFailed,
                    defectsReported = a.DefectsReported,
                    defectsAssigned = a.DefectsAssigned,
                    defectsResolved = a.DefectsResolved,
                    defectsBacklog = a.DefectsBacklog,
                },
                highlights,
            };
        }).OrderByDescending(m => m.output).ToList();

        // ── A. 团队状态（含等长上一窗环比） ──
        int prevDocs = 0, prevSites = 0, prevReports = 0, prevRuns = 0, prevResolved = 0;
        if (hasPrev)
        {
            prevDocs = (int)await _db.DocumentEntries.CountDocumentsAsync(d => d.CreatedAt >= prevStart && d.CreatedAt < start);
            prevSites = (int)await _db.HostedSites.CountDocumentsAsync(s => s.CreatedAt >= prevStart && s.CreatedAt < start);
            prevReports = (int)await _db.WeeklyReports.CountDocumentsAsync(r => r.SubmittedAt != null && r.SubmittedAt >= prevStart && r.SubmittedAt < start);
            prevRuns = (int)await _db.ImageGenRuns.CountDocumentsAsync(r => r.CreatedAt >= prevStart && r.CreatedAt < start && r.Status == ImageGenRunStatus.Completed);
            prevResolved = (int)await _db.DefectReports.CountDocumentsAsync(d => d.ResolvedAt != null && d.ResolvedAt >= prevStart && d.ResolvedAt < start);
        }

        var curDocs = docRows.Count;
        var curSites = siteRows.Count;
        var curReports = reportRows.Count;
        var curRuns = runRows.Count(r => r.Status == ImageGenRunStatus.Completed);
        var curOutput = curDocs + curSites + curReports + curRuns + resolvedDefects.Count;
        var prevOutput = prevDocs + prevSites + prevReports + prevRuns + prevResolved;

        var resolveHours = resolvedDefects
            .Where(d => d.ResolvedAt != null && d.ResolvedAt > d.CreatedAt)
            .Select(d => (d.ResolvedAt!.Value - d.CreatedAt).TotalHours)
            .ToList();
        var medianResolve = Median(resolveHours);

        double? prevMedianResolve = null;
        if (hasPrev)
        {
            var prevResolvedRows = await _db.DefectReports
                .Find(d => d.ResolvedAt != null && d.ResolvedAt >= prevStart && d.ResolvedAt < start)
                .Project(d => new { d.CreatedAt, d.ResolvedAt })
                .ToListAsync();
            prevMedianResolve = Median(prevResolvedRows
                .Where(d => d.ResolvedAt != null && d.ResolvedAt > d.CreatedAt)
                .Select(d => (d.ResolvedAt!.Value - d.CreatedAt).TotalHours).ToList());
        }

        var activeMembers = memberRows.Count;
        var successRate = totalCalls > 0 ? Math.Round((1.0 - (double)totalErrors / totalCalls) * 100, 1) : (double?)null;
        var costPerActive = activeMembers > 0 ? Math.Round(totalCost / activeMembers, 2) : 0m;

        // 日序列：只用小集合真实计数，取不到就给空数组，不做插值
        List<double> outputSeries = new();
        if (wantSeries)
        {
            for (var d = start; d < today.AddDays(1); d = d.AddDays(1))
            {
                var day = d.Date;
                var c = docRows.Count(x => x.CreatedAt.Date == day)
                      + siteRows.Count(x => x.CreatedAt.Date == day)
                      + reportRows.Count(x => x.SubmittedAt != null && x.SubmittedAt.Value.Date == day)
                      + runRows.Count(x => x.Status == ImageGenRunStatus.Completed && x.CreatedAt.Date == day)
                      + resolvedDefects.Count(x => x.ResolvedAt != null && x.ResolvedAt.Value.Date == day);
                outputSeries.Add(c);
            }
        }

        object Kpi(string key, string label, double? value, string unit, double? prev,
                   bool higherIsBetter, List<double> series, string note) => new
        {
            key,
            label,
            value,
            unit,
            prev,
            deltaPct = (prev != null && prev.Value != 0 && value != null)
                ? Math.Round((value.Value - prev.Value) / Math.Abs(prev.Value) * 100, 1)
                : (double?)null,
            higherIsBetter,
            series,
            note,
        };

        var pulse = new List<object>
        {
            Kpi("output", "本期产出", curOutput, "件", hasPrev ? (double?)prevOutput : null, true, outputSeries,
                "已发布文档 + 上线站点 + 已提交周报 + 完成的生图任务 + 已解决缺陷"),
            // 中位不足 1 小时的时候用「小时」表述会四舍五入成 0，读起来像坏了；按量级换单位
            Kpi("resolveHours", "缺陷中位解决时长",
                medianResolve != null ? (double?)Math.Round(medianResolve.Value < 1 ? medianResolve.Value * 60 : medianResolve.Value, 1) : null,
                medianResolve != null && medianResolve.Value < 1 ? "分钟" : "小时",
                prevMedianResolve != null && medianResolve != null
                    ? (double?)Math.Round(medianResolve.Value < 1 ? prevMedianResolve.Value * 60 : prevMedianResolve.Value, 1)
                    : null,
                false, new List<double>(),
                "窗口内被标记已解决的缺陷，从创建到解决耗时的中位数"),
            Kpi("successRate", "模型调用成功率", successRate, "%", null, true, new List<double>(),
                "LLM 网关日志中 HTTP 状态码 < 400 的比例"),
            // 没有任何一次调用能套上单价时，成本是算不出来而不是零 —— 一律给 null
            Kpi("costPerActive", "人均 AI 成本", pricedCalls > 0 ? (double)costPerActive : null, "元", null, true, new List<double>(),
                pricedCalls > 0
                    ? $"按模型组已配置单价折算；{totalCalls} 次调用中 {pricedCalls} 次有定价"
                    : "模型组尚未配置单价，成本无法折算"),
            Kpi("activeMembers", "有痕迹成员", activeMembers, "人", null, true, new List<double>(),
                $"窗口内有产出或模型调用的成员数，团队共 {humanUsers.Count} 人"),
        };

        // ── B. 需要关注（规则触发；没有触发就返回空，不凑数） ──
        var attention = new List<AttentionItem>();

        var backlogOwners = openDefects
            .Where(d => d.AssigneeId != null && userIds.Contains(d.AssigneeId)
                        && (today - d.CreatedAt.Date).TotalDays >= 7)
            .GroupBy(d => d.AssigneeId!)
            .Select(g => new { Uid = g.Key, Count = g.Count(), OldestDays = g.Max(x => (int)(today - x.CreatedAt.Date).TotalDays) })
            .Where(g => g.Count >= 3 || g.OldestDays >= 14)
            .OrderByDescending(g => g.Count)
            .Take(3)
            .ToList();
        foreach (var b in backlogOwners)
        {
            var name = userMap.TryGetValue(b.Uid, out var bu)
                ? (string.IsNullOrEmpty(bu.DisplayName) ? bu.Username : bu.DisplayName) : b.Uid;
            attention.Add(new AttentionItem(
                b.Count >= 5 || b.OldestDays >= 21 ? "critical" : "watch",
                $"backlog:{b.Uid}",
                $"{name} 名下 {b.Count} 个缺陷停留超 7 天",
                medianResolve != null
                    ? $"最久一个已 {b.OldestDays} 天未流转，团队中位解决时长是 {FormatDuration(medianResolve.Value)}。"
                    : $"最久一个已 {b.OldestDays} 天未流转。",
                "确认是缺处理人力、缺复现环境，还是卡在验收环节",
                "打开这些缺陷",
                "/defect-agent"));
        }

        var imgTotal = runRows.Sum(r => r.Done) + runRows.Sum(r => r.Failed);
        var imgFailed = runRows.Sum(r => r.Failed);
        if (imgTotal >= 20 && (double)imgFailed / imgTotal >= 0.10)
        {
            attention.Add(new AttentionItem(
                (double)imgFailed / imgTotal >= 0.25 ? "critical" : "watch",
                "image-failure",
                $"生图失败率 {Math.Round((double)imgFailed / imgTotal * 100, 1)}%",
                $"窗口内共 {imgTotal} 张出图请求，其中 {imgFailed} 张失败。",
                "到模型池按模型看失败分布，把不稳定的模型移出默认池",
                "查看模型池",
                "/models"));
        }

        // 需要一个成立的比较基准：产出中位为 0、或样本不足 3 人时，「产出低」无从谈起，整条规则不触发。
        // 比较必须用严格小于 —— 否则恰好等于中位的人（样本少时往往就是产出最高的那个）会被自己的中位反咬。
        var lowYield = (!quadrantReliable || medOutput < 1)
            ? new List<(User U, MemberAgg A, int Output, double? Quality)>()
            : memberRows
            .Where(r => r.A.LlmCalls >= Math.Max(30, medCalls * 2) && r.Output < medOutput)
            .OrderByDescending(r => r.A.LlmCalls)
            .Take(2)
            .ToList();
        foreach (var r in lowYield)
        {
            var name = string.IsNullOrEmpty(r.U.DisplayName) ? r.U.Username : r.U.DisplayName;
            attention.Add(new AttentionItem(
                "watch",
                $"low-yield:{r.U.UserId}",
                $"{name} 调用量高但产出低",
                $"模型调用 {r.A.LlmCalls} 次（团队中位 {Math.Round(medCalls)} 次），最终可统计产出 {r.Output} 件（团队中位 {Math.Round(medOutput)} 件）。",
                "看看是不是在反复试参数——可以补一组预设或换模型",
                "查看调用明细",
                "/llm-logs"));
        }

        var costOutliers = memberRows
            .Where(r => medCost > 0 && (double)r.A.Cost >= medCost * 3 && r.A.Cost >= 1m)
            .OrderByDescending(r => r.A.Cost)
            .Take(2)
            .ToList();
        foreach (var r in costOutliers)
        {
            var name = string.IsNullOrEmpty(r.U.DisplayName) ? r.U.Username : r.U.DisplayName;
            attention.Add(new AttentionItem(
                "watch",
                $"cost:{r.U.UserId}",
                $"{name} 的 AI 成本是团队中位的 {Math.Round((double)r.A.Cost / medCost, 1)} 倍",
                $"本窗 {Math.Round(r.A.Cost, 2)} 元，团队中位 {Math.Round(medCost, 2)} 元，共 {r.A.LlmCalls} 次调用。",
                "核对是否用了高价模型跑了低价值任务",
                "查看成本中心",
                "/executive"));
        }

        var attentionOut = attention
            .OrderBy(a => a.Severity == "critical" ? 0 : 1)
            .Select(a => new
            {
                severity = a.Severity,
                key = a.Key,
                title = a.Title,
                evidence = a.Evidence,
                suggestion = a.Suggestion,
                linkLabel = a.LinkLabel,
                linkTo = a.LinkTo,
            })
            .ToList();

        // ── D. 价值流 ──
        var stageCounts = new Dictionary<string, int>();
        foreach (var row in llmByCaller)
        {
            var stage = ResolveFlowStage(NormalizeAppKey(row.K ?? ""));
            stageCounts[stage] = stageCounts.GetValueOrDefault(stage) + row.C;
        }
        var totalOutputDays = memberRows.Sum(r => r.A.OutputDays.Count);
        var unresolvedInWindow = openDefects.Count(d => d.CreatedAt >= start);

        var flow = new
        {
            left = new object[]
            {
                new { name = "有产出的人天", value = totalOutputDays, unit = "人天" },
                new { name = "模型调用", value = totalCalls, unit = "次" },
                new { name = "Token 消耗", value = totalIn + totalOut, unit = "tokens" },
            },
            mid = stageCounts.Where(kv => kv.Value > 0)
                .OrderByDescending(kv => kv.Value)
                .Select(kv => new { name = kv.Key, value = kv.Value, unit = "次" })
                .ToArray(),
            right = new object[]
            {
                new { name = "已发布文档", value = curDocs, unit = "篇", loss = false },
                new { name = "已上线站点", value = curSites, unit = "个", loss = false },
                new { name = "已出图", value = runRows.Sum(r => r.Done), unit = "张", loss = false },
                new { name = "已提交周报", value = curReports, unit = "篇", loss = false },
                new { name = "已解决缺陷", value = resolvedDefects.Count, unit = "个", loss = false },
                new { name = "出图失败", value = imgFailed, unit = "张", loss = true },
                new { name = "缺陷未闭环", value = unresolvedInWindow, unit = "个", loss = true },
            },
        };

        var meta = new
        {
            days,
            from = days > 0 ? start : (DateTime?)null,
            to = now,
            prevFrom = hasPrev ? prevStart : (DateTime?)null,
            totalMembers = humanUsers.Count,
            // 前端十字线直接用这两个阈值，保证画出来的分界与后端判定同一口径
            medians = new { output = Math.Round(outputThreshold, 1), quality = Math.Round(medQuality, 1) },
            plottedMembers = plotted.Count,
            quadrantReliable,
            costAvailable = pricedCalls > 0,
            seriesAvailable = wantSeries,
            // 显式声明拿不到的指标，避免面板上出现无根数字
            unavailable = new object[]
            {
                new { metric = "验收通过率", reason = "验收结论保存在 CDS 验收中心，MAP 侧没有该事实，需要接 CDS 只读接口后才能上榜" },
                new { metric = "产物采用率", reason = "系统尚未记录「产物是否被采用」信号（投稿/下载/引用），需要先补埋点" },
            },
            sources = new object[]
            {
                new { metric = "产出", source = "document_entries / hosted_sites / report_weekly_reports / image_gen_runs / defect_reports" },
                new { metric = "结果质量", source = "缺陷解决率、生图成功率、模型调用成功率三项按可用性取平均" },
                new { metric = "成本", source = "llmrequestlogs 的 token 用量 × 模型组已配置单价" },
            },
        };

        return Ok(ApiResponse<object>.Ok(new { pulse, attention = attentionOut, members, flow, meta }));
    }

    private static string ResolveAgentName(string appKey) => appKey switch
    {
        "prd-agent" => "PRD Agent",
        "visual-agent" => "视觉创作 Agent",
        "literary-agent" => "文学创作 Agent",
        "defect-agent" => "缺陷管理 Agent",
        "ai-toolbox" => "AI 百宝箱",
        "report-agent" => "周报 Agent",
        "video-agent" => "视频 Agent",
        "open-platform" => "开放平台",
        "admin" => "管理操作",
        _ => appKey,
    };
}
