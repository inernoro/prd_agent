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
            // 1. 缺陷管理全链路 —— 4 步真流程
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

            // 3. 大全套演示 —— 测试用,展示 autoAction 所有能力(scroll + prefill + 多步 Tour)
            // 起点百宝箱:预填搜索框 → 高亮搜索框 → 高亮海鲜市场入口 → 高亮侧边栏
            T("showcase-all-features", "card",
                "大全套:一条 tip 跑通所有交互形态",
                "这是一条测试用演示,展示「预填输入 → 滚动定位 → 多步高亮」三件套。\n开发教程时用来验证组件行为。",
                "/ai-toolbox",
                "跑完看效果",
                "[data-tour-id=toolbox-search]",
                5,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    // autoAction 级别的「预填」—— 跳转到落地页时搜索框自动填好"周报"
                    Prefill = new DailyTipPrefill
                    {
                        Selector = "[data-tour-id=toolbox-search]",
                        Value = "周报",
                    },
                    Steps = new List<DailyTipTourStep>
                    {
                        new()
                        {
                            Selector = "[data-tour-id=toolbox-search]",
                            Title = "第 1 步:搜索框已预填「周报」",
                            Body = "跳转的瞬间 Prefill 能力自动触发了 React onChange,列表已按「周报」过滤。",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=home-search]",
                            Title = "第 2 步:⌘+K 全站搜索",
                            Body = "点「下一步」会自动替你点击这个搜索入口,触发命令面板。",
                        },
                        new()
                        {
                            Selector = "[data-tour-id=command-palette-input]",
                            Title = "第 3 步:命令面板 input",
                            Body = "多步 Tour 的最后一步,点「完成 🎉」会从这个按钮位置撒花 + 永久 dismiss。",
                        },
                    },
                }),

            // 4. 知识库发布 —— 2 步 Tour(都在列表页,不依赖空间详情页的动态 URL)
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
