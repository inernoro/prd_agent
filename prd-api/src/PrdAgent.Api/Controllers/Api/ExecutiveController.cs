using System.Linq.Expressions;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
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

        // LLM 维度：服务端按 {AppCallerCode,UserId} 分组（基数 = 不同 appcaller×用户，
        // 远小于日志条数），再在内存做 NormalizeAppKey 归一。不再把整张 llmrequestlogs 拉回。
        var llmGroups = await _db.LlmRequestLogs.Aggregate()
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

        // API 维度（写操作）：服务端按 {Path,UserId} 分组，再在内存做路由前缀→appKey 映射。
        var apiGroups = await _db.ApiRequestLogs.Aggregate()
            .Match(l => l.StartedAt >= periodStart && l.Method != "GET"
                        && l.StatusCode >= 200 && l.StatusCode < 400)
            .Group(l => new { l.Path, l.UserId },
                   g => new { g.Key.Path, g.Key.UserId, C = g.Count() })
            .ToListAsync();

        var apiAgentUserCounts = new Dictionary<string, Dictionary<string, int>>();
        foreach (var row in apiGroups)
        {
            if (row.UserId == null || row.UserId == "anonymous" || !userIds.Contains(row.UserId)) continue;
            string? matchedKey = null;
            foreach (var kv in agentRoutePrefixes)
                if (row.Path != null && row.Path.StartsWith(kv.Key, StringComparison.OrdinalIgnoreCase))
                { matchedKey = kv.Value; break; }
            if (matchedKey == null) continue;
            if (!apiAgentUserCounts.TryGetValue(matchedKey, out var inner))
                apiAgentUserCounts[matchedKey] = inner = new Dictionary<string, int>();
            inner[row.UserId] = inner.GetValueOrDefault(row.UserId) + row.C;
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
