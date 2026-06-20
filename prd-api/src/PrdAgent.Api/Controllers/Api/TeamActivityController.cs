using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
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
[AdminController("team-activity", AdminPermissionCatalog.TeamActivityRead, WritePermission = AdminPermissionCatalog.TeamActivityManage)]
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

    /// <summary>路径首段（/api/{module}/...）→ 中文模块名，用于体验全景热力图分区；未登记的回落原始段</summary>
    private static readonly Dictionary<string, string> ModuleLabels = new()
    {
        ["visual-agent"] = "视觉创作", ["image-master"] = "视觉创作", ["literary-agent"] = "文学创作",
        ["defect"] = "缺陷管理", ["defects"] = "缺陷管理", ["weekly-posters"] = "周报海报",
        ["report-agent"] = "周报管理", ["ai-news"] = "AI 资讯", ["changelog"] = "更新中心",
        ["ccas-agent"] = "渠道溯源", ["document-store"] = "知识库", ["documents"] = "文档",
        ["sessions"] = "会话", ["groups"] = "项目", ["pr-review"] = "PR 审查",
        ["emergence"] = "涌现探索", ["workflow"] = "工作流", ["open-platform"] = "开放平台",
        ["marketplace"] = "海鲜市场", ["llm"] = "LLM 网关", ["models"] = "模型",
        ["model-groups"] = "模型组", ["auth"] = "认证", ["authz"] = "权限鉴权", ["users"] = "用户",
        ["attachments"] = "附件", ["hosted-sites"] = "网页托管", ["video"] = "视频",
        ["watermark"] = "水印", ["admin"] = "后台管理", ["review"] = "产品评审",
        ["submissions"] = "产品评审", ["mentions"] = "引用网络", ["toolbox"] = "百宝箱",
        ["ai-toolbox"] = "AI 百宝箱", ["daily-tips"] = "每日教程", ["dashboard"] = "仪表盘",
        ["shortcuts"] = "快捷入口", ["pm"] = "产品经理", ["v1"] = "开放接口",
        ["homepage"] = "首页", ["peer-sync"] = "节点同步", ["product"] = "产品管理",
        ["library"] = "智识殿堂", ["showcase"] = "作品广场", ["learning-center"] = "学习中心",
        ["notifications"] = "通知", ["preferences"] = "偏好", ["share"] = "分享",
        ["skills"] = "技能", ["prompts"] = "提示词", ["behavior"] = "行为采集",
        ["channel"] = "渠道", ["tapd"] = "TAPD", ["video-agent"] = "视频生成",
    };

    private static string ModuleLabel(string key) => ModuleLabels.TryGetValue(key, out var l) ? l : key;

    /// <summary>端点路径段 → 中文示意名（让非技术同事看得懂每块代表什么）；未登记的回落原始段</summary>
    private static readonly Dictionary<string, string> SegmentLabels = new()
    {
        ["entries"] = "条目", ["entry"] = "条目", ["view"] = "浏览", ["views"] = "浏览量",
        ["visible"] = "可见项", ["progress"] = "进度", ["track"] = "行为埋点", ["content"] = "内容",
        ["upload"] = "上传", ["leave"] = "离开", ["stores"] = "空间", ["store"] = "空间",
        ["inline-comments"] = "行内评论", ["inline-comment"] = "行内评论", ["with-preview"] = "带预览",
        ["preview"] = "预览", ["public"] = "公开列表", ["creators"] = "创作者", ["current-week"] = "本周",
        ["current"] = "当前", ["latest"] = "最新", ["attachments"] = "附件", ["login"] = "登录",
        ["refresh"] = "刷新令牌", ["logout"] = "登出", ["user-preferences"] = "偏好设置",
        ["version-check"] = "版本检查", ["requirements"] = "需求", ["products"] = "产品",
        ["features"] = "功能", ["releases"] = "发布", ["versions"] = "版本",
        ["workflow-definitions"] = "工作流定义", ["stats"] = "统计", ["defects"] = "缺陷",
        ["form-templates"] = "表单模板", ["me"] = "当前用户", ["menu-catalog"] = "菜单目录",
        ["items"] = "条目", ["marketplace"] = "市场", ["search-users"] = "搜索用户",
        ["assets"] = "静态资源", ["transfer"] = "数据传输", ["mark-seen"] = "标记已读",
        ["generate"] = "生成", ["list"] = "列表", ["likes"] = "点赞", ["favorites"] = "收藏",
        ["comments"] = "评论", ["summary"] = "汇总", ["brief"] = "简报", ["state"] = "状态",
        ["sync"] = "同步", ["logs"] = "日志", ["stream"] = "流式", ["export"] = "导出",
        ["import"] = "导入", ["publish"] = "发布", ["clone"] = "复制", ["fork"] = "克隆",
        ["run"] = "运行", ["runs"] = "运行记录", ["events"] = "事件", ["detail"] = "详情",
        ["settings"] = "设置", ["modules"] = "模块", ["insights"] = "洞察", ["members"] = "成员",
        ["customer"] = "客户", ["customers"] = "客户", ["dashboard"] = "仪表盘",
        ["session"] = "会话", ["messages"] = "消息", ["comment"] = "评论", ["share"] = "分享",
        ["download"] = "下载", ["status"] = "状态", ["health"] = "健康检查", ["test"] = "测试",
    };

    /// <summary>把归一化端点路径压成一个中文示意名：取末尾有意义的资源/动作段翻译，:id 段跳过</summary>
    private static string LeafLabel(string method, string normalizedPath)
    {
        var seg = normalizedPath
            .Split('/', StringSplitOptions.RemoveEmptyEntries)
            .Where(s => s != "api" && s != ":id")
            .ToList();
        if (seg.Count == 0) return "根";
        // 只有模块段（如 /api/sessions）→ 用模块中文名
        if (seg.Count == 1) return ModuleLabel(seg[0]);
        var token = seg[^1];
        return SegmentLabels.TryGetValue(token, out var zh) ? zh : token;
    }


    /// <summary>体验全景热力图的叶子累加器（按 module|method|归一化路径 聚类）</summary>
    private sealed class LeafAcc
    {
        public string Module = string.Empty;
        public string Method = string.Empty;
        public string Path = string.Empty;
        public int Count;
        public int ErrorCount;
        public int SlowCount;
        public long SlowMsSum;
        public readonly Dictionary<string, int> ErrorCodes = new();
    }

    /// <summary>体验全景热力图的叶子输出（聚合主路径与旧路径共用，喂给 BuildExperienceMapPayload）。BurstPct 为环比突增百分比，可空。</summary>
    private sealed record LeafOut(string Target, string Label, string Method, int Value, double ErrRate, double SlowRate, string Status, string Metric, int? BurstPct = null);

    // 体验全景热力图短 TTL 缓存：来回切时间档不重复聚合（key 取整到分钟）
    private static readonly ConcurrentDictionary<string, (DateTime At, object Payload)> _expMapCache = new();
    private const int ExpMapCacheSeconds = 30;

    /// <summary>把 module → 叶子列表 组装成 treemap 响应（分区 Take 24、每区叶子 Take 30）</summary>
    private static object BuildExperienceMapPayload(Dictionary<string, List<LeafOut>> byModule, long totalRequests, DateTime fromUtc, DateTime endUtc)
    {
        var groups = byModule
            .Select(kv =>
            {
                var leaves = kv.Value
                    .OrderByDescending(l => l.Value)
                    .Take(30)
                    .Select(l => new
                    {
                        target = l.Target,
                        label = l.Label,
                        method = l.Method,
                        value = l.Value,
                        status = l.Status,
                        metric = l.Metric,
                        errorRate = l.ErrRate,
                        slowRate = l.SlowRate,
                        topErrorCode = (string?)null,
                        burstPct = l.BurstPct,
                    })
                    .ToList();
                return new
                {
                    key = kv.Key,
                    label = ModuleLabel(kv.Key),
                    value = leaves.Sum(l => l.value),
                    errorLeaves = leaves.Count(l => l.status == "error"),
                    slowLeaves = leaves.Count(l => l.status == "slow"),
                    leaves,
                };
            })
            .Where(g => g.leaves.Count > 0)
            .OrderByDescending(g => g.value)
            .Take(24)
            .ToList();

        return new { groups, totalRequests, windowFrom = fromUtc, windowTo = endUtc };
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

    /// <summary>
    /// 体验全景热力图：把系统接口面铺成 treemap —— 按模块（/api/{module}）分区，
    /// 叶子为归一化端点，面积=访问量，颜色=健康（报错率/慢请求率）。
    /// 痛点（红=报错、琥珀=慢）从一片平静里跳出来；叶子 target 与 insights 同口径，便于前端点击下钻联动。
    /// 单一数据源 apirequestlogs，与 insights 的报错/慢信号同源，避免口径漂移。
    /// </summary>
    [HttpGet("experience-map")]
    public async Task<IActionResult> ExperienceMap([FromQuery] DateTime? from = null, [FromQuery] DateTime? to = null)
    {
        var endUtc = to?.ToUniversalTime() ?? DateTime.UtcNow;
        var fromUtc = from?.ToUniversalTime() ?? endUtc.AddDays(-30);

        // 短 TTL 缓存：同一时间窗反复点击（尤其来回切档）直接命中，不重复聚合
        var cacheKey = $"{fromUtc:yyyyMMddHHmm}|{endUtc:yyyyMMddHHmm}";
        if (_expMapCache.TryGetValue(cacheKey, out var hit) && (DateTime.UtcNow - hit.At).TotalSeconds < ExpMapCacheSeconds)
        {
            return Ok(ApiResponse<object>.Ok(hit.Payload));
        }

        object payload;
        try
        {
            // 主路径：分组下推到 MongoDB 聚合，只回传分组桶，避免拉取数万条文档到内存
            payload = await ExperienceMapAggregateAsync(fromUtc, endUtc);
        }
        catch
        {
            // 兜底：聚合不可用时回退到「拉取 + C# 分组」旧路径，保证功能不挂
            payload = await ExperienceMapLegacyAsync(fromUtc, endUtc);
        }

        _expMapCache[cacheKey] = (DateTime.UtcNow, payload);
        if (_expMapCache.Count > 64)
        {
            foreach (var k in _expMapCache
                         .Where(e => (DateTime.UtcNow - e.Value.At).TotalSeconds > ExpMapCacheSeconds)
                         .Select(e => e.Key).ToList())
            {
                _expMapCache.TryRemove(k, out _);
            }
        }
        return Ok(ApiResponse<object>.Ok(payload));
    }

    /// <summary>主路径：MongoDB 服务端聚合（归一化路径折叠 :id → 按 method+路径分组统计），只回传分组桶</summary>
    private async Task<object> ExperienceMapAggregateAsync(DateTime fromUtc, DateTime endUtc)
    {
        var slowCond = new BsonDocument("$and", new BsonArray
        {
            new BsonDocument("$eq", new BsonArray { "$IsEventStream", false }),
            new BsonDocument("$gte", new BsonArray { "$DurationMs", 3000 }),
        });
        var pipeline = new[]
        {
            new BsonDocument("$match", new BsonDocument
            {
                { "StartedAt", new BsonDocument { { "$gte", new BsonDateTime(fromUtc) }, { "$lte", new BsonDateTime(endUtc) } } },
                { "Direction", new BsonDocument("$ne", "outbound") },
                { "Path", new BsonDocument("$regex", "^/api") },
            }),
            new BsonDocument("$set", new BsonDocument("_segs", new BsonDocument("$split", new BsonArray { "$Path", "/" }))),
            new BsonDocument("$set", new BsonDocument("_norm", new BsonDocument("$map", new BsonDocument
            {
                { "input", "$_segs" },
                { "as", "s" },
                { "in", new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$or", new BsonArray
                        {
                            new BsonDocument("$regexMatch", new BsonDocument { { "input", "$$s" }, { "regex", "^[0-9]+$" } }),
                            new BsonDocument("$regexMatch", new BsonDocument { { "input", "$$s" }, { "regex", "^[0-9a-fA-F-]{16,}$" } }),
                        }),
                        ":id",
                        "$$s",
                    }) },
            }))),
            new BsonDocument("$set", new BsonDocument("_np", new BsonDocument("$reduce", new BsonDocument
            {
                { "input", "$_norm" },
                { "initialValue", "" },
                { "in", new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$eq", new BsonArray { "$$this", "" }),
                        "$$value",
                        new BsonDocument("$concat", new BsonArray { "$$value", "/", "$$this" }),
                    }) },
            }))),
            new BsonDocument("$group", new BsonDocument
            {
                { "_id", new BsonDocument { { "m", "$Method" }, { "p", "$_np" } } },
                { "count", new BsonDocument("$sum", 1) },
                { "err", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$and", new BsonArray
                        {
                            new BsonDocument("$gte", new BsonArray { "$StatusCode", 400 }),
                            new BsonDocument("$ne", new BsonArray { "$StatusCode", 401 }),
                        }),
                        1, 0,
                    })) },
                { "slow", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray { slowCond, 1, 0 })) },
                { "slowMs", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray { slowCond, "$DurationMs", 0 })) },
            }),
            new BsonDocument("$match", new BsonDocument("count", new BsonDocument("$gte", 2))),
            new BsonDocument("$sort", new BsonDocument("count", -1)),
            new BsonDocument("$limit", 4000),
        };

        var cursor = await _db.ApiRequestLogs.AggregateAsync<BsonDocument>(pipeline, new AggregateOptions { AllowDiskUse = true });
        var buckets = await cursor.ToListAsync();

        // 环比突增：对「上一个等长窗口」做同样的轻量聚合，按 method+归一化路径 取坏请求(报错+慢)数 badPrev，
        // 用于给本窗口痛点叶子算 burstPct。失败不致命（突增字段降级为 null）。
        var prevBad = await ExperienceMapPrevWindowBadAsync(fromUtc, endUtc);

        long totalRequests = 0;
        var byModule = new Dictionary<string, List<LeafOut>>();
        foreach (var b in buckets)
        {
            var id = b["_id"].AsBsonDocument;
            var method = id.GetValue("m", "GET").AsString;
            var path = id.GetValue("p", "").AsString;
            if (string.IsNullOrEmpty(path) || !path.StartsWith("/api")) continue;
            if (path.StartsWith("/api/behavior") || path.StartsWith("/api/team-activity")) continue;
            var seg = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (seg.Length < 2) continue;
            var module = seg[1];
            var count = b.GetValue("count", 0).ToInt32();
            var err = b.GetValue("err", 0).ToInt32();
            var slow = b.GetValue("slow", 0).ToInt32();
            var slowMs = b.GetValue("slowMs", 0).ToDouble();
            totalRequests += count;
            var errRate = count > 0 ? (double)err / count : 0;
            var slowRate = count > 0 ? (double)slow / count : 0;
            var status = count >= 10 && errRate >= 0.05 && err >= 5 ? "error"
                : count >= 10 && slowRate >= 0.10 && slow >= 5 ? "slow"
                : "ok";
            var avgSlowSec = slow > 0 ? slowMs / slow / 1000.0 : 0;
            var metric = status == "error"
                ? $"报错率 {errRate * 100:F0}%（{err} 次）"
                : status == "slow"
                    ? $"{slow} 次慢请求 · 均 {avgSlowSec:F1}s"
                    : $"{count} 次调用";
            var target = $"{method} {path}";
            var burstPct = ComputeBurstPct(status, err + slow, prevBad.GetValueOrDefault($"{method}|{path}", 0));
            if (!byModule.TryGetValue(module, out var list)) { list = new List<LeafOut>(); byModule[module] = list; }
            list.Add(new LeafOut(target, LeafLabel(method, path), method, count, Math.Round(errRate, 3), Math.Round(slowRate, 3), status, metric, burstPct));
        }

        return BuildExperienceMapPayload(byModule, totalRequests, fromUtc, endUtc);
    }

    /// <summary>
    /// 环比突增百分比：仅痛点(status!=ok)且本窗坏请求 badCur>=5 时才给值，避免噪音。
    /// 有上一窗口基线 badPrev>0 → round((badCur-badPrev)/badPrev*100)；无基线则 null（新增由前端处理）。
    /// </summary>
    private static int? ComputeBurstPct(string status, int badCur, int badPrev)
    {
        if (status == "ok" || badCur < 5) return null;
        if (badPrev <= 0) return null;
        return (int)Math.Round((badCur - badPrev) / (double)badPrev * 100.0);
    }

    /// <summary>
    /// 上一个等长窗口(fromUtc-span .. fromUtc, span=endUtc-fromUtc)的坏请求(报错+慢)聚合，
    /// 按 method+归一化路径分组，键为 "{method}|{归一化路径}"，值为 badPrev=报错数+慢数（仅 bad>=1 的桶）。
    /// 复用 PathNormalizeStages，下推到 MongoDB $group，只回小桶。
    /// </summary>
    private async Task<Dictionary<string, int>> ExperienceMapPrevWindowBadAsync(DateTime fromUtc, DateTime endUtc)
    {
        var result = new Dictionary<string, int>();
        try
        {
            var span = endUtc - fromUtc;
            if (span <= TimeSpan.Zero) return result;
            var prevFrom = fromUtc - span;
            var prevTo = fromUtc;

            var slowCond = new BsonDocument("$and", new BsonArray
            {
                new BsonDocument("$eq", new BsonArray { "$IsEventStream", false }),
                new BsonDocument("$gte", new BsonArray { "$DurationMs", 3000 }),
            });
            var pipeline = new List<BsonDocument>
            {
                new BsonDocument("$match", new BsonDocument
                {
                    { "StartedAt", new BsonDocument { { "$gte", new BsonDateTime(prevFrom) }, { "$lt", new BsonDateTime(prevTo) } } },
                    { "Direction", new BsonDocument("$ne", "outbound") },
                    { "Path", new BsonDocument("$regex", "^/api") },
                }),
            };
            pipeline.AddRange(PathNormalizeStages());
            pipeline.Add(new BsonDocument("$group", new BsonDocument
            {
                { "_id", new BsonDocument { { "m", "$Method" }, { "p", "$_np" } } },
                { "err", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$and", new BsonArray
                        {
                            new BsonDocument("$gte", new BsonArray { "$StatusCode", 400 }),
                            new BsonDocument("$ne", new BsonArray { "$StatusCode", 401 }),
                        }),
                        1, 0,
                    })) },
                { "slow", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray { slowCond, 1, 0 })) },
            }));
            pipeline.Add(new BsonDocument("$set", new BsonDocument("badcount", new BsonDocument("$add", new BsonArray { "$err", "$slow" }))));
            pipeline.Add(new BsonDocument("$match", new BsonDocument("badcount", new BsonDocument("$gte", 1))));
            pipeline.Add(new BsonDocument("$limit", 4000));

            var cursor = await _db.ApiRequestLogs.AggregateAsync<BsonDocument>(pipeline.ToArray(), new AggregateOptions { AllowDiskUse = true });
            var buckets = await cursor.ToListAsync();
            foreach (var b in buckets)
            {
                var id = b["_id"].AsBsonDocument;
                var method = id.GetValue("m", "GET").AsString;
                var path = id.GetValue("p", "").AsString;
                if (string.IsNullOrEmpty(path)) continue;
                var bad = b.GetValue("badcount", 0).ToInt32();
                result[$"{method}|{path}"] = bad;
            }
        }
        catch
        {
            // 突增是增强项，前窗聚合失败时降级为「无基线」（burstPct 全部 null），不影响主热力图
        }
        return result;
    }

    /// <summary>兜底路径：拉取 + C# 分组（聚合管道不可用时使用，逻辑与原实现一致）</summary>
    private async Task<object> ExperienceMapLegacyAsync(DateTime fromUtc, DateTime endUtc)
    {
        var rb = Builders<ApiRequestLog>.Filter;
        var logs = await _db.ApiRequestLogs.Find(rb.And(
                rb.Gte(x => x.StartedAt, fromUtc),
                rb.Lte(x => x.StartedAt, endUtc),
                rb.Ne(x => x.Direction, "outbound")))
            .SortByDescending(x => x.StartedAt)
            .Limit(60000)
            .Project(x => new { x.Path, x.Method, x.StatusCode, x.DurationMs, x.IsEventStream, x.ErrorCode })
            .ToListAsync();

        var leafAgg = new Dictionary<string, LeafAcc>();
        foreach (var l in logs)
        {
            if (l.Path == null || !l.Path.StartsWith("/api")) continue;
            // 自身 / 行为采集端点不计入（避免洞察页统计到自己造成噪音）
            if (l.Path.StartsWith("/api/behavior") || l.Path.StartsWith("/api/team-activity")) continue;
            var seg = l.Path.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (seg.Length < 2) continue;
            var module = seg[1];
            var norm = NormalizePath(l.Path);
            var method = string.IsNullOrEmpty(l.Method) ? "GET" : l.Method;
            var key = $"{module}|{method}|{norm}";
            if (!leafAgg.TryGetValue(key, out var acc))
            {
                acc = new LeafAcc { Module = module, Method = method, Path = norm };
                leafAgg[key] = acc;
            }
            acc.Count++;
            if (l.StatusCode >= 400 && l.StatusCode != 401)
            {
                acc.ErrorCount++;
                if (!string.IsNullOrEmpty(l.ErrorCode))
                    acc.ErrorCodes[l.ErrorCode!] = acc.ErrorCodes.GetValueOrDefault(l.ErrorCode!) + 1;
            }
            if (!l.IsEventStream && (l.DurationMs ?? 0) >= 3000)
            {
                acc.SlowCount++;
                acc.SlowMsSum += l.DurationMs ?? 0;
            }
        }

        long totalRequests = 0;
        var byModule = new Dictionary<string, List<LeafOut>>();
        foreach (var a in leafAgg.Values)
        {
            if (a.Count < 2) continue;
            var errRate = a.Count > 0 ? (double)a.ErrorCount / a.Count : 0;
            var slowRate = a.Count > 0 ? (double)a.SlowCount / a.Count : 0;
            var status = a.Count >= 10 && errRate >= 0.05 && a.ErrorCount >= 5 ? "error"
                : a.Count >= 10 && slowRate >= 0.10 && a.SlowCount >= 5 ? "slow"
                : "ok";
            var avgSlowSec = a.SlowCount > 0 ? a.SlowMsSum / (double)a.SlowCount / 1000.0 : 0;
            var metric = status == "error"
                ? $"报错率 {errRate * 100:F0}%（{a.ErrorCount} 次）"
                : status == "slow"
                    ? $"{a.SlowCount} 次慢请求 · 均 {avgSlowSec:F1}s"
                    : $"{a.Count} 次调用";
            totalRequests += a.Count;
            if (!byModule.TryGetValue(a.Module, out var list)) { list = new List<LeafOut>(); byModule[a.Module] = list; }
            list.Add(new LeafOut($"{a.Method} {a.Path}", LeafLabel(a.Method, a.Path), a.Method, a.Count, Math.Round(errRate, 3), Math.Round(slowRate, 3), status, metric));
        }

        return BuildExperienceMapPayload(byModule, totalRequests, fromUtc, endUtc);
    }

    /// <summary>BsonValue → string，BsonNull/缺失回退空串</summary>
    private static string BsonToStr(BsonValue v) => v is null || v.IsBsonNull ? string.Empty : v.AsString;

    /// <summary>路径归一化的聚合阶段（$split → $map 折叠 :id → $reduce 拼回 _np），供 insights 报错/慢聚合复用</summary>
    private static BsonDocument[] PathNormalizeStages() => new[]
    {
        new BsonDocument("$set", new BsonDocument("_segs", new BsonDocument("$split", new BsonArray { "$Path", "/" }))),
        new BsonDocument("$set", new BsonDocument("_norm", new BsonDocument("$map", new BsonDocument
        {
            { "input", "$_segs" },
            { "as", "s" },
            { "in", new BsonDocument("$cond", new BsonArray
                {
                    new BsonDocument("$or", new BsonArray
                    {
                        new BsonDocument("$regexMatch", new BsonDocument { { "input", "$$s" }, { "regex", "^[0-9]+$" } }),
                        new BsonDocument("$regexMatch", new BsonDocument { { "input", "$$s" }, { "regex", "^[0-9a-fA-F-]{16,}$" } }),
                    }),
                    ":id",
                    "$$s",
                }) },
        }))),
        new BsonDocument("$set", new BsonDocument("_np", new BsonDocument("$reduce", new BsonDocument
        {
            { "input", "$_norm" },
            { "initialValue", "" },
            { "in", new BsonDocument("$cond", new BsonArray
                {
                    new BsonDocument("$eq", new BsonArray { "$$this", "" }),
                    "$$value",
                    new BsonDocument("$concat", new BsonArray { "$$value", "/", "$$this" }),
                }) },
        }))),
    };

    private async Task<List<Insight>> ErrorInsightsAsync(DateTime fromUtc, DateTime endUtc)
    {
        try { return await ErrorInsightsAggregateAsync(fromUtc, endUtc); }
        catch { return await ErrorInsightsLegacyAsync(fromUtc, endUtc); }
    }

    /// <summary>报错热点聚合（服务端归一化 + $facet：ep 算分组与去重人数、codes 算错误码计数）</summary>
    private async Task<List<Insight>> ErrorInsightsAggregateAsync(DateTime fromUtc, DateTime endUtc)
    {
        var pipeline = new List<BsonDocument>
        {
            new BsonDocument("$match", new BsonDocument
            {
                { "StartedAt", new BsonDocument { { "$gte", new BsonDateTime(fromUtc) }, { "$lte", new BsonDateTime(endUtc) } } },
                { "Direction", new BsonDocument("$ne", "outbound") },
                { "StatusCode", new BsonDocument { { "$gte", 400 }, { "$ne", 401 } } },
                { "Path", new BsonDocument("$regex", "^/api") },
            }),
        };
        pipeline.AddRange(PathNormalizeStages());
        pipeline.Add(new BsonDocument("$facet", new BsonDocument
        {
            { "ep", new BsonArray
                {
                    new BsonDocument("$group", new BsonDocument
                    {
                        { "_id", new BsonDocument { { "p", "$_np" }, { "m", "$Method" }, { "s", "$StatusCode" } } },
                        { "count", new BsonDocument("$sum", 1) },
                        { "users", new BsonDocument("$addToSet", "$UserId") },
                    }),
                    new BsonDocument("$match", new BsonDocument("count", new BsonDocument("$gte", 5))),
                    new BsonDocument("$set", new BsonDocument("userCount", new BsonDocument("$size", "$users"))),
                    new BsonDocument("$project", new BsonDocument("users", 0)),
                    new BsonDocument("$sort", new BsonDocument("count", -1)),
                    new BsonDocument("$limit", 1000),
                } },
            { "codes", new BsonArray
                {
                    new BsonDocument("$group", new BsonDocument
                    {
                        { "_id", new BsonDocument { { "p", "$_np" }, { "m", "$Method" }, { "s", "$StatusCode" }, { "ec", "$ErrorCode" } } },
                        { "n", new BsonDocument("$sum", 1) },
                    }),
                } },
        }));

        var cursor = await _db.ApiRequestLogs.AggregateAsync<BsonDocument>(pipeline.ToArray(), new AggregateOptions { AllowDiskUse = true });
        var docs = await cursor.ToListAsync();
        var result = new List<Insight>();
        if (docs.Count == 0) return result;
        var root = docs[0];

        // 各 (path,method,status) 的最常见错误码
        var topCode = new Dictionary<string, (string Code, int N)>();
        foreach (var cv in root["codes"].AsBsonArray)
        {
            var c = cv.AsBsonDocument;
            var cid = c["_id"].AsBsonDocument;
            var ec = cid.Contains("ec") && !cid["ec"].IsBsonNull ? cid["ec"].AsString : string.Empty;
            if (string.IsNullOrEmpty(ec)) continue;
            var key = $"{cid.GetValue("p", "").AsString}|{BsonToStr(cid.GetValue("m", ""))}|{cid.GetValue("s", 0).ToInt32()}";
            var n = c.GetValue("n", 0).ToInt32();
            if (!topCode.TryGetValue(key, out var cur) || n > cur.N) topCode[key] = (ec, n);
        }

        foreach (var ev in root["ep"].AsBsonArray)
        {
            var e = ev.AsBsonDocument;
            var eid = e["_id"].AsBsonDocument;
            var p = eid.GetValue("p", "").AsString;
            if (p.StartsWith("/api/behavior")) continue; // 排除行为采集端点（与旧逻辑一致）
            var m = BsonToStr(eid.GetValue("m", ""));
            var s = eid.GetValue("s", 0).ToInt32();
            var count = e.GetValue("count", 0).ToInt32();
            var users = e.GetValue("userCount", 0).ToInt32();
            topCode.TryGetValue($"{p}|{m}|{s}", out var top);
            result.Add(new Insight(
                Kind: "api-error",
                KindLabel: "频繁报错",
                Target: $"{m} {p}",
                UserCount: users,
                EventCount: count,
                Metric: $"HTTP {s} × {count}",
                Suggestion: s >= 500
                    ? "服务端错误高频出现，优先修复；用户遇到 5xx 通常会直接放弃当前操作"
                    : "该接口在真实使用中高频失败，排查最常见错误码的触发条件；若属参数/状态校验，应把校验前移到前端并给出可行动的提示文案",
                Evidence: new List<string>
                {
                    $"{count} 次失败，{users} 人遇到",
                    top.Code != null ? $"最常见错误码 {top.Code}（{top.N} 次）" : "无业务错误码（多为框架层拒绝）",
                },
                Severity: count * (s >= 500 ? 3 : 1) + users * 2));
        }
        return result;
    }

    /// <summary>报错热点兜底：拉取 + C# 分组（聚合不可用时使用，逻辑与原实现一致）</summary>
    private async Task<List<Insight>> ErrorInsightsLegacyAsync(DateTime fromUtc, DateTime endUtc)
    {
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

        var result = new List<Insight>();
        foreach (var g in errLogs
                     .Where(x => x.Path != null && x.Path.StartsWith("/api") && !x.Path.StartsWith("/api/behavior"))
                     .GroupBy(x => (Path: NormalizePath(x.Path!), x.Method, x.StatusCode))
                     .Where(g => g.Count() >= 5))
        {
            var count = g.Count();
            var users = g.Select(x => x.UserId).Distinct().Count();
            var top = g.Where(x => !string.IsNullOrEmpty(x.ErrorCode))
                .GroupBy(x => x.ErrorCode!).OrderByDescending(c => c.Count()).FirstOrDefault();
            result.Add(new Insight(
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
                    top != null ? $"最常见错误码 {top.Key}（{top.Count()} 次）" : "无业务错误码（多为框架层拒绝）",
                },
                Severity: count * (g.Key.StatusCode >= 500 ? 3 : 1) + users * 2));
        }
        return result;
    }

    private async Task<List<Insight>> SlowInsightsAsync(DateTime fromUtc, DateTime endUtc)
    {
        try { return await SlowInsightsAggregateAsync(fromUtc, endUtc); }
        catch { return await SlowInsightsLegacyAsync(fromUtc, endUtc); }
    }

    /// <summary>等待过久聚合（服务端归一化 + 按 path,method 分组，userCount/durSum 服务端算好只回传小桶）</summary>
    private async Task<List<Insight>> SlowInsightsAggregateAsync(DateTime fromUtc, DateTime endUtc)
    {
        var pipeline = new List<BsonDocument>
        {
            new BsonDocument("$match", new BsonDocument
            {
                { "StartedAt", new BsonDocument { { "$gte", new BsonDateTime(fromUtc) }, { "$lte", new BsonDateTime(endUtc) } } },
                { "Direction", new BsonDocument("$ne", "outbound") },
                { "IsEventStream", false },
                { "DurationMs", new BsonDocument("$gte", 3000) },
                { "Path", new BsonDocument("$regex", "^/api") },
            }),
        };
        pipeline.AddRange(PathNormalizeStages());
        pipeline.Add(new BsonDocument("$group", new BsonDocument
        {
            { "_id", new BsonDocument { { "p", "$_np" }, { "m", "$Method" } } },
            { "count", new BsonDocument("$sum", 1) },
            { "users", new BsonDocument("$addToSet", "$UserId") },
            { "durSum", new BsonDocument("$sum", "$DurationMs") },
        }));
        pipeline.Add(new BsonDocument("$match", new BsonDocument("count", new BsonDocument("$gte", 5))));
        pipeline.Add(new BsonDocument("$set", new BsonDocument("userCount", new BsonDocument("$size", "$users"))));
        pipeline.Add(new BsonDocument("$project", new BsonDocument("users", 0)));
        pipeline.Add(new BsonDocument("$sort", new BsonDocument("count", -1)));
        pipeline.Add(new BsonDocument("$limit", 1000));

        var cursor = await _db.ApiRequestLogs.AggregateAsync<BsonDocument>(pipeline.ToArray(), new AggregateOptions { AllowDiskUse = true });
        var docs = await cursor.ToListAsync();
        var result = new List<Insight>();
        foreach (var b in docs)
        {
            var id = b["_id"].AsBsonDocument;
            var p = id.GetValue("p", "").AsString;
            var m = BsonToStr(id.GetValue("m", ""));
            var count = b.GetValue("count", 0).ToInt32();
            var users = b.GetValue("userCount", 0).ToInt32();
            var durSum = b.GetValue("durSum", 0).ToDouble();
            var avgSec = count > 0 ? durSum / count / 1000.0 : 0;
            result.Add(new Insight(
                Kind: "slow-endpoint",
                KindLabel: "等待过久",
                Target: $"{m} {p}",
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
        return result;
    }

    /// <summary>等待过久兜底：拉取 + C# 分组（聚合不可用时使用，逻辑与原实现一致）</summary>
    private async Task<List<Insight>> SlowInsightsLegacyAsync(DateTime fromUtc, DateTime endUtc)
    {
        var rb = Builders<ApiRequestLog>.Filter;
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

        var result = new List<Insight>();
        foreach (var g in slowLogs
                     .Where(x => x.Path != null && x.Path.StartsWith("/api"))
                     .GroupBy(x => (Path: NormalizePath(x.Path!), x.Method))
                     .Where(g => g.Count() >= 5))
        {
            var count = g.Count();
            var users = g.Select(x => x.UserId).Distinct().Count();
            var avgSec = g.Average(x => (double)(x.DurationMs ?? 0)) / 1000.0;
            result.Add(new Insight(
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
        return result;
    }

    /// <summary>规则式信号聚类（供 insights 查询与 AI 简报共用）</summary>
    private async Task<(List<Insight> Insights, int BehaviorEventCount)> ComputeInsightsAsync(DateTime fromUtc, DateTime endUtc)
    {
        var insights = new List<Insight>();

        // ── 信号 A/B：报错热点 + 等待过久（apirequestlogs）。分组下推到 MongoDB 聚合，失败回退 C# 扫描 ──
        insights.AddRange(await ErrorInsightsAsync(fromUtc, endUtc));
        insights.AddRange(await SlowInsightsAsync(fromUtc, endUtc));

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
                // 复测回落：仅对「报错/慢请求」类（EventCount 即坏请求数）且已记录 resolved 基线时计算。
                // reboundPct = (当前坏请求 - 基线) / 基线 × 100；负数=回落（好），正数=复发（坏）。
                int? resolvedBadCount = null;
                int? reboundPct = null;
                if (st?.Status == "resolved"
                    && st.ResolvedBadCount is int baseBad and > 0
                    && (i.Kind == "api-error" || i.Kind == "slow-endpoint"))
                {
                    resolvedBadCount = baseBad;
                    var cur = (int)i.EventCount;
                    reboundPct = (int)Math.Round((cur - baseBad) / (double)baseBad * 100.0);
                }
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
                    requirementId = st?.RequirementId,
                    requirementNo = st?.RequirementNo,
                    resolvedBadCount,
                    reboundPct,
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
        // 尊重洞察生命周期：被管理者忽略的洞察不进简报（与 insights 查询口径一致）
        var allFingerprints = insights.Select(i => $"{i.Kind}|{i.Target}").ToList();
        var ignored = (await _db.BehaviorInsightStates
                .Find(Builders<BehaviorInsightState>.Filter.In(x => x.Fingerprint, allFingerprints))
                .ToListAsync())
            .Where(x => x.Status == "ignored")
            .Select(x => x.Fingerprint)
            .ToHashSet();
        var top = insights
            .Where(i => !ignored.Contains($"{i.Kind}|{i.Target}"))
            .OrderByDescending(i => i.Severity)
            .Take(15)
            .ToList();
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

    // ────────────────────────── 端点下钻 + AI 根因诊断 ──────────────────────────

    /// <summary>把 target（"METHOD 归一化路径"）拆成 method + 归一化路径；空格分隔，路径里不含空格</summary>
    private static (string Method, string NormPath) ParseTarget(string target)
    {
        var idx = (target ?? string.Empty).IndexOf(' ');
        if (idx <= 0) return (string.Empty, target ?? string.Empty);
        return (target!.Substring(0, idx).Trim(), target.Substring(idx + 1).Trim());
    }

    /// <summary>归一化路径里 :id 之前的静态前缀（用于 MongoDB StartsWith 预过滤，缩小内存精确匹配的扫描量）</summary>
    private static string StaticPrefix(string normPath)
    {
        var idx = normPath.IndexOf("/:id", StringComparison.Ordinal);
        return idx > 0 ? normPath.Substring(0, idx) : normPath;
    }

    /// <summary>
    /// 端点下钻明细：取该端点（target = METHOD 归一化路径）在窗口内的真实 apirequestlogs，
    /// 聚合错误码分布、慢/错计数，并取最近的代表性请求样本（curl / 请求体 / 状态码 / 耗时）。
    /// 量不大，走 Find + 内存归一化精确匹配（StartsWith 静态前缀预过滤 + Limit 控量）。
    /// </summary>
    [HttpGet("endpoint-detail")]
    public async Task<IActionResult> EndpointDetail(
        [FromQuery] string target,
        [FromQuery] DateTime? from = null,
        [FromQuery] DateTime? to = null)
    {
        if (string.IsNullOrWhiteSpace(target))
            return Ok(ApiResponse<object>.Fail("INVALID_ARGUMENT", "target 不能为空"));

        var (method, normPath) = ParseTarget(target);
        if (string.IsNullOrWhiteSpace(method) || string.IsNullOrWhiteSpace(normPath))
            return Ok(ApiResponse<object>.Fail("INVALID_ARGUMENT", "target 格式应为「METHOD 路径」"));

        var endUtc = to?.ToUniversalTime() ?? DateTime.UtcNow;
        var fromUtc = from?.ToUniversalTime() ?? endUtc.AddDays(-30);
        var prefix = StaticPrefix(normPath);

        var rb = Builders<ApiRequestLog>.Filter;
        var filters = new List<FilterDefinition<ApiRequestLog>>
        {
            rb.Gte(x => x.StartedAt, fromUtc),
            rb.Lte(x => x.StartedAt, endUtc),
            rb.Ne(x => x.Direction, "outbound"),
            rb.Eq(x => x.Method, method),
        };
        // 静态前缀预过滤（:id 之前的部分）；前缀为空时退化为只按方法+时间，仍由内存归一化精确匹配
        if (!string.IsNullOrEmpty(prefix))
            filters.Add(rb.Regex(x => x.Path, new BsonRegularExpression("^" + System.Text.RegularExpressions.Regex.Escape(prefix))));

        var logs = await _db.ApiRequestLogs.Find(rb.And(filters))
            .SortByDescending(x => x.StartedAt)
            .Limit(5000)
            .Project(x => new
            {
                x.Path,
                x.Method,
                x.StatusCode,
                x.DurationMs,
                x.IsEventStream,
                x.ErrorCode,
                x.Curl,
                x.RequestBody,
                x.StartedAt,
            })
            .ToListAsync();

        // 内存里归一化路径精确匹配（Path 含真实 id，NormalizePath 后才与 target 同口径）
        var matched = logs
            .Where(l => l.Path != null && NormalizePath(l.Path) == normPath)
            .ToList();

        var count = matched.Count;
        var errorCount = matched.Count(l => l.StatusCode >= 400 && l.StatusCode != 401);
        var slowCount = matched.Count(l => !l.IsEventStream && (l.DurationMs ?? 0) >= 3000);
        var slowMsSum = matched.Where(l => !l.IsEventStream && (l.DurationMs ?? 0) >= 3000).Sum(l => l.DurationMs ?? 0);
        var avgSlowSec = slowCount > 0 ? slowMsSum / (double)slowCount / 1000.0 : 0;

        var codes = matched
            .Where(l => !string.IsNullOrEmpty(l.ErrorCode))
            .GroupBy(l => l.ErrorCode!)
            .Select(g => new { code = g.Key, n = g.Count() })
            .OrderByDescending(c => c.n)
            .Take(8)
            .ToList();

        // 样本：优先报错 / 慢的，其次最近的；最多 5 条，curl 缺失时用 method + path 兜底
        var samples = matched
            .OrderByDescending(l => (l.StatusCode >= 400 && l.StatusCode != 401) || (!l.IsEventStream && (l.DurationMs ?? 0) >= 3000) ? 1 : 0)
            .ThenByDescending(l => l.StartedAt)
            .Take(5)
            .Select(l => new
            {
                statusCode = l.StatusCode,
                durationMs = l.DurationMs,
                curl = string.IsNullOrWhiteSpace(l.Curl) ? $"{l.Method} {l.Path}" : l.Curl,
                requestBody = l.RequestBody,
                occurredAt = l.StartedAt,
            })
            .ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            target,
            method,
            path = normPath,
            label = LeafLabel(method, normPath),
            module = ModuleLabel(normPath.Split('/', StringSplitOptions.RemoveEmptyEntries).Skip(1).FirstOrDefault() ?? string.Empty),
            count,
            errorCount,
            slowCount,
            avgSlowSec = Math.Round(avgSlowSec, 1),
            codes,
            samples,
            windowFrom = fromUtc,
            windowTo = endUtc,
        }));
    }

    // ────────────────────────── 趋势爆点曲线 ──────────────────────────

    // 趋势曲线短 TTL 缓存：与体验全景热力图同源、同档反复切换不重复聚合（key 取整到分钟 + 桶粒度）
    private static readonly ConcurrentDictionary<string, (DateTime At, object Payload)> _trendCache = new();
    private const int TrendCacheSeconds = 30;

    /// <summary>
    /// 趋势爆点曲线：按时间桶聚合 apirequestlogs 的总量/报错/慢请求，回答「什么时候开始变差」。
    /// 桶粒度自适应：窗口 ≤ 约 2 天 → 按小时桶；更长 / 全部 → 按天桶（「全部」与 insights 同口径取近 30 天）。
    /// 走 MongoDB 聚合下推（$dateTrunc 按桶分组），口径与 ExperienceMapAggregateAsync 一致：
    /// Direction != outbound + Path ^/api，排除 /api/behavior 与 /api/team-activity；
    /// err=StatusCode>=400 且 !=401，slow=非流式且 DurationMs>=3000。失败兜底返回空桶数组（不致命）。
    /// </summary>
    [HttpGet("experience-trend")]
    public async Task<IActionResult> ExperienceTrend([FromQuery] DateTime? from = null, [FromQuery] DateTime? to = null)
    {
        var endUtc = to?.ToUniversalTime() ?? DateTime.UtcNow;
        var fromUtc = from?.ToUniversalTime() ?? endUtc.AddDays(-30);
        // 窗口 ≤ 约 2 天用小时桶（看清一天内的波动），更长用天桶（避免桶过多）
        var unit = (endUtc - fromUtc) <= TimeSpan.FromHours(50) ? "hour" : "day";

        var cacheKey = $"{fromUtc:yyyyMMddHHmm}|{endUtc:yyyyMMddHHmm}|{unit}";
        if (_trendCache.TryGetValue(cacheKey, out var hit) && (DateTime.UtcNow - hit.At).TotalSeconds < TrendCacheSeconds)
        {
            return Ok(ApiResponse<object>.Ok(hit.Payload));
        }

        object payload;
        try
        {
            payload = await ExperienceTrendAggregateAsync(fromUtc, endUtc, unit);
        }
        catch
        {
            // 趋势是增强视图，聚合失败时返回空桶（前端走空数据引导态），不影响其他视图
            payload = new { buckets = Array.Empty<object>(), windowFrom = fromUtc, windowTo = endUtc, bucketUnit = unit };
        }

        _trendCache[cacheKey] = (DateTime.UtcNow, payload);
        if (_trendCache.Count > 64)
        {
            foreach (var k in _trendCache
                         .Where(e => (DateTime.UtcNow - e.Value.At).TotalSeconds > TrendCacheSeconds)
                         .Select(e => e.Key).ToList())
            {
                _trendCache.TryRemove(k, out _);
            }
        }
        return Ok(ApiResponse<object>.Ok(payload));
    }

    /// <summary>按时间桶下推聚合（$dateTrunc 按 hour/day 分组），回传按桶起点升序的 total/errors/slow。</summary>
    private async Task<object> ExperienceTrendAggregateAsync(DateTime fromUtc, DateTime endUtc, string unit)
    {
        var slowCond = new BsonDocument("$and", new BsonArray
        {
            new BsonDocument("$eq", new BsonArray { "$IsEventStream", false }),
            new BsonDocument("$gte", new BsonArray { "$DurationMs", 3000 }),
        });
        var pipeline = new[]
        {
            new BsonDocument("$match", new BsonDocument
            {
                { "StartedAt", new BsonDocument { { "$gte", new BsonDateTime(fromUtc) }, { "$lte", new BsonDateTime(endUtc) } } },
                { "Direction", new BsonDocument("$ne", "outbound") },
                { "Path", new BsonDocument("$regex", "^/api") },
                // 排除行为采集与团队动态自身端点（与热力图同口径，避免自我观测污染趋势）
                { "$nor", new BsonArray
                    {
                        new BsonDocument("Path", new BsonDocument("$regex", "^/api/behavior")),
                        new BsonDocument("Path", new BsonDocument("$regex", "^/api/team-activity")),
                    } },
            }),
            new BsonDocument("$set", new BsonDocument("_bucket", new BsonDocument("$dateTrunc", new BsonDocument
            {
                { "date", "$StartedAt" },
                { "unit", unit },
            }))),
            new BsonDocument("$group", new BsonDocument
            {
                { "_id", "$_bucket" },
                { "total", new BsonDocument("$sum", 1) },
                { "errors", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray
                    {
                        new BsonDocument("$and", new BsonArray
                        {
                            new BsonDocument("$gte", new BsonArray { "$StatusCode", 400 }),
                            new BsonDocument("$ne", new BsonArray { "$StatusCode", 401 }),
                        }),
                        1, 0,
                    })) },
                { "slow", new BsonDocument("$sum", new BsonDocument("$cond", new BsonArray { slowCond, 1, 0 })) },
            }),
            new BsonDocument("$sort", new BsonDocument("_id", 1)),
            new BsonDocument("$limit", 1000),
        };

        var cursor = await _db.ApiRequestLogs.AggregateAsync<BsonDocument>(pipeline, new AggregateOptions { AllowDiskUse = true });
        var docs = await cursor.ToListAsync();
        var buckets = new List<object>();
        foreach (var d in docs)
        {
            var idVal = d.GetValue("_id", BsonNull.Value);
            if (idVal.IsBsonNull) continue;
            var bucketStart = idVal.ToUniversalTime();
            buckets.Add(new
            {
                bucketStart,
                total = d.GetValue("total", 0).ToInt32(),
                errors = d.GetValue("errors", 0).ToInt32(),
                slow = d.GetValue("slow", 0).ToInt32(),
            });
        }

        return new { buckets, windowFrom = fromUtc, windowTo = endUtc, bucketUnit = unit };
    }

    /// <summary>
    /// 端点 AI 根因诊断（SSE 流式）：聚合该端点的报错码分布 / 耗时 / 样本 / 按天计数，
    /// 交给 LLM 给出现象判断、聚集线索、疑似根因、建议动作。事件：phase / model / delta / done / error。
    /// 遵循 server-authority：LLM 调用用 CancellationToken.None，客户端断开只停写不停算，10s 心跳。
    /// </summary>
    [HttpGet("diagnose")]
    public async Task EndpointDiagnoseStream(
        [FromQuery] string target,
        [FromQuery] DateTime? from = null,
        [FromQuery] DateTime? to = null)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        var userId = this.GetRequiredUserId();

        if (string.IsNullOrWhiteSpace(target))
        {
            await WriteSseAsync("error", new { message = "target 不能为空" });
            return;
        }
        var (method, normPath) = ParseTarget(target);
        if (string.IsNullOrWhiteSpace(method) || string.IsNullOrWhiteSpace(normPath))
        {
            await WriteSseAsync("error", new { message = "target 格式应为「METHOD 路径」" });
            return;
        }

        var endUtc = to?.ToUniversalTime() ?? DateTime.UtcNow;
        var fromUtc = from?.ToUniversalTime() ?? endUtc.AddDays(-30);
        var prefix = StaticPrefix(normPath);

        await WriteSseAsync("phase", new { message = "正在拉取该端点的真实请求样本…" });

        var rb = Builders<ApiRequestLog>.Filter;
        var filters = new List<FilterDefinition<ApiRequestLog>>
        {
            rb.Gte(x => x.StartedAt, fromUtc),
            rb.Lte(x => x.StartedAt, endUtc),
            rb.Ne(x => x.Direction, "outbound"),
            rb.Eq(x => x.Method, method),
        };
        if (!string.IsNullOrEmpty(prefix))
            filters.Add(rb.Regex(x => x.Path, new BsonRegularExpression("^" + System.Text.RegularExpressions.Regex.Escape(prefix))));

        var logs = await _db.ApiRequestLogs.Find(rb.And(filters))
            .SortByDescending(x => x.StartedAt)
            .Limit(5000)
            .Project(x => new
            {
                x.Path,
                x.StatusCode,
                x.DurationMs,
                x.IsEventStream,
                x.ErrorCode,
                x.RequestBody,
                x.StartedAt,
            })
            .ToListAsync();

        var matched = logs.Where(l => l.Path != null && NormalizePath(l.Path) == normPath).ToList();
        if (matched.Count == 0)
        {
            await WriteSseAsync("error", new { message = "该端点在当前窗口没有可分析的请求记录" });
            return;
        }

        var count = matched.Count;
        var errorCount = matched.Count(l => l.StatusCode >= 400 && l.StatusCode != 401);
        var slowCount = matched.Count(l => !l.IsEventStream && (l.DurationMs ?? 0) >= 3000);
        var slowMsSum = matched.Where(l => !l.IsEventStream && (l.DurationMs ?? 0) >= 3000).Sum(l => l.DurationMs ?? 0);
        var avgSlowSec = slowCount > 0 ? slowMsSum / (double)slowCount / 1000.0 : 0;
        var avgAllSec = matched.Where(l => !l.IsEventStream).Select(l => (double)(l.DurationMs ?? 0)).DefaultIfEmpty(0).Average() / 1000.0;

        var topCodes = matched
            .Where(l => !string.IsNullOrEmpty(l.ErrorCode))
            .GroupBy(l => l.ErrorCode!)
            .Select(g => new { Code = g.Key, N = g.Count() })
            .OrderByDescending(c => c.N)
            .Take(6)
            .ToList();

        var byDay = matched
            .GroupBy(l => l.StartedAt.ToUniversalTime().Date)
            .OrderBy(g => g.Key)
            .Select(g => $"{g.Key:MM-dd} 共 {g.Count()} 次、报错 {g.Count(x => x.StatusCode >= 400 && x.StatusCode != 401)} 次")
            .TakeLast(10)
            .ToList();

        var sampleSummaries = matched
            .OrderByDescending(l => (l.StatusCode >= 400 && l.StatusCode != 401) || (!l.IsEventStream && (l.DurationMs ?? 0) >= 3000) ? 1 : 0)
            .ThenByDescending(l => l.StartedAt)
            .Take(5)
            .Select(l =>
            {
                var body = l.RequestBody;
                if (!string.IsNullOrEmpty(body) && body!.Length > 240) body = body.Substring(0, 240) + "…";
                return $"HTTP {l.StatusCode} · {(l.DurationMs ?? 0)}ms · 错误码 {(string.IsNullOrEmpty(l.ErrorCode) ? "无" : l.ErrorCode)} · 请求体 {(string.IsNullOrEmpty(body) ? "（无）" : body)}";
            })
            .ToList();

        var facts = new StringBuilder();
        facts.AppendLine($"端点：{method} {normPath}（{LeafLabel(method, normPath)}）");
        facts.AppendLine($"分析窗口：{fromUtc:yyyy-MM-dd} ~ {endUtc:yyyy-MM-dd}");
        facts.AppendLine($"总调用 {count} 次，报错 {errorCount} 次（报错率 {(count > 0 ? errorCount * 100.0 / count : 0):F0}%），慢请求(≥3s) {slowCount} 次，慢请求均值 {avgSlowSec:F1}s，整体均值 {avgAllSec:F1}s。");
        facts.AppendLine("错误码分布：" + (topCodes.Count > 0 ? string.Join("；", topCodes.Select(c => $"{c.Code}×{c.N}")) : "无业务错误码（多为框架层拒绝或无报错）"));
        facts.AppendLine("按天计数：" + (byDay.Count > 0 ? string.Join("；", byDay) : "无"));
        facts.AppendLine("代表性请求样本：");
        foreach (var s in sampleSummaries) facts.AppendLine($"- {s}");

        var systemPrompt =
            "你是接口体验诊断分析师。下面是某个 API 端点在真实使用中的报错码分布、耗时、按天计数与请求样本。" +
            "请用中文输出一份根因诊断（Markdown，禁止使用 emoji，不要臆造数据，证据不足时明确说明）：" +
            "① 一句话判断这个端点当前最主要的问题；" +
            "② 时间聚集 / 错误聚类 / 参数线索（从错误码分布、按天计数、样本请求体里能看出什么规律，看不出就说看不出）；" +
            "③ 疑似根因（可多因叠加，逐条给出，并标注依据的是哪条证据）；" +
            "④ 建议动作（具体可执行，如校验前移到前端、长任务改 SSE 流式、放宽过严的权限校验、修复模型池健康/降级链等）。";

        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: facts.Length,
            DocumentHash: null,
            SystemPromptRedacted: "[TeamActivity-EndpointDiagnose]",
            RequestType: "chat",
            AppCallerCode: AppCallerRegistry.Admin.TeamActivity.EndpointDiagnose));

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.Admin.TeamActivity.EndpointDiagnose,
            ModelType = ModelTypes.Chat,
            Stream = true,
            TimeoutSeconds = 300,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = facts.ToString() },
                },
                ["temperature"] = 0.4,
                ["max_tokens"] = 8192,
            },
        };

        var clientGone = false;
        var sentModel = false;
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
            if (!clientGone) { try { await SendAsync("phase", new { message = "正在诊断根因…" }); } catch (ObjectDisposedException) { clientGone = true; } }
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

    public record SetInsightStateRequest(string Kind, string Target, string Status, string? DefectId, string? DefectTitle, int? BadCount = null);

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
        // 复测回落基线：标记 resolved 时快照当时的坏请求数（前端传当前 err+slow），改回非 resolved 时清空。
        if (request.Status == "resolved")
        {
            update = update
                .Set(x => x.ResolvedAt, DateTime.UtcNow)
                .Set(x => x.ResolvedBadCount, request.BadCount);
        }
        else
        {
            update = update
                .Set(x => x.ResolvedAt, (DateTime?)null)
                .Set(x => x.ResolvedBadCount, (int?)null);
        }
        await _db.BehaviorInsightStates.UpdateOneAsync(
            x => x.Fingerprint == fingerprint,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new { fingerprint, status = request.Status }));
    }

    public record ToRequirementRequest(string Kind, string Target, string? Title, string? Description, string? ProductId);

    /// <summary>
    /// 痛点洞察流转产品需求池（VOC 闭环收口）：把一个体验痛点一键转成产品管理智能体的需求记录（Requirement），
    /// 落入指定产品的需求池，并把 RequirementId/RequirementNo 回写到 BehaviorInsightState、status 置 confirmed。
    /// 幂等：同一指纹已转过需求（state.RequirementId 非空且需求仍存在）则直接返回已存在的，不重复创建。
    /// 需求创建逻辑对照 ProductAgentController.ConvertDefectToRequirementInternalAsync（编号 + 流程默认 + 初始状态）。
    /// </summary>
    [HttpPost("insights/to-requirement")]
    public async Task<IActionResult> ToRequirement([FromBody] ToRequirementRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Kind) || string.IsNullOrWhiteSpace(request.Target))
            return Ok(ApiResponse<object>.Fail("INVALID_ARGUMENT", "kind/target 不合法"));
        if (string.IsNullOrWhiteSpace(request.ProductId))
            return Ok(ApiResponse<object>.Fail("INVALID_ARGUMENT", "请先选择落入哪个产品的需求池"));

        var productId = request.ProductId!.Trim();
        var product = await _db.Products.Find(p => p.Id == productId && !p.IsDeleted).FirstOrDefaultAsync();
        if (product == null)
            return Ok(ApiResponse<object>.Fail("INVALID_ARGUMENT", "目标产品不存在或已删除，请重新选择"));

        var userId = this.GetRequiredUserId();
        var fingerprint = $"{request.Kind}|{request.Target}";

        // 幂等：该指纹已转过需求且需求仍存在 → 返回已存在的，不重复创建
        var existingState = await _db.BehaviorInsightStates
            .Find(x => x.Fingerprint == fingerprint)
            .SortByDescending(x => x.UpdatedAt)
            .FirstOrDefaultAsync();
        if (existingState != null && !string.IsNullOrWhiteSpace(existingState.RequirementId))
        {
            var already = await _db.Requirements
                .Find(r => r.Id == existingState.RequirementId && !r.IsDeleted)
                .FirstOrDefaultAsync();
            if (already != null)
            {
                return Ok(ApiResponse<object>.Ok(new
                {
                    fingerprint,
                    requirementId = already.Id,
                    requirementNo = already.RequirementNo,
                    productId = already.ProductId,
                    alreadyExists = true,
                }));
            }
        }

        // 解析需求默认流程定义 + 初始状态（默认模板优先匹配本产品，回退全局默认）
        var workflowDefId = await ResolveRequirementWorkflowDefIdAsync(productId);
        var initialState = await ResolveRequirementInitialStateAsync(workflowDefId);

        var title = string.IsNullOrWhiteSpace(request.Title)
            ? $"[用户体验之声] {request.Kind}：{request.Target}"
            : request.Title!.Trim();

        var requirement = new Requirement
        {
            ProductId = productId,
            RequirementNo = await GenerateNextRequirementNoAsync(),
            Title = title,
            Description = request.Description,
            Grade = ProductItemGrade.P2,
            WorkflowDefId = workflowDefId,
            CurrentState = initialState,
            OwnerId = userId,
            SourceSystem = "voc-insight",
            SourceUrl = request.Target,
        };
        await _db.Requirements.InsertOneAsync(requirement);

        // 回写关联到洞察状态：RequirementId/RequirementNo + status=confirmed（确认待改）
        var update = Builders<BehaviorInsightState>.Update
            .Set(x => x.Kind, request.Kind)
            .Set(x => x.Target, request.Target)
            .Set(x => x.RequirementId, requirement.Id)
            .Set(x => x.RequirementNo, requirement.RequirementNo)
            .Set(x => x.UpdatedBy, userId)
            .Set(x => x.UpdatedAt, DateTime.UtcNow)
            .SetOnInsert(x => x.Id, Guid.NewGuid().ToString("N"))
            .SetOnInsert(x => x.CreatedAt, DateTime.UtcNow);
        // 尚未有状态（或处于待处理）时置 confirmed；不覆盖已 resolved/ignored 的人工决策
        if (existingState == null || string.IsNullOrWhiteSpace(existingState.Status) || existingState.Status == "confirmed")
        {
            update = update.Set(x => x.Status, "confirmed");
        }
        await _db.BehaviorInsightStates.UpdateOneAsync(
            x => x.Fingerprint == fingerprint,
            update,
            new UpdateOptions { IsUpsert = true });

        return Ok(ApiResponse<object>.Ok(new
        {
            fingerprint,
            requirementId = requirement.Id,
            requirementNo = requirement.RequirementNo,
            productId,
            alreadyExists = false,
        }));
    }

    /// <summary>下一需求编号：全库 Requirements 单表 TAPD 纯数字全局递增（对照 ProductAgentController.GenerateNextTapdStyleRequirementIdAsync）。</summary>
    private async Task<string> GenerateNextRequirementNoAsync()
    {
        var items = await _db.Requirements
            .Find(r => !r.IsDeleted)
            .Project(r => new { r.RequirementNo, r.ExternalId })
            .ToListAsync();
        return PrdAgent.Core.Helpers.ProductEntityNumbering.NextTapdNumericId(
            items.SelectMany(i => new[] { i.RequirementNo, i.ExternalId }));
    }

    /// <summary>解析需求的默认流程定义 Id（默认匹配本产品，回退全局默认；都缺失时用内置默认流程 Id）。</summary>
    private async Task<string?> ResolveRequirementWorkflowDefIdAsync(string productId)
    {
        var wfFilter = Builders<ProductWorkflowDefinition>.Filter.And(
            Builders<ProductWorkflowDefinition>.Filter.Eq(w => w.EntityType, ProductEntityType.Requirement),
            Builders<ProductWorkflowDefinition>.Filter.Eq(w => w.IsDeleted, false),
            Builders<ProductWorkflowDefinition>.Filter.Eq(w => w.IsDefault, true));
        var workflows = await _db.ProductWorkflowDefinitions.Find(wfFilter).ToListAsync();
        var wf = workflows.FirstOrDefault(w => w.ProductId == productId) ?? workflows.FirstOrDefault(w => w.ProductId == null);
        return wf?.Id;
    }

    /// <summary>解析需求初始状态 Key（流程定义优先，缺失回退内置 New）。</summary>
    private async Task<string> ResolveRequirementInitialStateAsync(string? workflowDefId)
    {
        if (string.IsNullOrWhiteSpace(workflowDefId))
            return RequirementWorkflowCatalog.New;
        var def = await _db.ProductWorkflowDefinitions.Find(w => w.Id == workflowDefId && !w.IsDeleted).FirstOrDefaultAsync();
        var key = def?.GetInitialStateKey();
        return string.IsNullOrWhiteSpace(key) ? RequirementWorkflowCatalog.New : key;
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
