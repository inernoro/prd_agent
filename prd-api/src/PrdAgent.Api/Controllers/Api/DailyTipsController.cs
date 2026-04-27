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

        // 数据库没有任何 tip 时,兜底返回内置默认集,避免新环境出现空白
        if (items.Count == 0)
        {
            items = BuildDefaultTips(now);
            if (foreverDismissed.Count > 0)
            {
                items = items.Where(t =>
                    !foreverDismissed.Contains(t.Id)
                    && !(t.SourceId != null && foreverDismissed.Contains(t.SourceId))
                ).ToList();
            }
            items = FilterLearned(items, learnedMap);
        }

        // 定向 tip / 被投递 tip 永远置顶,保证「为你修复」类消息被最先看到
        var ordered = items
            .OrderByDescending(x => x.TargetUserId == userId
                                    || (x.Deliveries != null && x.Deliveries.Any(d => d.UserId == userId)))
            .ThenBy(x => x.DisplayOrder)
            .ThenByDescending(x => x.CreatedAt)
            .Select(x =>
            {
                var mine = x.Deliveries?.FirstOrDefault(d => d.UserId == userId);
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

        // 找 tip 拿 (SourceId, Version)。seed-* id 的兜底 tip 数据库里没有,
        // 直接从 BuildDefaultTips 里查;管理员创建的真实 tip 走数据库。
        string sourceId;
        int version;
        var dbTip = await _db.DailyTips.Find(t => t.Id == id).FirstOrDefaultAsync(ct);
        if (dbTip != null)
        {
            sourceId = dbTip.SourceId ?? dbTip.Id;
            version = dbTip.Version;
        }
        else if (id.StartsWith("seed-"))
        {
            var seedId = id.Substring("seed-".Length);
            var seed = BuildDefaultTips(now).FirstOrDefault(s => s.SourceId == seedId);
            if (seed == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "seed tip 不存在"));
            sourceId = seed.SourceId!;
            version = seed.Version;
        }
        else
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "tip 不存在"));
        }

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
                Version = version,
                LearnedAt = now,
            }),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { learned = new { sourceId, version } }));
    }

    private static List<DailyTip> FilterLearned(List<DailyTip> items, Dictionary<string, int> learnedMap)
    {
        if (learnedMap.Count == 0) return items;
        return items.Where(t =>
        {
            var key = t.SourceId ?? t.Id;
            return !(learnedMap.TryGetValue(key, out var learnedVer) && learnedVer >= t.Version);
        }).ToList();
    }

    /// <summary>
    /// 内置默认 tip 集合。新环境 / 清空数据库后兜底展示,管理员创建首条 tip 后即不再返回。
    /// 全部为「text / card」类,带 ActionUrl 可跳转。DisplayOrder 预留 10-90,方便管理员插入。
    /// AdminDailyTipsController 的 /seed 端点复用此列表批量写库。
    /// </summary>
    internal static List<DailyTip> BuildDefaultTips(DateTime now)
    {
        DailyTip T(
            string id, string kind, string title, string? body,
            string actionUrl, string ctaText,
            string? targetSelector, int order,
            DailyTipAutoAction? autoAction = null)
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
                SourceType = "seed",
                SourceId = id,
                DisplayOrder = order,
                IsActive = true,
                CreatedBy = "system:seed",
                CreatedAt = now,
                UpdatedAt = now
            };

        // 精简原则:只保留真的有「完整流程」价值的演示,单步 scroll / 单链接
        // 的短 tip 全部删掉;用户说「短短的流程一条流程的给删掉」。
        return new List<DailyTip>
        {
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
                            Body = "AI 会基于已有能力 + 全局基础设施,长出几条新维度。看到新分支就算完成 🎉",
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

            // 7. 视觉创作 —— 生成第一张图
            T("visual-first-image", "card",
                "用 AI 生成第一张图",
                "输入描述 → 选场景 → 一键出图。无需配 API key,平台已接好多个生图模型。",
                "/visual-agent",
                "去创作",
                "[data-tour-id=visual-prompt-input]",
                80,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new()
                        {
                            Selector = "[data-tour-id=visual-prompt-input]",
                            Title = "第 1 步:写下你想要的图",
                            Body = "中英文都行 — 越具体越好(场景 + 风格 + 主体)。下方有场景标签可一键套用。",
                            NavigateTo = "/visual-agent",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=visual-submit-btn]",
                            Title = "第 2 步:点「开始创作」",
                            Body = "AI 流式生成,过程实时反馈;出图后还能回来继续微调或加水印。",
                        },
                    },
                }),

            // 8. 知识库发布 —— 2 步 Tour(都在列表页,不依赖空间详情页的动态 URL)
            // 空间详情 URL 带 space id,演示无法直接导航过去,所以只能指导用户自己
            // 从列表进详情;详情页内的上传 / 发布按钮用户看得见的时候就自然能用。
            T("library-publish", "card",
                "把你的知识发布到智识殿堂",
                "列表 → 新建空间 → 上传文档 → 发布到社区。3 分钟搞定。",
                "/document-store",
                "开始发布",
                "[data-tour-id=document-store-create]",
                50,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new()
                        {
                            Selector = "[data-tour-id=document-store-create]",
                            Title = "第 1 步:新建一个空间",
                            Body = "点右上角「+ 新建空间」,取个名字,这是你的第一个知识库。",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=document-store-create]",
                            Title = "第 2 步:打开空间后的操作",
                            Body = "在列表点「打开」进入空间;右上角会出现「上传文档」和「发布到智识殿堂」两个按钮,拖文件进去 + 勾发布,就能被全平台搜到。",
                        },
                    },
                }),
        };
    }
}
