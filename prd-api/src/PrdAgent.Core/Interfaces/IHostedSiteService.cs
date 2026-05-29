using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 托管站点领域服务 — 文件上传、ZIP 解压、COS 存储、分享链接
/// 供 Controller 和 Worker/Agent 共同使用的统一入口
/// </summary>
public interface IHostedSiteService
{
    // ── 创建 ──

    /// <summary>从 HTML 文件字节创建站点</summary>
    Task<HostedSite> CreateFromHtmlAsync(
        string userId, byte[] htmlBytes, string fileName,
        string? title, string? description, string? folder, List<string>? tags,
        CancellationToken ct = default);

    /// <summary>从 ZIP 文件字节创建站点；wrappedAssetType 由调用方在生成"壳子+资产"包装 ZIP 时显式传入</summary>
    Task<HostedSite> CreateFromZipAsync(
        string userId, byte[] zipBytes,
        string? title, string? description, string? folder, List<string>? tags,
        string? wrappedAssetType = null,
        CancellationToken ct = default);

    /// <summary>从 HTML 字符串创建站点（供工作流/Agent 调用）</summary>
    Task<HostedSite> CreateFromContentAsync(
        string userId, string htmlContent,
        string? title, string? description,
        string sourceType, string? sourceRef,
        List<string>? tags, string? folder,
        CancellationToken ct = default);

    // ── 替换内容 ──

    /// <summary>重新上传站点文件（HTML 或 ZIP），替换原有内容；wrappedAssetType 由调用方按原始资产类型显式传入（"pdf"/"video"/"markdown"），普通 HTML/ZIP 传 null 会清空 marker</summary>
    Task<HostedSite> ReuploadAsync(
        string siteId, string userId,
        byte[] fileBytes, string fileName,
        string? wrappedAssetType = null,
        CancellationToken ct = default);

    /// <summary>回填存量 PDF 包装站的 WrappedAssetType marker（一次性维护任务，由 HostedSiteBackfillService 启动调用）</summary>
    Task<int> BackfillPdfWrapperMarkersAsync(CancellationToken ct = default);

    // ── 查询 ──

    Task<HostedSite?> GetByIdAsync(string siteId, string userId, CancellationToken ct = default);

    Task<(List<HostedSite> Items, long Total)> ListAsync(
        string userId, string? keyword, string? folder,
        string? tag, string? sourceType, string sort,
        int skip, int limit, string? scope = null, string? teamId = null,
        CancellationToken ct = default);

    /// <summary>设置站点分享到的团队（「分享到团队」操作，仅 owner 可调）。返回更新后的站点，无权或不存在返回 null</summary>
    Task<HostedSite?> SetSharedTeamsAsync(string siteId, string userId, List<string> teamIds, CancellationToken ct = default);

    Task<List<string>> ListFoldersAsync(string userId, CancellationToken ct = default);

    Task<List<TagCountResult>> ListTagsAsync(string userId, CancellationToken ct = default);

    // ── 更新 / 删除 ──

    Task<HostedSite?> UpdateAsync(
        string siteId, string userId,
        string? title, string? description,
        List<string>? tags, string? folder, string? coverImageUrl,
        CancellationToken ct = default);

    Task<bool> DeleteAsync(string siteId, string userId, CancellationToken ct = default);

    Task<long> BatchDeleteAsync(List<string> siteIds, string userId, CancellationToken ct = default);

    // ── 可见性 ──

    /// <summary>切换站点可见性（private / public），首次 public 时写入 PublishedAt</summary>
    Task<HostedSite?> SetVisibilityAsync(string siteId, string userId, string visibility, CancellationToken ct = default);

    /// <summary>按用户名获取该用户所有公开的站点（公开页聚合，无需登录）</summary>
    Task<List<HostedSite>> ListPublicByUserIdAsync(string ownerUserId, int limit = 60, CancellationToken ct = default);

    // ── 分享 ──

    /// <summary>
    /// 创建分享链接。
    /// - forceNew=true：用户在分享面板中显式点「新建分享」，无论是否存在可复用条目都新建（默认行为，PR 2026-05-28 起）
    /// - forceNew=false：站点访问便捷链等内部场景，保留服务端去重 + 续期复用
    /// - visibility：owner-only（默认，仅创建者/团队成员可访问）/ logged-in / public
    /// </summary>
    Task<WebPageShareLink> CreateShareAsync(
        string userId, string displayName,
        string? siteId, List<string>? siteIds, string shareType,
        string? title, string? description,
        string? password, int expiresInDays,
        CancellationToken ct = default,
        string purpose = "share",
        bool forceNew = false,
        string visibility = "owner-only");

    /// <summary>
    /// 列出分享：默认包含未过期 + 过期 ≤ 7 天（允许续期）的链接。
    /// 已撤销 / 过期 > 7 天的链接不返回，但保留 DB 行用于审计。
    /// </summary>
    Task<List<WebPageShareLink>> ListSharesAsync(string userId, CancellationToken ct = default);

    /// <summary>
    /// 续期某条分享链接。仅创建者可调用。
    /// - 链接已撤销：失败
    /// - 当前未过期：新过期时间 = max(now, ExpiresAt) + extendDays
    /// - 已过期 ≤ 7 天：新过期时间 = now + extendDays
    /// - 已过期 > 7 天：失败（视为彻底失效，用户应新建链接）
    /// </summary>
    Task<RenewShareResult> RenewShareAsync(string shareId, string userId, int extendDays, CancellationToken ct = default);

    Task<bool> RevokeShareAsync(string shareId, string userId, CancellationToken ct = default);

    Task<ShareViewResult?> ViewShareAsync(string token, string? password,
        string? viewerUserId = null, string? viewerName = null,
        string? ipAddress = null, string? userAgent = null,
        CancellationToken ct = default);

    /// <summary>获取分享的观看记录（供分享所有者查看）</summary>
    Task<List<ShareViewLog>> ListShareViewLogsAsync(string userId, string? shareToken, int limit = 100, CancellationToken ct = default);

    /// <summary>
    /// 获取某个站点的分享访问日志。仅站点 owner 可调；按站点维度聚合多条分享链接的日志，
    /// 用于分享面板底部「访问日志」区。
    /// </summary>
    Task<List<ShareViewLog>> ListShareViewLogsForSiteAsync(string siteId, string userId, int limit = 50, CancellationToken ct = default);

    /// <summary>
    /// 用户分享统计聚合：当前所有未撤销分享 + 活跃链接 + 时间窗内访问总量 / 独立 IP / 时间线。
    /// 用于「分享统计」Drawer（参考 Cloudflare 风格简化版）。
    /// siteId 非空时把统计范围收窄到该站点（用于站点卡上的「本站点统计」过滤按钮）。
    /// </summary>
    Task<ShareAnalyticsResult> GetShareAnalyticsAsync(string userId, int rangeDays, string? siteId = null, CancellationToken ct = default);

    /// <summary>
    /// 分享诊断（admin only）：返回某个 Token 完整状态 + 续期历史 + 最近访问 + 一句话原因诊断，
    /// 用于排查"为什么这个链接过期了 / 看不到"投诉。
    /// </summary>
    Task<ShareDiagnosticsResult?> GetShareDiagnosticsAsync(string token, CancellationToken ct = default);

    /// <summary>将分享的站点保存到自己的托管（去重：同一 token 只保存一次）</summary>
    Task<SaveSharedSiteResult> SaveSharedSiteAsync(string token, string? password, string userId, CancellationToken ct = default);

    /// <summary>
    /// 一次性数据迁移：把所有现存非 visit 的分享链接的 Visibility 从默认 "owner-only" 改为 "public"，
    /// 仅作用于本次发布前已创建的链接（用 marker 字段或时间窗判定）。
    /// 由 WebPageVisibilityBackfillService 在启动时调用一次。
    /// </summary>
    Task<int> BackfillShareVisibilityAsync(CancellationToken ct = default);
}

public class TagCountResult
{
    public string Tag { get; set; } = string.Empty;
    public int Count { get; set; }
}

public class ShareViewResult
{
    public string? Title { get; set; }
    public string? Description { get; set; }
    public string ShareType { get; set; } = "single";
    public DateTime CreatedAt { get; set; }
    public string? CreatedBy { get; set; }
    public string? CreatedByName { get; set; }
    public List<SharedSiteInfo> Sites { get; set; } = new();
    public string? Error { get; set; }
    public int HttpStatus { get; set; } = 200;
    /// <summary>错误码：visibility_denied / expired / wrong_password / rate_limited / not_found</summary>
    public string? ErrorCode { get; set; }
    /// <summary>HttpStatus = 429 时填充，告知前端 N 秒后再试（驱动倒计时 UI）</summary>
    public int? RetryAfterSeconds { get; set; }
}

public class RenewShareResult
{
    public bool Ok { get; set; }
    public string? Error { get; set; }
    public DateTime? NewExpiresAt { get; set; }
}

public class ShareAnalyticsResult
{
    public int TotalShares { get; set; }
    public int ActiveShares { get; set; }
    public int ExpiredShares { get; set; }
    public long TotalViews { get; set; }
    public int UniqueIpCount { get; set; }
    public List<ShareAnalyticsTimelineEntry> Timeline { get; set; } = new();
    public List<ShareAnalyticsLinkSummary> TopLinks { get; set; } = new();
}

public class ShareAnalyticsTimelineEntry
{
    public DateTime ViewedAt { get; set; }
    public string ShareToken { get; set; } = string.Empty;
    public string? ShareTitle { get; set; }
    public string? ViewerName { get; set; }
    public string? IpAddress { get; set; }
    public string? UserAgent { get; set; }
}

public class ShareAnalyticsLinkSummary
{
    public string ShareId { get; set; } = string.Empty;
    public string Token { get; set; } = string.Empty;
    public string? Title { get; set; }
    public long ViewCount { get; set; }
    public long UniqueIpCount { get; set; }
    public DateTime? LastViewedAt { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public string Visibility { get; set; } = "owner-only";
}

public class ShareDiagnosticsResult
{
    public string Token { get; set; } = string.Empty;
    public string Id { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; }
    public string? CreatedBy { get; set; }
    public string? CreatedByName { get; set; }
    public DateTime? ExpiresAt { get; set; }
    public bool IsRevoked { get; set; }
    public string Visibility { get; set; } = "owner-only";
    public string AccessLevel { get; set; } = "public";
    public long ViewCount { get; set; }
    public DateTime? LastViewedAt { get; set; }
    public List<ShareRenewalEvent> RenewalHistory { get; set; } = new();
    public List<ShareViewLog> RecentViews { get; set; } = new();
    /// <summary>一句话诊断：解释链接当前是否可访问，及为什么。</summary>
    public string DiagnosisSummary { get; set; } = string.Empty;
}

public class SaveSharedSiteResult
{
    public bool AlreadySaved { get; set; }
    public bool Saved { get; set; }
    public List<HostedSite> Sites { get; set; } = new();
    public string? Error { get; set; }
    public int HttpStatus { get; set; } = 200;
    /// <summary>HttpStatus = 429 时填充，告知前端 N 秒后再试</summary>
    public int? RetryAfterSeconds { get; set; }
}

public class SharedSiteInfo
{
    public string Id { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? Description { get; set; }
    public string SiteUrl { get; set; } = string.Empty;
    public string EntryFile { get; set; } = string.Empty;
    public long TotalSize { get; set; }
    public int FileCount { get; set; }
    public string? CoverImageUrl { get; set; }

    /// <summary>
    /// 仅当本站点是「PDF 包装站」（index.html 壳子 + 单个 .pdf 资产）时填充，
    /// 指向真实 PDF 文件的直链。前端拿到后应直接 iframe 这个 URL，让浏览器原生
    /// PDF Viewer 接管；否则嵌套 iframe + sandbox 会被 Chrome 屏蔽。
    /// </summary>
    public string? PdfAssetUrl { get; set; }
}
