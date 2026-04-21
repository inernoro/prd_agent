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

        // 可见性:全局(TargetUserId 为空)或定向推送给当前用户
        filter &= Builders<DailyTip>.Filter.Or(
            Builders<DailyTip>.Filter.Eq(x => x.TargetUserId, null),
            Builders<DailyTip>.Filter.Eq(x => x.TargetUserId, userId));

        var items = await _db.DailyTips
            .Find(filter)
            .SortBy(x => x.DisplayOrder)
            .ThenByDescending(x => x.CreatedAt)
            .Limit(50)
            .ToListAsync(ct);

        // 数据库没有任何 tip 时,兜底返回内置默认集,避免新环境出现空白
        if (items.Count == 0)
        {
            items = BuildDefaultTips(now);
        }

        // 定向 tip 永远置顶,保证「为你修复」类消息被最先看到
        var ordered = items
            .OrderByDescending(x => x.TargetUserId == userId)
            .ThenBy(x => x.DisplayOrder)
            .ThenByDescending(x => x.CreatedAt)
            .Select(x => new
            {
                x.Id,
                x.Kind,
                x.Title,
                x.Body,
                x.CoverImageUrl,
                x.ActionUrl,
                x.CtaText,
                x.TargetSelector,
                isTargeted = x.TargetUserId == userId,
                x.SourceType,
                x.CreatedAt
            })
            .ToList();

        return Ok(ApiResponse<object>.Ok(new { items = ordered }));
    }

    /// <summary>
    /// 内置默认 tip 集合。新环境 / 清空数据库后兜底展示,管理员创建首条 tip 后即不再返回。
    /// 全部为「text / card」类,带 ActionUrl 可跳转。DisplayOrder 预留 10-90,方便管理员插入。
    /// </summary>
    private static List<DailyTip> BuildDefaultTips(DateTime now)
    {
        DailyTip T(string id, string kind, string title, string? body, string actionUrl, string ctaText, string? targetSelector, int order)
            => new()
            {
                Id = $"seed-{id}",
                Kind = kind,
                Title = title,
                Body = body,
                ActionUrl = actionUrl,
                CtaText = ctaText,
                TargetSelector = targetSelector,
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
                10),
            T("marketplace", "text",
                "海鲜市场上线了提示词 / 参考图 / 水印,一键 Fork 到本地可编辑",
                null,
                "/marketplace",
                "去逛逛",
                "[data-tour-id=quicklink-marketplace]",
                20),
            T("library", "text",
                "智识殿堂:团队共享的知识库已开放,可上传文档自动同步订阅源",
                null,
                "/library",
                "进入智识殿堂",
                "[data-tour-id=quicklink-library]",
                30),
            T("toolbox", "card",
                "百宝箱:所有 Agent 和工具的统一入口",
                "新增的智能体默认注册到百宝箱,左侧导航只收录已毕业的常用项。",
                "/ai-toolbox",
                "打开百宝箱",
                null,
                40),
            T("defect-feedback", "card",
                "发现 bug?一键反馈并跟踪修复",
                "缺陷管理 Agent 支持截图 + 描述,开发完成后你会收到「已修复」推送。",
                "/defect-agent",
                "去反馈",
                null,
                50),
            T("updates", "text",
                "更新中心:本周平台新增了什么?代码级周报自动生成",
                null,
                "/changelog",
                "查看更新",
                "[data-tour-id=quicklink-updates]",
                60),
            T("report-agent", "card",
                "周报管理 Agent:自动汇总 git 提交,生成团队周报",
                "支持数据源自动采集、多模板、飞书 / 邮件分发,周五一键出稿。",
                "/report-agent",
                "试试周报",
                null,
                70),
            T("emergence", "text",
                "涌现探索器:从种子 → 探索 → 涌现,让 AI 帮你发散新功能",
                null,
                "/emergence",
                "开始涌现",
                null,
                80),
        };
    }
}
