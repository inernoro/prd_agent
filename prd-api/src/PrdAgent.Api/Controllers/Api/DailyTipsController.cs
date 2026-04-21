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

        // 数据库没有任何 tip 时,兜底返回内置默认集,避免新环境出现空白
        if (items.Count == 0)
        {
            items = BuildDefaultTips(now);
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
    /// 内置默认 tip 集合。新环境 / 清空数据库后兜底展示,管理员创建首条 tip 后即不再返回。
    /// 全部为「text / card」类,带 ActionUrl 可跳转。DisplayOrder 预留 10-90,方便管理员插入。
    /// </summary>
    private static List<DailyTip> BuildDefaultTips(DateTime now)
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

        return new List<DailyTip>
        {
            T("search-agent", "text",
                "试试 ⌘ / Ctrl + K:一键搜索所有 Agent、文档与知识库",
                null,
                "/",
                "打开搜索",
                "[data-tour-id=home-search]",
                10,
                new DailyTipAutoAction { Scroll = "center" }),
            T("marketplace", "text",
                "海鲜市场上线了提示词 / 参考图 / 水印,一键 Fork 到本地可编辑",
                null,
                "/marketplace",
                "去逛逛",
                "[data-tour-id=marketplace-category-tabs]",
                20,
                new DailyTipAutoAction { Scroll = "center" }),
            T("library", "text",
                "智识殿堂:团队共享的知识库已开放,可上传文档自动同步订阅源",
                null,
                "/library",
                "进入智识殿堂",
                "[data-tour-id=library-create]",
                30,
                new DailyTipAutoAction { Scroll = "center" }),
            T("toolbox", "card",
                "百宝箱:所有 Agent 和工具的统一入口",
                "新增的智能体默认注册到百宝箱,左侧导航只收录已毕业的常用项。",
                "/ai-toolbox",
                "打开百宝箱",
                "[data-tour-id=toolbox-search]",
                40,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Prefill = new DailyTipPrefill
                    {
                        Selector = "[data-tour-id=toolbox-search]",
                        Value = "周报",
                    },
                }),
            T("defect-feedback", "card",
                "发现 bug?一键反馈并跟踪修复",
                "缺陷管理 Agent 支持截图 + 描述,开发完成后你会收到「已修复」推送。",
                "/defect-agent",
                "去反馈",
                "[data-tour-id=defect-create]",
                50,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    AutoClick = "[data-tour-id=defect-create]",
                    AutoClickDelayMs = 1500,
                }),
            T("updates", "text",
                "更新中心:本周平台新增了什么?代码级周报自动生成",
                null,
                "/changelog",
                "查看更新",
                "[data-tour-id=changelog-latest]",
                60,
                new DailyTipAutoAction { Scroll = "center" }),
            T("report-agent", "card",
                "周报管理 Agent:自动汇总 git 提交,生成团队周报",
                "支持数据源自动采集、多模板、飞书 / 邮件分发,周五一键出稿。",
                "/report-agent",
                "试试周报",
                "[data-tour-id=report-template-picker]",
                70,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    Steps = new List<DailyTipTourStep>
                    {
                        new()
                        {
                            Selector = "[data-tour-id=report-template-picker]",
                            Title = "第 1 步:写周报",
                            Body = "点开后选模板、勾数据源,系统会自动汇总本周 git 提交。",
                        },
                    },
                }),
            T("emergence", "text",
                "涌现探索器:从种子 → 探索 → 涌现,让 AI 帮你发散新功能",
                null,
                "/emergence",
                "开始涌现",
                "[data-tour-id=emergence-seed-input]",
                80,
                new DailyTipAutoAction
                {
                    Scroll = "center",
                    AutoClick = "[data-tour-id=emergence-seed-input]",
                    AutoClickDelayMs = 1800,
                }),
        };
    }
}
