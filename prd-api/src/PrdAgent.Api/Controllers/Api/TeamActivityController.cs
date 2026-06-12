using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Filters;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 团队动态（全员工作日志时间线）。
/// 数据由 ActivityLogActionFilter 按白名单自动写入，本 Controller 只读。
/// </summary>
[ApiController]
[Route("api/team-activity")]
[Authorize]
[AdminController("team-activity", AdminPermissionCatalog.TeamActivityRead)]
public class TeamActivityController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;

    public TeamActivityController(MongoDbContext db, ILlmGateway gateway, ILLMRequestContextAccessor llmRequestContext)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
    }

    /// <summary>
    /// 动态列表（按时间倒序分页），支持按人 / 模块 / 时间范围筛选。
    /// </summary>
    [HttpGet("logs")]
    public async Task<IActionResult> ListLogs(
        [FromQuery] string? userId = null,
        [FromQuery] string? module = null,
        [FromQuery] DateTime? from = null,
        [FromQuery] DateTime? to = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 30)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var b = Builders<ActivityLog>.Filter;
        var filters = new List<FilterDefinition<ActivityLog>>();
        if (!string.IsNullOrWhiteSpace(userId)) filters.Add(b.Eq(x => x.ActorId, userId));
        if (!string.IsNullOrWhiteSpace(module)) filters.Add(b.Eq(x => x.Module, module));
        if (from.HasValue) filters.Add(b.Gte(x => x.CreatedAt, from.Value.ToUniversalTime()));
        if (to.HasValue) filters.Add(b.Lte(x => x.CreatedAt, to.Value.ToUniversalTime()));
        var filter = filters.Count == 0 ? b.Empty : b.And(filters);

        var total = await _db.ActivityLogs.CountDocumentsAsync(filter);
        var logs = await _db.ActivityLogs.Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        var actorIds = logs.Select(l => l.ActorId).Distinct().ToList();
        var actorMap = (await _db.Users.Find(u => actorIds.Contains(u.UserId)).ToListAsync())
            .ToDictionary(u => u.UserId, u => new { u.DisplayName, u.AvatarFileName });

        var items = logs.Select(l =>
        {
            actorMap.TryGetValue(l.ActorId, out var actor);
            return new
            {
                id = l.Id,
                actorId = l.ActorId,
                actorName = actor?.DisplayName,
                actorAvatarFileName = actor?.AvatarFileName,
                module = l.Module,
                moduleLabel = l.ModuleLabel,
                action = l.Action,
                actionLabel = l.ActionLabel,
                targetId = l.TargetId,
                targetTitle = l.TargetTitle,
                targetUrl = l.TargetUrl,
                createdAt = l.CreatedAt,
            };
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>
    /// 动态聚合统计（团队脉搏面板用）：总量 / 活跃成员 / 模块分布 / 成员排行 / 小时直方图。
    /// 模块与成员计数为精确聚合；小时直方图基于最近 HourSampleCap 条采样（覆盖今天/本周绰绰有余）。
    /// </summary>
    [HttpGet("stats")]
    public async Task<IActionResult> Stats(
        [FromQuery] string? userId = null,
        [FromQuery] string? module = null,
        [FromQuery] DateTime? from = null,
        [FromQuery] DateTime? to = null)
    {
        const int HourSampleCap = 5000;
        const int TopActorCap = 10;

        var b = Builders<ActivityLog>.Filter;
        var filters = new List<FilterDefinition<ActivityLog>>();
        if (!string.IsNullOrWhiteSpace(userId)) filters.Add(b.Eq(x => x.ActorId, userId));
        if (!string.IsNullOrWhiteSpace(module)) filters.Add(b.Eq(x => x.Module, module));
        if (from.HasValue) filters.Add(b.Gte(x => x.CreatedAt, from.Value.ToUniversalTime()));
        if (to.HasValue) filters.Add(b.Lte(x => x.CreatedAt, to.Value.ToUniversalTime()));
        var filter = filters.Count == 0 ? b.Empty : b.And(filters);

        var total = await _db.ActivityLogs.CountDocumentsAsync(filter);

        // 环比：取「同长度的上一个时间窗」总量（如今天 vs 昨天同窗、本周 vs 上周）。
        // 无 from（全部范围）时没有可比窗口，返回 null 前端不展示。
        long? previousTotal = null;
        if (from.HasValue)
        {
            var fromUtc = from.Value.ToUniversalTime();
            var endUtc = to?.ToUniversalTime() ?? DateTime.UtcNow;
            var span = endUtc - fromUtc;
            if (span > TimeSpan.Zero)
            {
                var prevFilters = new List<FilterDefinition<ActivityLog>>();
                if (!string.IsNullOrWhiteSpace(userId)) prevFilters.Add(b.Eq(x => x.ActorId, userId));
                if (!string.IsNullOrWhiteSpace(module)) prevFilters.Add(b.Eq(x => x.Module, module));
                prevFilters.Add(b.Gte(x => x.CreatedAt, fromUtc - span));
                prevFilters.Add(b.Lt(x => x.CreatedAt, fromUtc));
                previousTotal = await _db.ActivityLogs.CountDocumentsAsync(b.And(prevFilters));
            }
        }

        var moduleGroups = await _db.ActivityLogs.Aggregate()
            .Match(filter)
            .Group(x => x.Module, g => new { Module = g.Key, Count = g.Count() })
            .ToListAsync();
        var moduleLabelMap = ActivityActionRegistry.Modules.ToDictionary(m => m.Key, m => m.Label);
        var modules = moduleGroups
            .OrderByDescending(m => m.Count)
            .Select(m => new
            {
                key = m.Module,
                label = moduleLabelMap.TryGetValue(m.Module, out var label) ? label : m.Module,
                count = m.Count,
            })
            .ToList();

        var actorGroups = await _db.ActivityLogs.Aggregate()
            .Match(filter)
            .Group(x => x.ActorId, g => new { ActorId = g.Key, Count = g.Count() })
            .SortByDescending(x => x.Count)
            .ToListAsync();
        var topActors = actorGroups.Take(TopActorCap).ToList();
        var actorIds = topActors.Select(a => a.ActorId).ToList();
        var actorMap = (await _db.Users.Find(u => actorIds.Contains(u.UserId)).ToListAsync())
            .ToDictionary(u => u.UserId, u => new { u.DisplayName, u.AvatarFileName });
        var actors = topActors.Select(a =>
        {
            actorMap.TryGetValue(a.ActorId, out var actor);
            return new
            {
                actorId = a.ActorId,
                actorName = actor?.DisplayName,
                actorAvatarFileName = actor?.AvatarFileName,
                count = a.Count,
            };
        }).ToList();

        // 动作类型分布（右栏分类统计面板用）：标签/模块从白名单注册表解析，历史遗留动作兜底显示原始 key
        var actionGroups = await _db.ActivityLogs.Aggregate()
            .Match(filter)
            .Group(x => x.Action, g => new { Action = g.Key, Count = g.Count() })
            .SortByDescending(x => x.Count)
            .Limit(10)
            .ToListAsync();
        var actions = actionGroups.Select(a =>
        {
            ActivityActionRegistry.Actions.TryGetValue(a.Action, out var def);
            return new
            {
                action = a.Action,
                label = def?.ActionLabel ?? a.Action,
                module = def?.Module ?? string.Empty,
                count = a.Count,
            };
        }).ToList();

        // 小时直方图：只投影 CreatedAt 在内存里数桶，避免依赖 $hour 表达式翻译；时区旋转交给前端
        var times = await _db.ActivityLogs.Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Limit(HourSampleCap)
            .Project(x => x.CreatedAt)
            .ToListAsync();
        var hourlyUtc = new int[24];
        foreach (var t in times) hourlyUtc[t.ToUniversalTime().Hour]++;

        return Ok(ApiResponse<object>.Ok(new
        {
            total,
            previousTotal,
            activeMembers = actorGroups.Count,
            modules,
            actors,
            actions,
            hourlyUtc,
            sampled = total > HourSampleCap,
        }));
    }

    // ────────────────────────── 行为洞察 ──────────────────────────

    private sealed record Insight(
        string Kind,
        string KindLabel,
        string Target,
        int UserCount,
        long EventCount,
        string Metric,
        string Suggestion,
        List<string> Evidence,
        double Severity);

    /// <summary>归一化路径：把数字 / 长 hex / GUID 路径段替换为 :id，避免同一页面被参数打散</summary>
    private static string NormalizePath(string path)
    {
        var segments = path.Split('/');
        for (var i = 0; i < segments.Length; i++)
        {
            var s = segments[i];
            if (s.Length == 0) continue;
            var isDigits = s.All(char.IsDigit);
            var isHex = s.Length >= 16 && s.All(c => char.IsDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') || c == '-');
            if (isDigits || isHex) segments[i] = ":id";
        }
        return string.Join('/', segments);
    }

    /// <summary>
    /// 行为洞察：从「沉默的行为信号」聚合出带证据的改进方向。
    /// 数据源两路：apirequestlogs（报错热点 / 等待过久，历史即有）+ behavior_events（停留过久 / 秒退 / 反复横跳，自采集上线起累积）。
    /// 全部为规则式聚类（阈值见各段注释），只输出聚合结果不含个体明细。
    /// </summary>
    [HttpGet("insights")]
    public async Task<IActionResult> Insights(
        [FromQuery] DateTime? from = null,
        [FromQuery] DateTime? to = null,
        [FromQuery] bool includeIgnored = false)
    {
        var endUtc = to?.ToUniversalTime() ?? DateTime.UtcNow;
        // 未指定范围时取近 30 天：洞察是「最近哪里不好用」，扫全史既慢又稀释信号
        var fromUtc = from?.ToUniversalTime() ?? endUtc.AddDays(-30);
        var (insights, behaviorEventCount) = await ComputeInsightsAsync(fromUtc, endUtc);
        return await BuildInsightsResponseAsync(insights, behaviorEventCount, fromUtc, endUtc, includeIgnored);
    }

    /// <summary>规则式信号聚类（供 insights 查询与 AI 简报共用）</summary>
    private async Task<(List<Insight> Insights, int BehaviorEventCount)> ComputeInsightsAsync(DateTime fromUtc, DateTime endUtc)
    {
        var insights = new List<Insight>();

        // ── 信号 A：报错热点（apirequestlogs，排除鉴权噪音 401）──
        var rb = Builders<ApiRequestLog>.Filter;
        var errLogs = await _db.ApiRequestLogs.Find(rb.And(
                rb.Gte(x => x.StartedAt, fromUtc),
                rb.Lte(x => x.StartedAt, endUtc),
                rb.Ne(x => x.Direction, "outbound"),
                rb.Gte(x => x.StatusCode, 400),
                rb.Ne(x => x.StatusCode, 401)))
            .SortByDescending(x => x.StartedAt)
            .Limit(20000)
            .Project(x => new { x.Path, x.Method, x.StatusCode, x.ErrorCode, x.UserId })
            .ToListAsync();

        foreach (var g in errLogs
                     .Where(x => x.Path != null && x.Path.StartsWith("/api") && !x.Path.StartsWith("/api/behavior"))
                     .GroupBy(x => (Path: NormalizePath(x.Path!), x.Method, x.StatusCode))
                     .Where(g => g.Count() >= 5))
        {
            var count = g.Count();
            var users = g.Select(x => x.UserId).Distinct().Count();
            var topCode = g.Where(x => !string.IsNullOrEmpty(x.ErrorCode))
                .GroupBy(x => x.ErrorCode!).OrderByDescending(c => c.Count()).FirstOrDefault();
            insights.Add(new Insight(
                Kind: "api-error",
                KindLabel: "频繁报错",
                Target: $"{g.Key.Method} {g.Key.Path}",
                UserCount: users,
                EventCount: count,
                Metric: $"HTTP {g.Key.StatusCode} × {count}",
                Suggestion: g.Key.StatusCode >= 500
                    ? "服务端错误高频出现，优先修复；用户遇到 5xx 通常会直接放弃当前操作"
                    : "该接口在真实使用中高频失败，排查最常见错误码的触发条件；若属参数/状态校验，应把校验前移到前端并给出可行动的提示文案",
                Evidence: new List<string>
                {
                    $"{count} 次失败，{users} 人遇到",
                    topCode != null ? $"最常见错误码 {topCode.Key}（{topCode.Count()} 次）" : "无业务错误码（多为框架层拒绝）",
                },
                Severity: count * (g.Key.StatusCode >= 500 ? 3 : 1) + users * 2));
        }

        // ── 信号 B：等待过久（apirequestlogs 中 ≥3s 的非流式慢请求）──
        var slowLogs = await _db.ApiRequestLogs.Find(rb.And(
                rb.Gte(x => x.StartedAt, fromUtc),
                rb.Lte(x => x.StartedAt, endUtc),
                rb.Ne(x => x.Direction, "outbound"),
                rb.Eq(x => x.IsEventStream, false),
                rb.Gte(x => x.DurationMs, 3000)))
            .SortByDescending(x => x.StartedAt)
            .Limit(20000)
            .Project(x => new { x.Path, x.Method, x.DurationMs, x.UserId })
            .ToListAsync();

        foreach (var g in slowLogs
                     .Where(x => x.Path != null && x.Path.StartsWith("/api"))
                     .GroupBy(x => (Path: NormalizePath(x.Path!), x.Method))
                     .Where(g => g.Count() >= 5))
        {
            var count = g.Count();
            var users = g.Select(x => x.UserId).Distinct().Count();
            var avgSec = g.Average(x => (double)(x.DurationMs ?? 0)) / 1000.0;
            insights.Add(new Insight(
                Kind: "slow-endpoint",
                KindLabel: "等待过久",
                Target: $"{g.Key.Method} {g.Key.Path}",
                UserCount: users,
                EventCount: count,
                Metric: $"慢请求均值 {avgSec:F1}s",
                Suggestion: "等待超过 3 秒且无流式反馈即为体验缺陷：优先做流式/分页/缓存/异步化，至少给阶段性进度提示",
                Evidence: new List<string>
                {
                    $"{count} 次 ≥3s 的请求，{users} 人等待过",
                    $"慢请求平均耗时 {avgSec:F1}s",
                },
                Severity: count + avgSec * 5 + users * 2));
        }

        // ── 行为事件（采集自上线起）──
        var bb = Builders<BehaviorEvent>.Filter;
        var events = await _db.BehaviorEvents.Find(bb.And(
                bb.Gte(x => x.OccurredAt, fromUtc),
                bb.Lte(x => x.OccurredAt, endUtc)))
            .SortByDescending(x => x.OccurredAt)
            .Limit(50000)
            .Project(x => new { x.Type, x.Route, x.FromRoute, x.DwellMs, x.UserId, x.OccurredAt })
            .ToListAsync();

        // ── 信号 C/D：停留过久 + 秒退（route-dwell）──
        var dwells = events.Where(e => e.Type == "route-dwell" && e.DwellMs.HasValue).ToList();
        foreach (var g in dwells.GroupBy(e => e.Route).Where(g => g.Count() >= 8))
        {
            var count = g.Count();
            var users = g.Select(x => x.UserId).Distinct().Count();
            var avgMs = g.Average(x => (double)x.DwellMs!.Value);
            var bounce = g.Count(x => x.DwellMs!.Value < 5000);
            var bounceRate = (double)bounce / count;

            // 停留过久：平均可见停留 ≥3 分钟（内容消费页属正常，由产品负责人结合页面性质判断）
            if (avgMs >= 180_000)
            {
                insights.Add(new Insight(
                    Kind: "long-dwell",
                    KindLabel: "停留过久",
                    Target: g.Key,
                    UserCount: users,
                    EventCount: count,
                    Metric: $"平均停留 {avgMs / 60000.0:F1} 分钟",
                    Suggestion: "若该页不是内容消费页，长停留通常意味着「找不到下一步」：检查主操作是否一眼可见、是否缺少引导（3 秒原则）",
                    Evidence: new List<string>
                    {
                        $"{count} 次访问，{users} 人",
                        $"平均可见停留 {avgMs / 60000.0:F1} 分钟（已剔除切走标签页的时间）",
                    },
                    Severity: avgMs / 60000.0 * users));
            }

            // 秒退：≥40% 的进入在 5 秒内离开
            if (count >= 10 && bounceRate >= 0.4)
            {
                insights.Add(new Insight(
                    Kind: "quick-exit",
                    KindLabel: "秒退放弃",
                    Target: g.Key,
                    UserCount: users,
                    EventCount: count,
                    Metric: $"秒退率 {bounceRate * 100:F0}%",
                    Suggestion: "大量进入在 5 秒内离开：入口承诺与页面承接不匹配，或首屏没有给出「这是什么/能做什么」（检查入口文案与空状态引导）",
                    Evidence: new List<string>
                    {
                        $"{count} 次进入中 {bounce} 次在 5 秒内离开，涉及 {users} 人",
                    },
                    Severity: bounceRate * 100 + count / 10.0));
            }
        }

        // ── 信号 E：反复横跳（同一用户 2 分钟内 A→B→A 折返，按页面对聚类）──
        var oscillations = new Dictionary<string, (int Trips, HashSet<string> Users, string A, string B)>();
        foreach (var userGroup in events
                     .Where(e => e.Type == "route-transition" && !string.IsNullOrEmpty(e.FromRoute) && e.FromRoute != e.Route)
                     .GroupBy(e => e.UserId))
        {
            var seq = userGroup.OrderBy(e => e.OccurredAt).ToList();
            for (var i = 0; i + 1 < seq.Count; i++)
            {
                var cur = seq[i];
                var next = seq[i + 1];
                var isReturn = next.FromRoute == cur.Route && next.Route == cur.FromRoute;
                if (!isReturn || (next.OccurredAt - cur.OccurredAt) > TimeSpan.FromMinutes(2)) continue;
                var pair = string.CompareOrdinal(cur.FromRoute, cur.Route) <= 0
                    ? (A: cur.FromRoute!, B: cur.Route)
                    : (A: cur.Route, B: cur.FromRoute!);
                var key = $"{pair.A}{pair.B}";
                if (!oscillations.TryGetValue(key, out var agg)) agg = (0, new HashSet<string>(), pair.A, pair.B);
                agg.Trips++;
                agg.Users.Add(userGroup.Key);
                oscillations[key] = agg;
            }
        }

        foreach (var (_, agg) in oscillations.Where(kv => kv.Value.Trips >= 3))
        {
            insights.Add(new Insight(
                Kind: "route-oscillation",
                KindLabel: "反复横跳",
                Target: $"{agg.A} ↔ {agg.B}",
                UserCount: agg.Users.Count,
                EventCount: agg.Trips,
                Metric: $"2 分钟内折返 {agg.Trips} 次",
                Suggestion: "用户在两页之间反复对照：考虑把关键信息并排展示、提供跨页摘要，或在其中一页内嵌另一页的关键数据",
                Evidence: new List<string>
                {
                    $"{agg.Users.Count} 人发生 {agg.Trips} 次快速折返（2 分钟内 A→B→A）",
                },
                Severity: agg.Trips * 4 + agg.Users.Count * 3));
        }

        return (insights, events.Count);
    }

    private async Task<IActionResult> BuildInsightsResponseAsync(
        List<Insight> insights, int behaviorEventCount, DateTime fromUtc, DateTime endUtc, bool includeIgnored)
    {
        // 采集起点：让前端能诚实告知「路由级信号从何时开始有数据」
        var earliest = await _db.BehaviorEvents.Find(FilterDefinition<BehaviorEvent>.Empty)
            .SortBy(x => x.CreatedAt)
            .Limit(1)
            .Project(x => x.CreatedAt)
            .FirstOrDefaultAsync();

        // 洞察生命周期：按指纹挂处理状态（确认/已修复/忽略），忽略的默认不再出现
        var fingerprints = insights.Select(i => $"{i.Kind}|{i.Target}").ToList();
        var states = (await _db.BehaviorInsightStates
                .Find(Builders<BehaviorInsightState>.Filter.In(x => x.Fingerprint, fingerprints))
                .ToListAsync())
            .GroupBy(x => x.Fingerprint)
            .ToDictionary(g => g.Key, g => g.OrderByDescending(x => x.UpdatedAt).First());

        var visible = insights
            .Where(i => includeIgnored
                || !states.TryGetValue($"{i.Kind}|{i.Target}", out var st)
                || st.Status != "ignored")
            .OrderByDescending(i => i.Severity)
            .Take(30)
            .Select(i =>
            {
                states.TryGetValue($"{i.Kind}|{i.Target}", out var st);
                return new
                {
                    kind = i.Kind,
                    kindLabel = i.KindLabel,
                    target = i.Target,
                    userCount = i.UserCount,
                    eventCount = i.EventCount,
                    metric = i.Metric,
                    suggestion = i.Suggestion,
                    evidence = i.Evidence,
                    status = st?.Status,
                    defectId = st?.DefectId,
                    defectTitle = st?.DefectTitle,
                };
            })
            .ToList();

        var ignoredCount = insights.Count(i =>
            states.TryGetValue($"{i.Kind}|{i.Target}", out var st) && st.Status == "ignored");

        return Ok(ApiResponse<object>.Ok(new
        {
            items = visible,
            ignoredCount,
            behaviorEventCount,
            trackedSince = earliest == default ? (DateTime?)null : earliest,
            windowFrom = fromUtc,
            windowTo = endUtc,
        }));
    }

    /// <summary>
    /// AI 行为洞察简报（SSE 流式）：把当前窗口的洞察聚合结果交给 LLM，
    /// 生成面向产品负责人的中文简报。事件：model / delta / done / error。
    /// 遵循 server-authority：LLM 调用用 CancellationToken.None，客户端断开只停写不停算。
    /// </summary>
    [HttpGet("insights/brief")]
    public async Task InsightBriefStream([FromQuery] DateTime? from = null, [FromQuery] DateTime? to = null)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        var userId = this.GetRequiredUserId();
        var endUtc = to?.ToUniversalTime() ?? DateTime.UtcNow;
        var fromUtc = from?.ToUniversalTime() ?? endUtc.AddDays(-30);

        await WriteSseAsync("phase", new { message = "正在聚合行为信号…" });
        var (insights, behaviorEventCount) = await ComputeInsightsAsync(fromUtc, endUtc);
        var top = insights.OrderByDescending(i => i.Severity).Take(15).ToList();
        if (top.Count == 0)
        {
            await WriteSseAsync("error", new { message = "当前窗口没有形成任何洞察，无需生成简报" });
            return;
        }

        var lines = new StringBuilder();
        lines.AppendLine($"分析窗口：{fromUtc:yyyy-MM-dd} ~ {endUtc:yyyy-MM-dd}，路由级行为事件 {behaviorEventCount} 条。");
        foreach (var i in top)
        {
            lines.AppendLine($"- [{i.KindLabel}] {i.Target} | {i.Metric} | {i.UserCount} 人 / {i.EventCount} 次 | 证据: {string.Join("；", i.Evidence)}");
        }

        var systemPrompt =
            "你是产品团队的行为洞察分析师。下面是从用户真实操作轨迹聚合出的洞察清单" +
            "（频繁报错 / 等待过久 / 停留过久 / 秒退放弃 / 反复横跳）。" +
            "请用中文写一份给产品负责人的简报（Markdown，禁止使用 emoji）：" +
            "1) 一段 80 字以内的总体判断；2) 按影响度排出 3-5 个最值得处理的问题，" +
            "每个问题给出现象、影响面、最可能的根因猜想、建议动作；3) 一段「本期可以不管」的说明，" +
            "解释哪些信号可能是正常行为（如内容消费页停留长）。证据不足时如实说明，禁止编造数据。";

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: lines.Length,
            DocumentHash: null,
            SystemPromptRedacted: "[TeamActivity-InsightBrief]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.Admin.TeamActivity.InsightBrief));

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.Admin.TeamActivity.InsightBrief,
            ModelType = ModelTypes.Chat,
            Stream = true,
            TimeoutSeconds = 300,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = lines.ToString() },
                },
                ["temperature"] = 0.4,
                ["max_tokens"] = 8192,
            },
        };

        var clientGone = false;
        var sentModel = false;
        // SSE 心跳：长思考间隙没有任何字节会被代理按空闲连接掐断（server-authority 规则要求 10s 心跳）
        var writeLock = new SemaphoreSlim(1, 1);
        using var heartbeatCts = new CancellationTokenSource();
        var heartbeat = Task.Run(async () =>
        {
            try
            {
                while (!heartbeatCts.Token.IsCancellationRequested)
                {
                    await Task.Delay(TimeSpan.FromSeconds(10), heartbeatCts.Token);
                    if (clientGone) continue;
                    await writeLock.WaitAsync(heartbeatCts.Token);
                    try
                    {
                        await Response.WriteAsync(": keepalive\n\n", CancellationToken.None);
                        await Response.Body.FlushAsync(CancellationToken.None);
                    }
                    catch (ObjectDisposedException) { clientGone = true; }
                    finally { writeLock.Release(); }
                }
            }
            catch (OperationCanceledException) { }
        });

        async Task SendAsync(string eventName, object? payload)
        {
            await writeLock.WaitAsync();
            try { await WriteSseAsync(eventName, payload); }
            finally { writeLock.Release(); }
        }

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && !sentModel && chunk.Resolution != null)
                {
                    sentModel = true;
                    if (!clientGone)
                    {
                        try { await SendAsync("model", new { model = chunk.Resolution.ActualModel, platform = chunk.Resolution.ActualPlatformName }); }
                        catch (ObjectDisposedException) { clientGone = true; }
                    }
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    if (!clientGone)
                    {
                        try { await SendAsync("delta", new { text = chunk.Content }); }
                        catch (ObjectDisposedException) { clientGone = true; }
                    }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    if (!clientGone) { try { await SendAsync("error", new { message = chunk.Error ?? "LLM 网关返回未知错误" }); } catch { } }
                    return;
                }
            }
            if (!clientGone) { try { await SendAsync("done", new { complete = true }); } catch (ObjectDisposedException) { } }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
        catch (Exception ex)
        {
            if (!clientGone) { try { await SendAsync("error", new { message = ex.Message }); } catch { } }
        }
        finally
        {
            heartbeatCts.Cancel();
            try { await heartbeat; } catch { /* 心跳收尾异常不影响响应 */ }
        }
    }

    private async Task WriteSseAsync(string eventName, object? data)
    {
        var dataLine = data == null
            ? "null"
            : JsonSerializer.Serialize(data, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
        await Response.WriteAsync($"event: {eventName}\ndata: {dataLine}\n\n", CancellationToken.None);
        await Response.Body.FlushAsync(CancellationToken.None);
    }

    public record SetInsightStateRequest(string Kind, string Target, string Status, string? DefectId, string? DefectTitle);

    /// <summary>
    /// 设置洞察处理状态（洞察生命周期）。status: confirmed / resolved / ignored / open（open = 清除状态恢复待处理）。
    /// </summary>
    [HttpPost("insights/state")]
    public async Task<IActionResult> SetInsightState([FromBody] SetInsightStateRequest request)
    {
        var allowed = new[] { "confirmed", "resolved", "ignored", "open" };
        if (string.IsNullOrWhiteSpace(request.Kind) || string.IsNullOrWhiteSpace(request.Target)
            || !allowed.Contains(request.Status))
        {
            return Ok(ApiResponse<object>.Fail("INVALID_ARGUMENT", "kind/target/status 不合法"));
        }

        var fingerprint = $"{request.Kind}|{request.Target}";
        if (request.Status == "open")
        {
            await _db.BehaviorInsightStates.DeleteManyAsync(x => x.Fingerprint == fingerprint);
            return Ok(ApiResponse<object>.Ok(new { fingerprint, status = (string?)null }));
        }

        var userId = this.GetRequiredUserId();
        var update = Builders<BehaviorInsightState>.Update
            .Set(x => x.Kind, request.Kind)
            .Set(x => x.Target, request.Target)
            .Set(x => x.Status, request.Status)
            .Set(x => x.UpdatedBy, userId)
            .Set(x => x.UpdatedAt, DateTime.UtcNow)
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
            .SetOnInsert(x => x.CreatedAt, DateTime.UtcNow);
        // 转缺陷时记录关联；普通状态流转不覆盖已有关联
        if (!string.IsNullOrWhiteSpace(request.DefectId))
        {
            update = update.Set(x => x.DefectId, request.DefectId).Set(x => x.DefectTitle, request.DefectTitle);
        }
        await _db.BehaviorInsightStates.UpdateOneAsync(
            x => x.Fingerprint == fingerprint,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { fingerprint, status = request.Status }));
    }

    /// <summary>
    /// 模块筛选清单（来自白名单注册表，避免前后端模块清单漂移）。
    /// </summary>
    [HttpGet("modules")]
    public IActionResult ListModules()
    {
        var items = ActivityActionRegistry.Modules
            .Select(m => new { key = m.Key, label = m.Label })
            .ToList();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }
}
