namespace PrdAgent.Infrastructure.Services.AssetStorage;

public record StoredAsset(string Sha256, string Url, long SizeBytes, string Mime);

public interface IAssetStorage
{
    Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct);
    Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct);
}


