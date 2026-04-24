namespace PrdAgent.Infrastructure.Services.AssetStorage;

public record StoredAsset(string Sha256, string Url, long SizeBytes, string Mime);

public interface IAssetStorage
{
    /// <summary>
    /// 保存 bytes 并返回稳定可访问 URL。
    /// 重要：若提供 domain/type，则会把对象存储到 {domain}/{type}/...（全小写）。
    /// </summary>
    Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null);

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
    /// </summary>
    Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct);

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


