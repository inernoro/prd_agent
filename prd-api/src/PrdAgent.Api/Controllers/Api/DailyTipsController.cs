using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 每日小贴士 / 引导卡片 — 公共读取端点。
/// 任何登录用户均可访问;返回:
///   1) 定向推送给当前用户的 tip(TargetUserId = 当前用户),置顶;
///   2) 全局启用 tip(TargetUserId 为空),按 DisplayOrder 升序 + CreatedAt 降序。
/// 仅返回 IsActive=true 且在 StartAt/EndAt 发布窗口内的数据。
/// 当数据库没有任何可见 tip 时,兜底返回一组内置默认 tip(引导用户探索平台核心能力)。
/// </summary>
[ApiController]
[Route("api/daily-tips")]
[Authorize]
public sealed class DailyTipsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public DailyTipsController(MongoDbContext db)
    {
        _db = db;
    }

    [HttpGet("visible")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Visible(CancellationToken ct = default)
    {
        var userId = this.GetRequiredUserId();
        var now = DateTime.UtcNow;

        // 用户永久「不再提示」的 tip id:从 User.DismissedTipIds 读,包括真实 id 和
        // seed-* id(seed 内置兜底时也按这个过滤,否则永远弹同一组 seed 干扰用户)
        var me = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        var foreverDismissed = me?.DismissedTipIds?.ToHashSet() ?? new HashSet<string>();

        // 用户已学会的 (SourceId, Version) 组合。Version 升级会让旧记录失效。
        var learnedMap = me?.LearnedTips?.ToDictionary(l => l.SourceId, l => l.Version)
                         ?? new Dictionary<string, int>();

        var filter = Builders<DailyTip>.Filter.Eq(x => x.IsActive, true);

        // 发布窗口过滤:StartAt <= now(或为空)且 EndAt > now(或为空)
        filter &= Builders<DailyTip>.Filter.Or(
            Builders<DailyTip>.Filter.Eq(x => x.StartAt, null),
            Builders<DailyTip>.Filter.Lte(x => x.StartAt, now));
        filter &= Builders<DailyTip>.Filter.Or(
            Builders<DailyTip>.Filter.Eq(x => x.EndAt, null),
            Builders<DailyTip>.Filter.Gt(x => x.EndAt, now));

        // 可见性:全局(TargetUserId 为空 且无推送列表) / 定向推送给当前用户(TargetUserId)
        // / 被明确投递给当前用户(Deliveries.UserId = 当前用户)
        filter &= Builders<DailyTip>.Filter.Or(
            Builders<DailyTip>.Filter.Eq(x => x.TargetUserId, null),
            Builders<DailyTip>.Filter.Eq(x => x.TargetUserId, userId),
            Builders<DailyTip>.Filter.ElemMatch(x => x.Deliveries,
                Builders<DailyTipDelivery>.Filter.Eq(d => d.UserId, userId)));

        var items = await _db.DailyTips
            .Find(filter)
            .SortBy(x => x.DisplayOrder)
            .ThenByDescending(x => x.CreatedAt)
            .Limit(50)
            .ToListAsync(ct);

        // Deliveries 非空 = 该 tip 有精确推送列表。
        // 规则:若 Deliveries 里没有当前用户,且该用户不在 TargetUserId,则不展示(走精确推送通道)
        //       若有当前用户但 status=dismissed 或 viewCount>=maxViews(maxViews!=-1),则不展示
        items = items.Where(tip =>
        {
            var ds = tip.Deliveries;
            if (ds == null || ds.Count == 0) return true; // 无推送列表,走原有可见性
            var mine = ds.FirstOrDefault(d => d.UserId == userId);
            if (mine == null)
            {
                // 有推送列表但没我 → 只有 TargetUserId 匹配/全局才能看到
                return tip.TargetUserId == userId || tip.TargetUserId == null;
            }
            if (mine.Status == "dismissed") return false;
            if (mine.MaxViews != -1 && mine.ViewCount >= mine.MaxViews) return false;
            return true;
        }).ToList();

        // 过滤用户永久 dismiss 的(双维度:tip.Id 或 tip.SourceId 命中都算)
        // 管理员「清空并重建」后 tip.Id 会变,但 SourceId 是 seed 标识不变,
        // 这样用户点完过的 seed 重建后也不会再次骚扰
        if (foreverDismissed.Count > 0)
        {
            items = items.Where(t =>
                !foreverDismissed.Contains(t.Id)
                && !(t.SourceId != null && foreverDismissed.Contains(t.SourceId))
            ).ToList();
        }

        // 过滤用户已学会的:仅当 (SourceId, Version) 完全匹配时隐藏。
        // tip.Version 升级后 learnedMap 里的旧 Version 不再匹配,用户会重新看到。
        items = FilterLearned(items, learnedMap);

        // 过滤「已退役 seed」:老环境跑过 /seed 落库的旧短教程(webpages-basics 等)被新版
        // *-page-guide 取代,新旧 SourceId 不冲突 → 不主动滤掉就会新旧并存。这里直接从结果里剔除,
        // 用户无需等管理员重置即不再看到(Codex P2);DB 行的彻底清理在 Admin /seed 时做。
        if (RetiredSeedSourceIds.Length > 0)
        {
            items = items.Where(t => t.SourceId == null || !RetiredSeedSourceIds.Contains(t.SourceId)).ToList();
        }

        // 合并代码内置 seed 集合：即使 DB 已有其他 tip，也要让新加的 BuildDefaultTips seed
        // （如本周发的 feature-release 公告）自动出现，不需要管理员手动跑 /seed。
        // 去重规则：DB 中存在该 SourceId 的记录就跳过 — 包括 IsActive=false 或在发布窗口外的，
        // 否则 admin 显式禁用 / 排期未到 / 已过期的 seed 会被 code seed 重新复活
        // (Codex P2)。直接查 DB 全量 SourceId，不依赖已过滤的 items 列表。
        var allDbSourceIds = await _db.DailyTips
            .Find(Builders<DailyTip>.Filter.Ne<string?>(t => t.SourceId, null))
            .Project(t => t.SourceId)
            .ToListAsync(ct);
        var dbSourceIds = allDbSourceIds
            .Where(s => !string.IsNullOrEmpty(s))
            .Select(s => s!)
            .ToHashSet();
        var seedFillers = BuildDefaultTips(now)
            .Where(seed => seed.SourceId != null && !dbSourceIds.Contains(seed.SourceId))
            .Where(t => (t.StartAt == null || t.StartAt <= now)
                     && (t.EndAt == null || t.EndAt > now))
            .Where(t => !foreverDismissed.Contains(t.Id)
                     && !(t.SourceId != null && foreverDismissed.Contains(t.SourceId)))
            .ToList();
        seedFillers = FilterLearned(seedFillers, learnedMap);
        items.AddRange(seedFillers);

        // Code seed 是 Tier 的权威源（Codex P2）：pre-Tier 环境 DB 行 Tier 字段缺失，
        // 反序列化为默认 "basic"，可能覆盖代码里改成 "advanced" 的真实意图。
        // 这里建一份 SourceId → Tier 映射，下游响应和 MarkLearned 都按此覆盖。
        var codeSeedTier = BuildDefaultTips(now)
            .Where(s => !string.IsNullOrEmpty(s.SourceId))
            .ToDictionary(s => s.SourceId!, s => s.Tier);

        // 注：不再保留「items.Count == 0 时重建 BuildDefaultTips」的旧 fallback。
        // 上方 seedFillers 已经覆盖空 DB 场景（dbSourceIds 为空集，seedFillers = 全套合规 seed），
        // 旧 fallback 会绕过 dbSourceIds 让 admin 禁用 (IsActive=false) 的 seed 复活 (Codex P2)。

        // 定向 tip / 被投递 tip 永远置顶,保证「为你修复」类消息被最先看到
        var ordered = items
            .OrderByDescending(x => x.TargetUserId == userId
                                    || (x.Deliveries != null && x.Deliveries.Any(d => d.UserId == userId)))
            .ThenBy(x => x.DisplayOrder)
            .ThenByDescending(x => x.CreatedAt)
            .Select(x =>
            {
                var mine = x.Deliveries?.FirstOrDefault(d => d.UserId == userId);
                var difficulty = EffectiveDifficulty(x);
                return new
                {
                    x.Id,
                    x.Kind,
                    x.Title,
                    x.Body,
                    x.CoverImageUrl,
                    x.ActionUrl,
                    x.CtaText,
                    x.TargetSelector,
                    x.AutoAction,
                    isTargeted = x.TargetUserId == userId || mine != null,
                    x.SourceType,
                    x.SourceId,
                    x.Version,
                    Tier = (x.SourceId != null && codeSeedTier.TryGetValue(x.SourceId, out var codeTier))
                        ? codeTier
                        : x.Tier,
                    // learned:该 (SourceId, Version) 是否已在用户 LearnedTips 里。*-page-guide 学会后
                    // 仍返回(供重看),前端按此字段停止自动开讲 / 入口脉冲;非 page-guide 学会即被上面过滤掉。
                    learned = IsLearned(x, learnedMap),
                    difficulty,
                    xpReward = XpForDifficulty(difficulty),
                    x.CreatedAt,
                    // 若用户有投递记录,附带 delivery 状态便于前端轻量展示
                    deliveryStatus = mine?.Status,
                    deliveryViewCount = mine?.ViewCount,
                    deliveryMaxViews = mine?.MaxViews,
                };
            })
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { items = ordered }));
    }

    public sealed class TrackRequest
    {
        /// <summary>动作:seen(被看到) / clicked(点击 CTA) / dismissed(用户主动关闭)</summary>
        public string Action { get; set; } = string.Empty;
    }

    /// <summary>
    /// 记录当前用户对某条 tip 的交互动作。仅对有 Delivery 记录的用户有效。
    /// seed-* 之类的内置 tip 没有 db 记录,直接 200 忽略。
    /// </summary>
    [HttpPost("{id}/track")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Track([FromRoute] string id, [FromBody] TrackRequest req, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));
        if (req.Action is not ("seen" or "clicked" or "dismissed"))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "action 必须为 seen / clicked / dismissed"));
        // seed-* 内置 tip 没落库,忽略即可(不报错)
        if (id.StartsWith("seed-"))
            return Ok(ApiResponse<object>.Ok(new { skipped = "builtin-seed" }));

        var userId = this.GetRequiredUserId();
        var now = DateTime.UtcNow;

        var tip = await _db.DailyTips.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (tip == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "tip 不存在"));

        var deliveries = tip.Deliveries ?? new List<DailyTipDelivery>();
        var mine = deliveries.FirstOrDefault(d => d.UserId == userId);
        if (mine == null)
        {
            // 没被精确推送的用户也允许记录,方便缺陷桥接 / 全局 tip 的统计
            mine = new DailyTipDelivery
            {
                UserId = userId,
                Status = "pending",
                ViewCount = 0,
                MaxViews = -1,
                PushedAt = now,
            };
            deliveries.Add(mine);
        }

        switch (req.Action)
        {
            case "seen":
                mine.ViewCount += 1;
                mine.LastSeenAt = now;
                if (mine.Status == "pending") mine.Status = "seen";
                break;
            case "clicked":
                mine.ClickedAt = now;
                mine.Status = "clicked";
                break;
            case "dismissed":
                mine.DismissedAt = now;
                mine.Status = "dismissed";
                break;
        }

        await _db.DailyTips.UpdateOneAsync(
            x => x.Id == id,
            Builders<DailyTip>.Update
                .Set(x => x.Deliveries, deliveries)
                .Set(x => x.UpdatedAt, now),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            status = mine.Status,
            viewCount = mine.ViewCount,
            maxViews = mine.MaxViews,
        }));
    }

    /// <summary>
    /// 用户「永久不再提示」某条 tip:把 tip.Id 和 tip.SourceId(若有)都追加到
    /// User.DismissedTipIds。以后 /visible 端点按双维度过滤(Id 或 SourceId 命中),
    /// 这样管理员「清空并重建」后 tip.Id 变了,SourceId 不变,用户点完过的 seed
    /// 重建后也不会再次骚扰。幂等。
    /// </summary>
    [HttpPost("{id}/dismiss-forever")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> DismissForever([FromRoute] string id, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var userId = this.GetRequiredUserId();

        // 尝试从 DailyTips 找这条 tip 拿到 SourceId;找不到就只存 Id
        var tip = await _db.DailyTips.Find(t => t.Id == id).FirstOrDefaultAsync(ct);
        var keys = new List<string> { id };
        if (tip?.SourceId != null && !keys.Contains(tip.SourceId))
            keys.Add(tip.SourceId);
        // seed-* id 本身就是 "seed-{SourceId}",也同时存进去方便 seed 重建后匹配
        if (id.StartsWith("seed-"))
        {
            var extractedSourceId = id.Substring("seed-".Length);
            if (!keys.Contains(extractedSourceId)) keys.Add(extractedSourceId);
        }

        await _db.Users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.AddToSetEach(u => u.DismissedTipIds, keys),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { dismissedForever = keys }));
    }

    /// <summary>
    /// 用户「我已学会」某条 tip:把 (SourceId, Version) 写入 User.LearnedTips。
    /// 与 dismiss-forever 不同 — 当 tip.Version 升级后用户会再次看到("已更新"提示),
    /// 适合 Tour 走完最后一步 / 用户主动点「✓ 我已学会」按钮的场景。幂等。
    /// </summary>
    [HttpPost("{id}/mark-learned")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> MarkLearned([FromRoute] string id, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(id))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "id 不能为空"));

        var userId = this.GetRequiredUserId();
        var now = DateTime.UtcNow;

        // 找 tip 拿 (SourceId, Version, Tier)。seed-* id 的兜底 tip 数据库里没有,
        // 直接从 BuildDefaultTips 里查;管理员创建的真实 tip 走数据库。
        string sourceId;
        int version;
        string tier;
        var dbTip = await _db.DailyTips.Find(t => t.Id == id).FirstOrDefaultAsync(ct);
        if (dbTip != null)
        {
            sourceId = dbTip.SourceId ?? dbTip.Id;
            version = dbTip.Version;
            // Code seed 是 Tier 的权威源（Codex P2）：pre-Tier 环境跑过 /seed 的 DB 行
            // 没有 Tier 字段会反序列化为默认 "basic"，覆盖代码里改成 "advanced" 的意图。
            // 当 SourceId 在 BuildDefaultTips 里匹配，使用 code seed 的 Tier，否则用 DB 值。
            var codeSeed = !string.IsNullOrEmpty(dbTip.SourceId)
                ? BuildDefaultTips(now).FirstOrDefault(s => s.SourceId == dbTip.SourceId)
                : null;
            tier = codeSeed?.Tier ?? dbTip.Tier;
        }
        else if (id.StartsWith("seed-"))
        {
            var seedId = id.Substring("seed-".Length);
            var seed = BuildDefaultTips(now).FirstOrDefault(s => s.SourceId == seedId);
            if (seed == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "seed tip 不存在"));
            sourceId = seed.SourceId!;
            version = seed.Version;
            tier = seed.Tier;
        }
        else
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "tip 不存在"));
        }

        // 分层逻辑核心（容错：null / 缺字段 / 未来扩展的新 tier 都默认走 basic 路径，
        // 只有显式 "advanced" 才按版本号层叠推进。这样老 DB 记录 Tier 反序列化为 null
        // 不会破坏「basic 永不再弹」的承诺）：
        // - basic / null / 其他: 写入 sentinel Version = int.MaxValue。
        // - advanced: 写入真实 Version，管理员升 Version 后 learnedVer < t.Version → 再次弹出。
        var learnedVersion = tier == "advanced" ? version : int.MaxValue;

        // 幂等写入:先剔除同 SourceId 的旧记录,再 push 新的 (SourceId, Version)。
        // Mongo 的 $pull 和 $push 不能在同一次 update 里作用于同一字段(冲突),
        // 拆两次调用即可,本端点不是热路径。
        await _db.Users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.PullFilter(u => u.LearnedTips!,
                Builders<UserLearnedTip>.Filter.Eq(l => l.SourceId, sourceId)),
            cancellationToken: ct);

        await _db.Users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.Push(u => u.LearnedTips!, new UserLearnedTip
            {
                SourceId = sourceId,
                Version = learnedVersion,
                LearnedAt = now,
            }),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { learned = new { sourceId, version = learnedVersion, tier } }));
    }

    /// <summary>
    /// 学习进度:返回当前用户对全部「官方教程」(code seed 里带多步 Steps 的引导)的完成情况,
    /// 供头像进度环 + 学习中心页消费。onboarding(*-page-guide)计入掌握度分母;
    /// task(其它带步骤的快捷教程)与 update(*-update-*)一并返回但不计入掌握度。
    /// </summary>
    [HttpGet("progress")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> Progress(CancellationToken ct = default)
    {
        var userId = this.GetRequiredUserId();
        var now = DateTime.UtcNow;
        var me = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync(ct);
        var learnedMap = me?.LearnedTips?.ToDictionary(l => l.SourceId, l => l.Version)
                         ?? new Dictionary<string, int>();

        // SSOT:官方教程目录 = BuildDefaultTips 里带多步 Steps 的 seed(单步/纯公告不计)。
        var catalog = BuildDefaultTips(now)
            .Where(s => !string.IsNullOrEmpty(s.SourceId)
                        && s.AutoAction?.Steps is { Count: > 0 })
            .ToList();

        var items = catalog.Select(s =>
        {
            var difficulty = EffectiveDifficulty(s);
            return new
            {
                sourceId = s.SourceId,
                // tipId = visible 端点里这条 seed 的 id(seed-{sourceId});供学习中心直接开讲(markLearned 认 seed- 前缀)。
                tipId = s.Id,
                title = s.Title,
                body = s.Body,
                actionUrl = s.ActionUrl,
                ctaText = s.CtaText,
                targetSelector = s.TargetSelector,
                autoAction = s.AutoAction,
                steps = s.AutoAction!.Steps!.Count,
                category = CategoryOf(s),
                version = s.Version,
                learned = IsLearned(s, learnedMap),
                difficulty,
                xpReward = XpForDifficulty(difficulty),
            };
        }).ToList();

        // 掌握度只看 onboarding(*-page-guide):用户完整走完的本页教程占官方本页教程总数的比例。
        var onboarding = items.Where(i => i.category == "onboarding").ToList();
        // 累计经验:所有已完成教程(不限分类,onboarding/task/update 都算)的 xpReward 之和 —— 完成越多越高。
        var xp = items.Where(i => i.learned).Sum(i => i.xpReward);
        var (level, levelName, levelFloorXp, nextLevelXp) = ComputeLevel(xp);
        return Ok(ApiResponse<object>.Ok(new
        {
            total = onboarding.Count,
            learned = onboarding.Count(i => i.learned),
            xp,
            level,
            levelName,
            levelFloorXp,
            nextLevelXp,
            xpToNext = Math.Max(0, nextLevelXp - xp),
            items,
        }));
    }

    private static bool IsLearned(DailyTip t, Dictionary<string, int> learnedMap)
    {
        var key = t.SourceId ?? t.Id;
        return learnedMap.TryGetValue(key, out var learnedVer) && learnedVer >= t.Version;
    }

    /// <summary>官方教程分类:onboarding(*-page-guide,计入掌握度) / update(*-update-*,本周更新提醒) / task(其它带步骤的快捷教程)。</summary>
    private static string CategoryOf(DailyTip t)
    {
        if (IsPageGuide(t)) return "onboarding";
        if (t.SourceId != null && t.SourceId.Contains("-update-", StringComparison.Ordinal)) return "update";
        return "task";
    }

    /// <summary>是否为「本页完整教程」seed(*-page-guide)。这类教程学会后仍保留(供用户重看),
    /// 仅靠前端 learned 标记抑制自动开讲 / 入口脉冲;其余 tip 学会即隐藏。</summary>
    private static bool IsPageGuide(DailyTip t)
        => t.SourceId != null && t.SourceId.EndsWith("-page-guide", StringComparison.Ordinal);

    /// <summary>教程难度:显式 Difficulty 优先,否则按步数推断(≤4 步=初 / 5-8 步=中 / ≥9 步=高)。</summary>
    private static string EffectiveDifficulty(DailyTip t)
    {
        if (!string.IsNullOrWhiteSpace(t.Difficulty))
        {
            var d = t.Difficulty!.Trim().ToLowerInvariant();
            if (d is "beginner" or "intermediate" or "advanced") return d;
        }
        var steps = t.AutoAction?.Steps?.Count ?? 0;
        if (steps >= 9) return "advanced";
        if (steps >= 5) return "intermediate";
        return "beginner";
    }

    /// <summary>完成对应难度教程获得的经验值:初 10 / 中 20 / 高 40。</summary>
    private static int XpForDifficulty(string difficulty) => difficulty switch
    {
        "advanced" => 40,
        "intermediate" => 20,
        _ => 10,
    };

    /// <summary>等级阈值表(累计经验 Floor → 等级名)。index 0 = 1 级。</summary>
    private static readonly (int Floor, string Name)[] LevelTable =
    {
        (0, "新手"),
        (50, "入门"),
        (120, "进阶"),
        (250, "熟手"),
        (450, "高手"),
        (700, "大师"),
        (1000, "宗师"),
    };

    /// <summary>按累计经验算等级:返回 (等级序号 从1起, 等级名, 当前级经验下限, 下一级经验阈值)。满级时 next=floor。</summary>
    private static (int Level, string Name, int FloorXp, int NextXp) ComputeLevel(int xp)
    {
        var idx = 0;
        for (var i = 0; i < LevelTable.Length; i++)
        {
            if (xp >= LevelTable[i].Floor) idx = i;
            else break;
        }
        var floor = LevelTable[idx].Floor;
        var next = idx + 1 < LevelTable.Length ? LevelTable[idx + 1].Floor : floor;
        return (idx + 1, LevelTable[idx].Name, floor, next);
    }

    private static List<DailyTip> FilterLearned(List<DailyTip> items, Dictionary<string, int> learnedMap)
    {
        if (learnedMap.Count == 0) return items;
        // 单一对比即可覆盖两层语义，不需要在过滤端区分 Tier：
        // - basic: MarkLearned 写入 sentinel int.MaxValue → learnedVer (MaxValue) >= t.Version
        //   永远成立 → 永久隐藏。
        // - advanced: MarkLearned 写入真实 Version → 管理员 bump 后 learnedVer < t.Version → 重弹。
        // - 兼容性：本 PR 之前已学的 tip 仍按 Version 对比，行为完全不变；这些用户在 tip
        //   下次升 Version 时会再看到一次，重新「完成」后按当前 Tier 写入 sentinel 或新 Version。
        // 例外(用户 2026-06-04 要求「学会后按钮保留可重看」):*-page-guide 学会后不隐藏,
        //   仍随响应返回(DTO 带 learned=true),前端据此停止自动开讲 + 脉冲,但保留入口供重看。
        return items.Where(t => !IsLearned(t, learnedMap) || IsPageGuide(t)).ToList();
    }

    /// <summary>
    /// 内置默认 tip 集合(教程 SSOT)。Visible / Progress 端点在 DB 缺失对应 SourceId 时自动并入,
    /// 无需任何手动 seed —— 「小技巧管理」后台已于 2026-06-04 下线,教程统一走代码内置 seed。
    /// 全部为「text / card」类,带 ActionUrl 可跳转。DisplayOrder 预留 10-90。
    /// </summary>
    // 2026-W20/W21 新功能公告的固定下线时间。必须锚定发布日，不能用 now.AddDays(7)——
    // 否则 /visible 兜底路径每次请求重建 BuildDefaultTips(now) 时会刷新 EndAt，导致空环境永不过期
    // （Cursor Bugbot / Codex review）。过此日期后两条公告在全平台（含兜底）消失。
    private static readonly DateTime FeatureTip2026W21ExpireAt =
        new(2026, 6, 2, 0, 0, 0, DateTimeKind.Utc);

    /// <summary>
    /// 已退役的 seed SourceId：被新版各页 *-page-guide 完整教程取代的旧版精简短教程。
    /// 老环境若曾跑过 /seed 把它们落了库，新旧 SourceId 不冲突会导致新旧并存（Codex P2）。
    /// SSOT：Visible() 主动过滤掉这些 DB 行（用户无需等管理员手动重置即不再看到）。
    /// </summary>
    internal static readonly string[] RetiredSeedSourceIds =
    {
        "webpages-basics", "visual-first-image", "library-publish",
        // 网页托管「本周改动」碎片教程已退役:其内容(排序/分组 pill、视图切换、整页提亮)
        // 已并入 webpages-page-guide 的 14 步系统教程,避免一页出现两个割裂教程(用户反馈)。
        "webpages-feature-2026w22-pill-controls",
    };

    internal static List<DailyTip> BuildDefaultTips(DateTime now)
    {
        DailyTip T(
            string id, string kind, string title, string? body,
            string actionUrl, string ctaText,
            string? targetSelector, int order,
            DailyTipAutoAction? autoAction = null,
            DateTime? endAt = null, string sourceType = "seed",
            string tier = "basic")
            => new()
            {
                Id = $"seed-{id}",
                Kind = kind,
                Title = title,
                Body = body,
                ActionUrl = actionUrl,
                CtaText = ctaText,
                TargetSelector = targetSelector,
                AutoAction = autoAction,
                TargetUserId = null,
                SourceType = sourceType,
                SourceId = id,
                DisplayOrder = order,
                IsActive = true,
                EndAt = endAt,
                Tier = tier,
                CreatedBy = "system:seed",
                CreatedAt = now,
                UpdatedAt = now
            };

        // 精简原则:只保留真的有「完整流程」价值的演示,单步 scroll / 单链接
        // 的短 tip 全部删掉;用户说「短短的流程一条流程的给删掉」。
        return new List<DailyTip>
        {
            // ===== 新功能公告（feature-release，7 天后自动过期，避免过时弹窗堆首页）=====
            // 这两条对应 2026-W20/W21 上线的能力，默认推送给所有用户。过期后由 /visible 的
            // EndAt 过滤自动隐藏；下一批新功能上线时替换此处两条即可（属时效内容，定期更新）。
            T("feature-2026w21-report-editor", "card",
                "周报编辑器全新升级",
                "参考 Notion / Linear 重做了编辑器：章节大纲、条目拖动排序、还有「我的周报」时间树视图（年/月/周折叠）。打开看看本周更新。",
                "/report-agent",
                "看看新编辑器",
                null,
                2,
                autoAction: null,
                endAt: FeatureTip2026W21ExpireAt,
                sourceType: "feature-release",
                tier: "advanced"),

            T("feature-2026w21-knowledge-browser", "card",
                "知识库阅读体验升级",
                "文档浏览器新增本页目录导航（TOC）、章节分组、不选中文字也能对整篇文档评论，还能一键替换文件。去知识库翻翻看。",
                "/document-store",
                "去知识库",
                null,
                3,
                autoAction: null,
                endAt: FeatureTip2026W21ExpireAt,
                sourceType: "feature-release",
                tier: "advanced"),

            // ===== 网页托管：本页完整教程（14 步走遍整页）=====
            // 锚点全部为页面常驻元素（含空状态占位卡），新老用户均可跑通。
            // 页面 UI 大改时同步更新此处步骤与 data-tour-id（见 .claude/rules/onboarding-tips.md）。
            T("webpages-page-guide", "card",
                "网页托管：本页 14 步上手教程",
                "从空间模型、上传站点、排序分组到投放面板，一次走遍整页所有功能。",
                "/web-pages",
                "开始本页教程",
                "[data-tour-id=webpages-root]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=webpages-space-bar]", Title = "第 1 步：欢迎来到网页托管", Body = "这里集中托管并分享你的 HTML/ZIP/Markdown/PDF/视频。先认识顶部的空间切换：个人空间放自己的，团队空间与成员共享。下面 14 步走一遍整页。", NavigateTo = "/web-pages" },
                        new() { Selector = "[data-tour-id=webpages-space-bar]", Title = "第 2 步：先认识空间", Body = "一级导航只有两项：「个人空间」放自己的，「团队空间」与成员共享；进入团队空间后，已加入的团队会以标签平铺在第二行，点标签即可切换团队。" },
                        new() { Selector = "[data-tour-id=webpages-space-add]", Title = "第 3 步：新建或加入团队", Body = "虚线「+」可新建团队空间（命名后自动成为管理员，可拉成员进来），或用邀请码加入别人的；团队空间内成员互相可见。" },
                        new() { Selector = "[data-tour-id=webpages-header-actions]", Title = "第 4 步：顶部工具栏", Body = "右上角集中了「分享统计 / 分享管理 / 上传站点」三个入口。" },
                        new() { Selector = "[data-tour-id=webpages-stats-btn]", Title = "第 5 步：分享数据统计", Body = "点图表图标查看每个站点的 PV、独立访客、访问时间线。" },
                        new() { Selector = "[data-tour-id=webpages-share-mgmt-btn]", Title = "第 6 步：分享链接管理", Body = "点链接图标统一管理所有分享链接的密码、有效期和开关。" },
                        new() { Selector = "[data-tour-id=webpages-upload-primary], [data-tour-id=webpages-header-actions]", Title = "第 7 步：上传第一个站点", Body = "有编辑权限时这里会出现「上传站点」按钮，选文件 + 填标题即可发布，整个 ZIP 站点也能直接上传；团队空间的只读成员看不到该按钮。" },
                        new() { Selector = "[data-tour-id=webpages-sort-pills]", Title = "第 8 步：排序", Body = "最新 / 最早 / 标题 / 浏览 / 体积 五种排序平铺成 pill，单击直接切。" },
                        new() { Selector = "[data-tour-id=webpages-group-pills]", Title = "第 9 步：分组", Body = "「日期 / 文件夹」二选一，把站点按时间或自建文件夹归类。" },
                        new() { Selector = "[data-tour-id=webpages-view-toggle]", Title = "第 10 步：网格 / 列表视图", Body = "右侧 ⊞ / ☰ 切换；网格有缩略图，列表更紧凑。" },
                        new() { Selector = "[data-tour-id=webpages-folders]", Title = "第 11 步：文件夹", Body = "用文件夹把同类站点收纳到一起，点文件夹名快速过滤。" },
                        new() { Selector = "[data-tour-id=webpages-card]", Title = "第 12 步：站点卡片", Body = "每个站点一张卡，显示标题、缩略图、访问量和快捷操作。" },
                        new() { Selector = "[data-tour-id=webpages-viewcount]", Title = "第 13 步：访问量", Body = "卡片底部的眼睛图标 + 数字，是该站点累计被打开的次数。" },
                        new() { Selector = "[data-tour-id=share-dock-panel]", Title = "第 14 步：投放面板", Body = "右侧悬浮面板可把文件直接拖进来上传，并提供「公开 / 分享 / 回收」快捷槽位（折叠时先点一下展开）。看完点「完成」就上手啦" },
                    },
                },
                tier: "basic"),

            // 网页托管「本周改动」碎片教程已退役(并入上面的 14 步系统教程,见 RetiredSeedSourceIds)。
            // 一页只保留一个体系化教程,不再让排序/分组/视图等内容在第二个教程里重复出现。

            // 1. 自定义导航顺序 —— 排第一,新用户上手第一件事就是配自己的菜单
            T("nav-order-customize", "card",
                "把常用 Agent 拖到最上面",
                "左侧菜单顺序你说了算 — 拖拽排序、隐藏不用的、收藏喜欢的,从此打开就直奔常用功能。",
                "/settings?tab=nav-order",
                "去自定义",
                "[data-tour-id=nav-order-editor]",
                1,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new()
                        {
                            Selector = "[data-tour-id=nav-order-editor]",
                            Title = "第 1 步:这就是你的菜单",
                            Body = "下面列出所有可见 Agent,顺序就是左侧导航的顺序。",
                            NavigateTo = "/settings?tab=nav-order",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=nav-order-editor]",
                            Title = "第 2 步:鼠标按住一行往上拖",
                            Body = "拖到最顶部 = 默认打开就在第一位;不喜欢的点右侧「隐藏」收起。",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=nav-order-editor]",
                            Title = "第 3 步:回首页看效果",
                            Body = "改完无需保存,刷新左侧菜单就生效。点「✓ 我已学会」收起本提示。",
                        },
                    },
                }),

            // 2. 缺陷管理全链路 —— 4 步真流程
            T("defect-full-flow", "card",
                "发现 bug?跟着做,2 分钟学会提交缺陷",
                "从打开面板到提交,4 步走完完整流程。点「从头开始」即可。",
                "/defect-agent",
                "从头开始",
                "[data-tour-id=defect-create]",
                10,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new()
                        {
                            Selector = "[data-tour-id=defect-create]",
                            Title = "第 1 步:打开提交面板",
                            Body = "点右上角「+ 提交缺陷」展开表单。",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=defect-description]",
                            Title = "第 2 步:第一行写标题 + 下方写描述",
                            Body = "第一行作为标题(一句话);下方可粘贴截图或拖文件。",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=defect-assignee-picker]",
                            Title = "第 3 步:选负责人",
                            Body = "搜用户名或默认负责人,对方会立刻收到通知。",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=defect-submit]",
                            Title = "第 4 步:点「提交」完成",
                            Body = "提交后收到「已创建」通知;开发修好后再收「已修复」。",
                        },
                    },
                }),

            // 只保留多步真流程。单步/零步 tip(如「试试周报」、「看演示」)
            // 违反用户规则「人类不是智障,一步不需要教」,全部删除。
            // 新 seed 必须 steps.Count >= 2,管理员可用 /create-tour-demo 按需扩展。

            // 键盘快捷键(Ctrl+B / Ctrl+K 等)**不适合**用多步 Tour 教学:
            //   - 它们是"任意页面都能用"的全局能力,但 tour 必须指向某个 URL
            //     强制跳到首页演示反而反直觉(用户抱怨"跳到奇怪地方")
            //   - Figma/VSCode 的做法是在 UI 显眼位置挂一个 key hint,让用户
            //     自己按键体验。这类静态提示不属于教程小书
            // 所以 shortcut-cmd-k / shortcut-cmd-b 两条 seed 已删除。

            // 2. 更新中心周报 —— 2 步 Tour
            T("changelog-weekly", "card",
                "看本周平台更新了什么",
                "更新中心按周汇总所有 commit + PR,还能按模块筛选关心的变更。",
                "/changelog",
                "看更新",
                "[data-tour-id=changelog-latest]",
                40,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new()
                        {
                            Selector = "[data-tour-id=changelog-latest]",
                            Title = "第 1 步:最新一版在这",
                            Body = "默认展开;每个 feat/fix 都对应到具体的代码改动。",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=changelog-filter]",
                            Title = "第 2 步:按模块筛选",
                            Body = "只关心 admin?勾上;只看 bug 修复?勾 fix。一键过滤。",
                        },
                    },
                }),

            // 3. 涌现探索器 —— 种下第一颗种子,探索出第一个维度即完成
            T("emergence-first-seed", "card",
                "种下第一颗种子,看 AI 涌现新维度",
                "把任意主题写到种子里 → 点「探索」→ AI 会从你已有的能力中长出新维度。",
                "/emergence",
                "种第一颗种子",
                "[data-tour-id=emergence-seed-input]",
                20,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new()
                        {
                            Selector = "[data-tour-id=emergence-seed-input]",
                            Title = "第 1 步:写下你的种子",
                            Body = "可以是模块名(如「缺陷管理」)、痛点(如「报告太长没人看」),都行。",
                            NavigateTo = "/emergence",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=emergence-explore-btn]",
                            Title = "第 2 步:点节点上的「探索」",
                            Body = "AI 会基于已有能力 + 全局基础设施,长出几条新维度。看到新分支就算完成",
                        },
                    },
                }),

            // 4. 上传第一个技能到海鲜市场
            T("skill-upload-first", "card",
                "把你的技能上传到海鲜市场",
                "市场 → 技能 → 上传 zip,3 步发布,所有人都能 fork 装到自己的 Agent 上。",
                "/marketplace?type=skill",
                "去发布技能",
                "[data-tour-id=marketplace-category-tabs]",
                30,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new()
                        {
                            Selector = "[data-tour-id=marketplace-category-tabs]",
                            Title = "第 1 步:切到「技能」分类",
                            Body = "市场支持配置类型多种,先点「技能」过滤到技能区。",
                            NavigateTo = "/marketplace?type=skill",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=marketplace-upload-skill-btn]",
                            Title = "第 2 步:点右上「+ 上传技能」",
                            Body = "弹窗里上传 zip + 填标题描述 + 选 tag,点发布即可。",
                        },
                    },
                }),

            // 5. 周报管理 —— AI 一键生成
            T("weekly-report-first", "card",
                "用 AI 写第一份周报",
                "选模板 → AI 自动从 commit 和 PR 抽取 → 编辑发布。10 分钟搞定本周总结。",
                "/report-agent",
                "去写周报",
                "[data-tour-id=report-template-picker]",
                60,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new()
                        {
                            Selector = "[data-tour-id=report-template-picker]",
                            Title = "第 1 步:选一份模板",
                            Body = "首次进入会让你选适合的模板(开发周报 / 产品周报 / 自定义)。",
                            NavigateTo = "/report-agent",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=report-template-picker]",
                            Title = "第 2 步:让 AI 自动生成",
                            Body = "选完模板会自动从 git/PR 拉数据,流式生成正文,你只需要审核 + 微调 + 发布。",
                        },
                    },
                }),

            // 6. PR 审查工作台 —— 接入 GitHub 审查第一个 PR
            T("pr-review-first", "card",
                "让 AI 帮你审查第一个 PR",
                "粘贴 GitHub PR 链接 → 一键拉取 diff + 跑 AI 审查,得到打分和具体改进建议。",
                "/pr-review",
                "去审查",
                "[data-tour-id=pr-review-url-input]",
                70,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new()
                        {
                            Selector = "[data-tour-id=pr-review-url-input]",
                            Title = "第 1 步:粘贴 PR 链接",
                            Body = "从 GitHub 复制 PR 完整 URL(形如 .../pull/123)粘到这里。",
                            NavigateTo = "/pr-review",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=pr-review-submit]",
                            Title = "第 2 步:点「添加并同步」",
                            Body = "系统会自动拉取 PR 内容并触发 AI 审查;完成后在列表里查看打分和建议。",
                        },
                    },
                }),

            // 开放接口（OpenAI 兼容对外网关）—— 本页 6 步上手教程（最简生命周期：签发→配置→调用→排障）
            // 锚点均为开放接口面板常驻元素（root/stats/list，含空状态），新老用户均可跑通。
            // 页面 UI 大改时同步更新此处步骤与 data-tour-id（见 .claude/rules/onboarding-tips.md）。
            T("open-api-page-guide", "card",
                "开放接口：本页 6 步上手教程",
                "外部客户用标准 OpenAI 方式调你的模型。一次走遍最简生命周期：签发密钥 → 配模型白名单/限额 → 客户调用 → 看用量/日志排障。",
                "/open-platform",
                "开始本页教程",
                "[data-tour-id=open-api-root]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=open-api-tab]", Title = "第 1 步：什么是开放接口", Body = "这是 OpenAI 兼容的对外网关：外部客户把 SDK 的 base_url 指到 /api/v1、填入你签发的 sk-ak-* 密钥，就能调用本平台模型（chat / 生图）。点「下一步」进入「开放接口」tab，下面 6 步走一遍最简生命周期。", NavigateTo = "/open-platform?tab=open-api" },
                        // 第 2 步带 NavigateTo=?tab=open-api：从第 1 步前进时切到开放接口 tab，挂载 open-api-root/stats/list 锚点
                        // （默认 tab 是「外部授权」）。锚点为 OpenApiPanel 常驻元素（loader 也在 open-api-list 内），切 tab 后立即在 DOM。
                        // 注意：不要给第 2-6 步加 `, [data-tour-id=open-api-tab]` 逗号兜底——querySelector 按文档顺序取第一个匹配，
                        // tab 按钮在内容之前，兜底会让聚光灯一直落在 tab 上而非文案描述的内容区（Bugbot）。NavigateTo 已保证内容锚点挂载。
                        new() { Selector = "[data-tour-id=open-api-stats]", Title = "第 2 步：生命周期总览", Body = "生命周期 = ① 在「接入 AI」弹窗签发带 open-api:call scope 的密钥 → ② 在此为该客户配模型白名单 + 限额 → ③ 客户用密钥调用 → ④ 回这里看用量与日志排障。顶部是全部客户今日请求/Token 汇总。", NavigateTo = "/open-platform?tab=open-api" },
                        new() { Selector = "[data-tour-id=open-api-list]", Title = "第 3 步：客户密钥列表", Body = "每张卡片 = 一个授权了 open-api:call 的客户密钥，显示它的默认模型、白名单数量、今日用量与限速。用上方搜索框可按客户名快速定位。", NavigateTo = "/open-platform?tab=open-api" },
                        new() { Selector = "[data-tour-id=open-api-list]", Title = "第 4 步：配置（点卡片「管理」）", Body = "点任意卡片右下角「管理」→ 右侧抽屉「配置」：配模型白名单（客户只能用白名单内的模型，第一个为默认；留空=走默认池）+ 每分钟/每日请求/每日 Token 限额。这样改总模型池也不会误伤已配置的客户。", NavigateTo = "/open-platform?tab=open-api" },
                        new() { Selector = "[data-tour-id=open-api-list]", Title = "第 5 步：调用日志 / 排障", Body = "同一「管理」抽屉切到「调用日志 / 调试」：按该客户拉最近请求，看请求→解析模型、状态、tokens、耗时、requestId。客户报错时把响应里的 id（chatcmpl-xxx）给你，即可直接定位那条请求。", NavigateTo = "/open-platform?tab=open-api" },
                        new() { Selector = "[data-tour-id=open-api-root]", Title = "第 6 步：去签发一个密钥", Body = "新密钥在右上角「接入 AI」/ AgentApiKey 弹窗创建，记得勾选 open-api:call scope。客户接入细节见 doc/guide.open-api。本页教程结束。", NavigateTo = "/open-platform?tab=open-api" },
                    },
                }),

            // 7. 视觉创作 —— 本页 11 步完整教程
            T("visual-page-guide", "card",
                "视觉创作：本页 11 步上手教程",
                "从写提示词、传参考图、选尺寸场景到开始创作，一次走遍整页。无需配 API key。",
                "/visual-agent",
                "开始本页教程",
                "[data-tour-id=visual-page-title]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=visual-page-title]", Title = "第 1 步：欢迎来到视觉创作", Body = "不用自己配 API key，平台已接好多个生图模型，描述一句话就能出图。", NavigateTo = "/visual-agent" },
                        new() { Selector = "[data-tour-id=visual-subtitle]", Title = "第 2 步：它能做什么", Body = "海报、插画、品牌视觉、参考图改造……用一句话描述需求即可。" },
                        new() { Selector = "[data-tour-id=visual-prompt-input]", Title = "第 3 步：写下你想要的画面", Body = "中英文都行，越具体越好（主体 + 场景 + 风格）。" },
                        new() { Selector = "[data-tour-id=visual-image-btn]", Title = "第 4 步：上传参考图", Body = "有参考图就点「图片」上传，AI 会参考它的构图或风格。" },
                        new() { Selector = "[data-tour-id=visual-size-btn]", Title = "第 5 步：选画布尺寸", Body = "点尺寸按钮选常见规格（方图 / 竖图 / 横图 / 海报等）。" },
                        new() { Selector = "[data-tour-id=visual-scenarios]", Title = "第 6 步：场景快捷标签", Body = "不知道怎么写？点下面的预设场景一键套用提示词。" },
                        new() { Selector = "[data-tour-id=visual-pro]", Title = "第 7 步：Pro 高级能力", Body = "高亮的 Pro 标签提供更强的设计与编排能力，点开了解。" },
                        new() { Selector = "[data-tour-id=visual-defect-btn]", Title = "第 8 步：随手反馈", Body = "遇到问题点 Bug 图标（或 Cmd/Ctrl+B）直接提交缺陷。" },
                        new() { Selector = "[data-tour-id=visual-submit-btn]", Title = "第 9 步：开始创作", Body = "填好后点「开始创作」，AI 流式生成、过程实时可见，出图后还能继续微调或加水印。" },
                        new() { Selector = "[data-tour-id=visual-projects]", Title = "第 10 步：最近项目", Body = "你创建过的项目都收在这里，点开继续编辑。" },
                        new() { Selector = "[data-tour-id=visual-new-project]", Title = "第 11 步：从空白开始", Body = "想直接进编辑器？点「新建项目」创建空白画布。看到新卡片就算上手" },
                    },
                }),

            // 8. 知识库 —— 本页 8 步教程（列表页常驻控件 + 进库后操作用文案指引）
            // 空间详情 URL 带 space id，演示无法直接导航过去；详情页内的上传/发布按钮
            // 用列表页的「新建知识库」锚点承载，靠文案告诉用户进库后会看到它们。
            T("document-store-page-guide", "card",
                "知识库：本页 8 步上手教程",
                "从总览、搜索筛选排序到新建、上传、发布到智识殿堂，一次走遍。",
                "/document-store",
                "开始本页教程",
                "[data-tour-id=library-toolbar], [data-tour-id=library-tabs]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    // 工具栏(stats/search/sort/create)只在「我的空间/团队空间」tab 渲染;若返回用户上次停在
                    // 收藏/点赞 tab,这些锚点不存在。逗号兜底到常驻的 library-tabs(顶部 tab 栏 sticky 容器),
                    // 让教程在任一 tab 都能推进而不卡「目标未找到」(Codex P2)。新用户默认 mine tab,锚点齐全。
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=library-stats], [data-tour-id=library-tabs]", Title = "第 1 步：欢迎来到知识库", Body = "把文档、订阅源整理成知识库，可私藏也可发布到智识殿堂。顶部可切换「我的空间 / 团队空间 / 收藏 / 点赞」。", NavigateTo = "/document-store" },
                        new() { Selector = "[data-tour-id=library-stats], [data-tour-id=library-tabs]", Title = "第 2 步：库房总览", Body = "在「我的空间 / 团队空间」tab 下，这里实时显示你有多少个知识库、多少篇文章。" },
                        new() { Selector = "[data-tour-id=library-search], [data-tour-id=library-tabs]", Title = "第 3 步：搜索", Body = "按名称或标签快速找到目标知识库。" },
                        new() { Selector = "[data-tour-id=library-tag-filter], [data-tour-id=library-tabs]", Title = "第 4 步：标签筛选", Body = "给知识库打标签后，可在这里按标签多选过滤。" },
                        new() { Selector = "[data-tour-id=library-sort], [data-tour-id=library-tabs]", Title = "第 5 步：排序", Body = "按最近更新 / 创建时间 / 名称 / 文章数切换列表顺序。" },
                        new() { Selector = "[data-tour-id=document-store-create], [data-tour-id=library-tabs]", Title = "第 6 步：新建知识库", Body = "点「新建知识库」取个名字，这就是你的第一个库。" },
                        new() { Selector = "[data-tour-id=document-store-create], [data-tour-id=library-tabs]", Title = "第 7 步：进库后上传文档", Body = "点卡片「打开」进入空间，右上角会出现「上传文档」按钮，支持拖入 PDF/Markdown/Word，或粘贴 URL 自动抓取。" },
                        new() { Selector = "[data-tour-id=document-store-create], [data-tour-id=library-tabs]", Title = "第 8 步：发布到智识殿堂", Body = "空间里点「发布」，勾选公开后就能被全平台搜到、收藏、点赞。看完点「完成」" },
                    },
                }),

            // 8.1 同步知识库教程（手动开讲，非 *-page-guide：知识库页已有自动开讲的本页教程，
            //     这条作为「同步」专题让用户从教程抽屉里主动点开，不与本页教程抢自动弹窗）。
            //     步骤靠 SpotlightOverlay「下一步元素不在 DOM 时自动点当前按钮」机制切到同步页签。
            //     页面 UI 改动时同步更新此处步骤与 data-tour-id（见 .claude/rules/onboarding-tips.md）。
            T("document-store-sync-guide", "card",
                "同步知识库：跨环境 / 本地库双向同步教程",
                "学会把一个知识库和另一处的库（不同环境，或本环境另一个库）建立永久配对、单向或双向同步。",
                "/document-store?tab=sync",
                "开始同步教程",
                "[data-tour-id=sync-toolbar]",
                1,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    // 首步用 ?tab=sync 直达同步页签（DocumentStorePage 会据此清空详情视图 + 切到同步 tab），
                    // 这样即使用户当前正在某个知识库详情里开讲，也能落到同步页签而不卡在找不到锚点（Bugbot: detail fallback）。
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=sync-toolbar], [data-tour-id=library-sync-tab]", Title = "第 1 步：进入「跨环境同步」页签", Body = "同步让一个知识库的内容在两处保持一致——可以是测试/正式两个环境，也可以是本环境的两个库。这里就是同步管理中心（单库粒度，只搬这一个库的文档，不碰账号或别的库）。", NavigateTo = "/document-store?tab=sync" },
                        new() { Selector = "[data-tour-id=library-sync-tab], [data-tour-id=sync-toolbar]", Title = "第 2 步：「跨环境同步」页签", Body = "顶部最右的「跨环境同步」页签就是入口，以后从这里进来管理所有同步配对。" },
                        new() { Selector = "[data-tour-id=sync-toolbar]", Title = "第 3 步：同步工具栏", Body = "这里有「启动链接」「生成连接链接」「刷新」，下面列出你所有的同步配对。" },
                        new() { Selector = "[data-tour-id=sync-start-link]", Title = "第 4 步：启动链接（建立配对）", Body = "两种方式二选一：跨环境就粘贴对方给的 skblink 链接；本环境两个库就直接选 A、B。还能选方向：双向 / 只推 / 只拉。" },
                        new() { Selector = "[data-tour-id=sync-generate-link]", Title = "第 5 步：生成连接链接（给对端）", Body = "想让别的环境连过来，就在这里选库生成一条 skblink 永久链接发过去。令牌永久有效、不会过期，不想要了可在库里撤销。" },
                        new() { Selector = "[data-tour-id=sync-list]", Title = "第 6 步：配对列表与立即同步", Body = "每条配对可随时切方向、点「立即同步」、或「撤销」。改动后显示「待同步」，同步完显示绿色「已同步」对勾。" },
                        new() { Selector = "[data-tour-id=sync-list]", Title = "第 7 步：库详情看同步徽章", Body = "进入任何一个同步中的知识库，右上角都会显示同步状态徽章（已同步 / 待同步 / 出错），点它能回到这里管理。看完点「完成」" },
                    },
                }),

            // 9. 文学创作 —— 本页 8 步教程（锚点全为页面常驻元素）
            T("literary-page-guide", "card",
                "文学创作：本页 8 步上手教程",
                "认识视图切换、文件夹、新建文章，从这里开始你的第一篇创作。",
                "/literary-agent",
                "开始本页教程",
                "[data-tour-id=literary-root]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=literary-view-toggle]", Title = "第 1 步：欢迎来到文学创作", Body = "这里管理你的所有文章。右上角可在「按时间 / 按文件夹」之间切换。下面 8 步带你认识页面。", NavigateTo = "/literary-agent" },
                        new() { Selector = "[data-tour-id=literary-view-toggle]", Title = "第 2 步：两种浏览方式", Body = "右上角可在「按时间 / 按文件夹」之间切换。" },
                        new() { Selector = "[data-tour-id=literary-time-view]", Title = "第 3 步：按时间", Body = "按更新时间排列，最近写的排在最前，适合快速回到草稿。" },
                        new() { Selector = "[data-tour-id=literary-folder-view]", Title = "第 4 步：按文件夹", Body = "用文件夹把文章按系列 / 主题归类，结构更清晰。" },
                        new() { Selector = "[data-tour-id=literary-create-folder]", Title = "第 5 步：新建文件夹", Body = "点文件夹图标先建一个分类。" },
                        new() { Selector = "[data-tour-id=literary-create]", Title = "第 6 步：新建文章", Body = "点「新建」开始写第一篇，进入后即可用 AI 辅助创作。" },
                        new() { Selector = "[data-tour-id=literary-content]", Title = "第 7 步：作品区", Body = "你的文章会以卡片排在这里，点卡片进入编辑，右键可快速操作。" },
                        new() { Selector = "[data-tour-id=literary-content]", Title = "第 8 步：右键快捷菜单", Body = "在空白处右键也能快速新建文件夹或文章；还没有文章时这里会给出引导。看完点「完成」" },
                    },
                }),

            // 10. 海鲜市场 —— 本页教程
            T("marketplace-page-guide", "card",
                "海鲜市场：本页 6 步上手教程",
                "搜索、筛选、上传技能，一键 fork 到自己的 Agent。",
                "/marketplace",
                "开始本页教程",
                "[data-tour-id=marketplace-page-title]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=marketplace-page-title]", Title = "第 1 步：欢迎来到海鲜市场", Body = "这里能搜索、下载、上传技能 / 提示词 / 配置，一键 fork 到自己的 Agent。", NavigateTo = "/marketplace" },
                        new() { Selector = "[data-tour-id=marketplace-category-tabs]", Title = "第 2 步：先选类型", Body = "技能 / 提示词 / 配置，点 tab 过滤你想找的那一类。" },
                        new() { Selector = "[data-tour-id=marketplace-search]", Title = "第 3 步：搜索", Body = "按名称快速找到目标配置。" },
                        new() { Selector = "[data-tour-id=marketplace-sort]", Title = "第 4 步：热门 / 最新", Body = "想看大家在用什么点「热门」，想看新货点「最新」。" },
                        new() { Selector = "[data-tour-id=marketplace-list]", Title = "第 5 步：浏览卡片", Body = "每张卡是一个可 fork 的配置，点进去看详情和 fork 数。" },
                        new() { Selector = "[data-tour-id=marketplace-upload-skill-btn]", Title = "第 6 步：上传你的技能", Body = "在「技能」分类下点「上传技能」，传 zip + 填标题描述即可发布；同分类下的「接入 AI」还能一键生成 API Key 让 Claude Code / Cursor 直连市场。看完点「完成」" },
                    },
                }),

            // 11. 智识殿堂 —— 本页教程
            T("library-landing-page-guide", "card",
                "智识殿堂：本页 7 步上手教程",
                "浏览、搜索全平台公开知识库，向各领域专家学习。",
                "/library",
                "开始本页教程",
                "[data-tour-id=library-hero-title]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=library-hero-title]", Title = "第 1 步：欢迎来到智识殿堂", Body = "这里汇聚全平台公开的知识库，可浏览、搜索、点赞、收藏。", NavigateTo = "/library" },
                        new() { Selector = "[data-tour-id=library-hero-desc]", Title = "第 2 步：它是什么", Body = "各领域开发者分享的知识库集合，向专家学习真实世界的经验与洞见。" },
                        new() { Selector = "[data-tour-id=library-explore]", Title = "第 3 步：开始探索", Body = "点「开始探索」滚动到下方的公开知识库列表。" },
                        new() { Selector = "[data-tour-id=library-create]", Title = "第 4 步：发布我的知识", Body = "想分享自己的？点「发布我的知识」去新建知识库（跳到知识库页）。" },
                        new() { Selector = "[data-tour-id=library-catalog-title]", Title = "第 5 步：热门知识库区", Body = "下面是按热度排序的公开知识库，点卡片进入阅读。" },
                        new() { Selector = "[data-tour-id=library-search]", Title = "第 6 步：搜索", Body = "按名称 / 作者 / 标签找你感兴趣的库。" },
                        new() { Selector = "[data-tour-id=library-sort]", Title = "第 7 步：排序", Body = "热门 / 高赞 / 高阅 / 最新 切换不同维度。看完点「完成」" },
                    },
                }),

            // 12. 作品广场 —— 本页教程
            T("showcase-page-guide", "card",
                "作品广场：本页 6 步上手教程",
                "浏览全平台 AI 生成的优秀作品（视觉 + 文学），发现灵感。",
                "/showcase",
                "开始本页教程",
                "[data-tour-id=showcase-hero-title]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=showcase-hero-title]", Title = "第 1 步：欢迎来到作品广场", Body = "这里展示全平台由 AI 生成的优秀作品（视觉创作 + 文学创作），逛一逛找灵感。", NavigateTo = "/showcase" },
                        new() { Selector = "[data-tour-id=showcase-tabs]", Title = "第 2 步：按类型筛选", Body = "全部 / 视觉创作 / 文学创作 三个 tab 切换。" },
                        new() { Selector = "[data-tour-id=showcase-sort]", Title = "第 3 步：排序", Body = "默认按「最受欢迎」展示，热门作品靠前。" },
                        new() { Selector = "[data-tour-id=showcase-search]", Title = "第 4 步：搜索作品", Body = "顶部搜索框按关键词找作品。" },
                        new() { Selector = "[data-tour-id=showcase-gallery]", Title = "第 5 步：浏览作品墙", Body = "瀑布流展示作品，点开看大图和作者主页。" },
                        new() { Selector = "[data-tour-id=showcase-back]", Title = "第 6 步：返回首页", Body = "左上角返回按钮回到首页。看完点「完成」" },
                    },
                }),

            // 13. 视觉创作 编辑器 —— 进入项目后(/visual-agent/:id)自动开讲,贯通到创作流程
            // sourceId 含 "editor" → 前端 TipsDrawer 自动开讲匹配器只在「深层路由」触发它(列表页走 visual-page-guide)。
            T("visual-editor-page-guide", "card",
                "视觉编辑器：进入项目后这样创作",
                "进入项目后,认识画布、输入区、生成流程,真正上手出图。",
                "/visual-agent",
                "看编辑器教程",
                "[data-tour-id=visual-editor-root]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=visual-editor-canvas]", Title = "第 1 步：你已进入视觉编辑器", Body = "中间这块是无限画布——单个项目的创作空间，底部是创作输入区。" },
                        new() { Selector = "[data-tour-id=visual-editor-canvas]", Title = "第 2 步：无限画布", Body = "两指拖动平移、双指捏合或 ⌘/Ctrl+滚轮缩放；把图片直接拖进来即可作为参考或编辑对象。" },
                        new() { Selector = "[data-tour-id=visual-editor-canvas]", Title = "第 3 步：开始创作", Body = "在底部输入框写指令、选模型与尺寸，点生成，结果会出现在画布上；左上角返回退出。看完点「完成」" },
                    },
                }),

            // 14. 文学创作 编辑器 —— 进入文章后(/literary-agent/:id)自动开讲
            T("literary-editor-page-guide", "card",
                "文学编辑器：进入文章后这样配图",
                "进入文章后,认识正文区、配图标记、生成流程。",
                "/literary-agent",
                "看编辑器教程",
                "[data-tour-id=literary-editor-root]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=literary-editor-content]", Title = "第 1 步：你已进入文学编辑器", Body = "左侧这块是文章正文区，右侧是配图标记列表。" },
                        new() { Selector = "[data-tour-id=literary-editor-content]", Title = "第 2 步：正文区", Body = "上传或粘贴文章后在这里预览；把 .md / .txt 文件拖进来也能上传。" },
                        new() { Selector = "[data-tour-id=literary-editor-content]", Title = "第 3 步：生成配图", Body = "AI 会按正文自动标出配图点并逐张生成，右侧可逐个查看或重生成。" },
                        new() { Selector = "[data-tour-id=literary-editor-back]", Title = "第 4 步：返回", Body = "左上角返回按钮回到文章列表。看完点「完成」" },
                    },
                }),

            // 15. 缺陷管理 —— 本页 8 步教程(贯通:浏览 → 打开提交面板 → 填写 → 提交)
            T("defect-page-guide", "card",
                "缺陷管理：本页 8 步上手教程",
                "从切换视图、筛选，到提交一条缺陷的完整流程。",
                "/defect-agent",
                "开始本页教程",
                "[data-tour-id=defect-view-mode-switcher]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=defect-view-mode-switcher]", Title = "第 1 步：欢迎来到缺陷管理", Body = "这里提交、跟踪、协作修复缺陷。右上四个图标切换 列表 / 卡片 / 看板 / 统计 视图。", NavigateTo = "/defect-agent" },
                        new() { Selector = "[data-tour-id=defect-project-filter]", Title = "第 2 步：按项目筛选", Body = "用「全部项目」下拉按项目 / 团队过滤缺陷列表。" },
                        new() { Selector = "[data-tour-id=defect-list-container], [data-tour-id=defect-view-mode-switcher]", Title = "第 3 步：缺陷列表", Body = "这里展示你「收到的」和「我提交的」缺陷（列表 / 卡片视图含标题、状态、严重度、负责人；看板 / 统计视图换种方式呈现同一批数据）。" },
                        new() { Selector = "[data-tour-id=defect-template-btn]", Title = "第 4 步：我的模板", Body = "常用缺陷可存成模板，下次提交更快。" },
                        new() { Selector = "[data-tour-id=defect-create]", Title = "第 5 步：提交缺陷", Body = "点「+ 提交缺陷」展开提交表单。" },
                        new() { Selector = "[data-tour-id=defect-description]", Title = "第 6 步：写标题 + 描述", Body = "第一行作为标题（一句话），下方可粘贴截图、拖文件。" },
                        new() { Selector = "[data-tour-id=defect-assignee-picker]", Title = "第 7 步：选负责人", Body = "搜用户名或选默认负责人，对方会立刻收到通知。" },
                        new() { Selector = "[data-tour-id=defect-submit]", Title = "第 8 步：提交", Body = "提交后收到「已创建」，开发修好后再收「已修复」。看完点「完成」" },
                    },
                }),

            // 16. PR 审查工作台 —— 本页 4 步教程
            T("pr-review-page-guide", "card",
                "PR 审查：本页 4 步上手教程",
                "连接 GitHub，添加 PR，看 AI 审查与对齐度评分。",
                "/pr-review",
                "开始本页教程",
                "[data-tour-id=pr-review-page-title]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=pr-review-page-title]", Title = "第 1 步：欢迎来到 PR 审查工作台", Body = "用你自己的 GitHub 账号，对任意有权限的 PR 跑 AI 审查。", NavigateTo = "/pr-review" },
                        new() { Selector = "[data-tour-id=pr-review-sidebar]", Title = "第 2 步：左侧操作区", Body = "先「连接 GitHub」（Device Flow 授权）；连上后粘贴 PR 链接点「添加并同步」。" },
                        new() { Selector = "[data-tour-id=pr-review-list-container]", Title = "第 3 步：右侧 PR 列表", Body = "添加的 PR 按更新时间排序展示。" },
                        new() { Selector = "[data-tour-id=pr-review-list-container]", Title = "第 4 步：查看 AI 审查", Body = "点开任一 PR 卡片：看一句话总结、与项目目标的对齐度评分、写你的审查笔记。看完点「完成」" },
                    },
                }),

            // 17. 涌现探索器 —— 本页 4 步教程
            T("emergence-page-guide", "card",
                "涌现探索器：本页 4 步上手教程",
                "从一颗种子开始，让 AI 帮你发现下一步做什么。",
                "/emergence",
                "开始本页教程",
                // 锚点用逗号兜底:新用户落在 EmergenceIntroPage(hero-title/steps/seed-input/dimensions),
                // 有树的老用户落在 EmergenceCanvas 树列表(about/create-tree/tree-list)。两套都给,
                // querySelector 取首个命中,任一视图都不会留空步骤卡 10 秒超时(Codex P2)。
                "[data-tour-id=emergence-hero-title], [data-tour-id=emergence-about]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=emergence-hero-title], [data-tour-id=emergence-about]", Title = "第 1 步：欢迎来到涌现探索器", Body = "从一颗种子开始，AI 帮你长出整棵可能性之树、发现下一步做什么。", NavigateTo = "/emergence" },
                        new() { Selector = "[data-tour-id=emergence-steps], [data-tour-id=emergence-tree-list]", Title = "第 2 步：三步玩法", Body = "种下种子 → 探索生长 → 涌现组合，完整流程就这三步。" },
                        new() { Selector = "[data-tour-id=emergence-seed-input], [data-tour-id=emergence-create-tree]", Title = "第 3 步：种下第一颗种子", Body = "点这里上传一段文档 / 方案作为锚点，创建你的第一棵涌现树。" },
                        new() { Selector = "[data-tour-id=emergence-dimensions], [data-tour-id=emergence-tree-list]", Title = "第 4 步：三个维度", Body = "AI 沿「系统内 → 跨系统 → 幻想未来」生长；进入树后点节点「探索」、多节点还能「涌现」交叉组合。看完点「完成」。" },
                    },
                }),

            // 18. 工作流 —— 本页 4 步教程
            T("workflow-page-guide", "card",
                "工作流：本页 4 步上手教程",
                "把多个能力舱编排成自动化流程并执行。",
                "/workflow-agent",
                "开始本页教程",
                "[data-tour-id=workflow-create-btn]",
                0,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new() { Selector = "[data-tour-id=workflow-create-btn]", Title = "第 1 步：欢迎来到工作流", Body = "把多个能力舱编排成自动化流程。点「新建工作流」进入画布。", NavigateTo = "/workflow-agent" },
                        new() { Selector = "[data-tour-id=workflow-from-template-btn]", Title = "第 2 步：从模板创建", Body = "不想从零搭？用预定义模板一键生成工作流。" },
                        new() { Selector = "[data-tour-id=workflow-list]", Title = "第 3 步：工作流列表", Body = "建好的工作流都在这；首次使用有空状态引导教你建第一个。" },
                        new() { Selector = "[data-tour-id=workflow-list]", Title = "第 4 步：卡片操作与执行", Body = "每张卡可「编辑 / 画布 / 执行 / 删除」；进画布后拖舱、连线、点执行即可跑。看完点「完成」" },
                    },
                }),
        };
    }
}
