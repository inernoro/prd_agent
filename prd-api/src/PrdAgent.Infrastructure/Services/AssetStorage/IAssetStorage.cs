namespace PrdAgent.Infrastructure.Services.AssetStorage;

public record StoredAsset(string Sha256, string Url, long SizeBytes, string Mime);

public interface IAssetStorage
{
    /// <summary>
    /// 保存 bytes 并返回稳定可访问 URL。
    /// 重要：若提供 domain/type，则会把对象存储到 {domain}/{type}/...（全小写）。
    /// fileName/extensionHint 用于决定存储 key 的扩展名 —— 这是首选来源，因为 mime 反推
    /// 扩展名（image/jpeg → jpg）对 audio/video/zip/docx 等不可靠（octet-stream 全踩坑）。
    ///   - 优先：extensionHint（如 ".m4a"）
    ///   - 次选：从 fileName 提取扩展名
    ///   - 最后：从 mime 反推（仅图片/字体/常见文档可靠）
    ///   - 兜底：".bin"（绝不再用 .png 兜底，否则 CDN 会按图片处理音视频）
    /// </summary>
    Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null, string? fileName = null, string? extensionHint = null);

    /// <summary>
    /// 按 sha256 读取 bytes（用于本地存储或兼容旧数据）。
    /// </summary>
    Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null);

    /// <summary>
    /// 按 sha256 删除底层对象（若实现支持）。
    /// </summary>
    Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null);

    /// <summary>
    /// 按 sha256 和 mime 类型构建公开访问 URL（不下载文件）。
    /// </summary>
    string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null);

    /// <summary>
    /// 按 key 下载对象的原始 bytes（不存在返回 null）。
    /// </summary>
    Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct);

    /// <summary>
    /// 判断指定 key 的对象是否存在。
    /// </summary>
    Task<bool> ExistsAsync(string key, CancellationToken ct);

    /// <summary>
    /// 上传 bytes 到指定的自定义 key（绕过 SHA256 去重，用于站点托管等场景）。
    /// key 需包含完整路径（含 prefix），可通过 BuildSiteKey 生成。
    /// cacheControl 可选：设置对象的 Cache-Control 响应头（如 "public, max-age=3600"）。
    /// 网页托管场景配合 SiteUrl 上的 ?v={UpdatedAt} 版本指纹使用：内容不变 → URL 不变 → 命中缓存；
    /// 重新上传 → UpdatedAt 变化 → URL 变化 → 击穿缓存。
    /// </summary>
    Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct, string? cacheControl = null);

    /// <summary>
    /// 根据 key 构建公开访问 URL。
    /// </summary>
    string BuildUrlForKey(string key);

    /// <summary>
    /// 删除指定 key 的对象。
    /// </summary>
    Task DeleteByKeyAsync(string key, CancellationToken ct);

    /// <summary>
    /// 构建站点托管文件的 COS key（含 prefix），格式：{prefix}/web-hosting/sites/{siteId}/{filePath}
    /// </summary>
    string BuildSiteKey(string siteId, string filePath);
}


