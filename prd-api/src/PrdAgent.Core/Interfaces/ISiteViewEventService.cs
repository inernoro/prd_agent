namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 托管站点访客痕迹服务 —— 记录「哪个登录用户看了哪个站点」，并向站点 owner /
/// 共享团队成员回放访客列表（防文档泄密）。
/// 与 ShareViewLog 区别：本服务覆盖应用内「直接 / 团队」访问；分享链接访问走 ShareViewLog。
/// </summary>
public interface ISiteViewEventService
{
    /// <summary>
    /// 记录一次站点访问。30 分钟内同一 (站点, 访客) 去重不重复写。
    /// 内部 try/catch 兜底，记录失败不抛给调用方（埋点不得影响主流程）。
    /// </summary>
    Task RecordAsync(string siteId, string viewerUserId, string? ip, string? userAgent, CancellationToken ct = default);

    /// <summary>
    /// 列出某站点的访客痕迹（仅 owner 或共享团队成员可见，否则返回空结果）。
    /// </summary>
    Task<SiteViewersResult> ListViewersAsync(string siteId, string requesterUserId, int skip, int limit, CancellationToken ct = default);
}

/// <summary>访客列表查询结果（含分页数据 + 总访问数 + 去重访客数）</summary>
public class SiteViewersResult
{
    public List<SiteViewerItem> Items { get; set; } = new();

    /// <summary>该站点累计访问事件数（去重窗口内的合并后）</summary>
    public long Total { get; set; }

    /// <summary>去重后的独立访客数（按 ViewerUserId distinct）</summary>
    public long UniqueViewers { get; set; }
}

/// <summary>单条访客记录（actor 快照，前端直接渲染）</summary>
public class SiteViewerItem
{
    public string ViewerUserId { get; set; } = string.Empty;
    public string? ViewerName { get; set; }
    public string? ViewerAvatarFileName { get; set; }
    public DateTime ViewedAt { get; set; }
}
