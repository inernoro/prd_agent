namespace PrdAgent.Core.Models;

/// <summary>
/// 每日小贴士 / 定制化引导卡片。
///
/// 由管理员在「系统设置 → 小技巧管理」维护，或由系统（如缺陷修复钩子）自动生成。
/// 登录后首页副标题位轮播 text 类、右上角抽屉展示 card/spotlight 类。
/// </summary>
public class DailyTip
{
    /// <summary>主键</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 展示类型：
    /// - text: 副标题位文字轮播（仅需 Title + ActionUrl）
    /// - card: 右上角图文卡片
    /// - spotlight: 图文卡片 + 跳转落地后高亮目标 DOM (TargetSelector)
    /// </summary>
    public string Kind { get; set; } = "text";

    /// <summary>标题（必填）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>正文（支持 markdown，card/spotlight 使用）</summary>
    public string? Body { get; set; }

    /// <summary>封面图 URL（card/spotlight 使用）</summary>
    public string? CoverImageUrl { get; set; }

    /// <summary>点击跳转的站内路由（必填，保证 tip 都可关联跳转）</summary>
    public string ActionUrl { get; set; } = "/";

    /// <summary>CTA 按钮文案，默认「去看看」</summary>
    public string CtaText { get; set; } = "去看看";

    /// <summary>
    /// Spotlight 专用：落地页上目标元素的选择器，
    /// 例如 "[data-tour-id=toolbox-entry]"，前端找到后加 pulse 光圈。
    /// </summary>
    public string? TargetSelector { get; set; }

    /// <summary>
    /// 定向推送对象：
    /// - null = 所有登录用户可见
    /// - 非空 = 仅该用户可见（用于缺陷修复等个性化场景，置顶显示）
    /// </summary>
    public string? TargetUserId { get; set; }

    /// <summary>定向角色列表（空=不限），仅在 TargetUserId 为 null 时生效</summary>
    public List<string>? TargetRoles { get; set; }

    /// <summary>
    /// 来源类型：
    /// - manual: 管理员后台创建
    /// - defect-fix: 缺陷修复自动生成
    /// - release-note: 版本发布自动生成（预留）
    /// </summary>
    public string SourceType { get; set; } = "manual";

    /// <summary>来源实体 ID（如 DefectReport.Id），便于溯源去重</summary>
    public string? SourceId { get; set; }

    /// <summary>显示顺序，越小越靠前</summary>
    public int DisplayOrder { get; set; } = 0;

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    /// <summary>发布窗口起（空=立即生效）</summary>
    public DateTime? StartAt { get; set; }

    /// <summary>发布窗口止（空=不过期）</summary>
    public DateTime? EndAt { get; set; }

    /// <summary>创建人 UserId</summary>
    public string CreatedBy { get; set; } = string.Empty;

    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
