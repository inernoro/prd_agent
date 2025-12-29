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
}


