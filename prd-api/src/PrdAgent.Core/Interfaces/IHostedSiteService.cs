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

    /// <summary>从 ZIP 文件字节创建站点</summary>
    Task<HostedSite> CreateFromZipAsync(
        string userId, byte[] zipBytes,
        string? title, string? description, string? folder, List<string>? tags,
        CancellationToken ct = default);

    /// <summary>从 HTML 字符串创建站点（供工作流/Agent 调用）</summary>
    Task<HostedSite> CreateFromContentAsync(
        string userId, string htmlContent,
        string? title, string? description,
        string sourceType, string? sourceRef,
        List<string>? tags, string? folder,
        CancellationToken ct = default);

    // ── 替换内容 ──

    /// <summary>重新上传站点文件（HTML 或 ZIP），替换原有内容</summary>
    Task<HostedSite> ReuploadAsync(
        string siteId, string userId,
        byte[] fileBytes, string fileName,
        CancellationToken ct = default);

    // ── 查询 ──

    Task<HostedSite?> GetByIdAsync(string siteId, string userId, CancellationToken ct = default);

    Task<(List<HostedSite> Items, long Total)> ListAsync(
        string userId, string? keyword, string? folder,
        string? tag, string? sourceType, string sort,
        int skip, int limit, CancellationToken ct = default);

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

    // ── 分享 ──

    Task<WebPageShareLink> CreateShareAsync(
        string userId, string displayName,
        string? siteId, List<string>? siteIds, string shareType,
        string? title, string? description,
        string? password, int expiresInDays,
        CancellationToken ct = default);

    Task<List<WebPageShareLink>> ListSharesAsync(string userId, CancellationToken ct = default);

    Task<bool> RevokeShareAsync(string shareId, string userId, CancellationToken ct = default);

    Task<ShareViewResult?> ViewShareAsync(string token, string? password, CancellationToken ct = default);
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
    public List<SharedSiteInfo> Sites { get; set; } = new();
    public string? Error { get; set; }
    public int HttpStatus { get; set; } = 200;
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
}
