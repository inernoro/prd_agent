using System.Security.Cryptography;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Infrastructure.Services.AssetStorage;

public class LocalAssetStorage : IAssetStorage
{
    private readonly string _baseDir;

    public LocalAssetStorage(string baseDir)
    {
        _baseDir = baseDir;
        Directory.CreateDirectory(_baseDir);
    }

    public async Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct)
    {
        if (bytes == null || bytes.Length == 0) throw new ArgumentException("bytes empty");
        var safeMime = string.IsNullOrWhiteSpace(mime) ? "image/png" : mime.Trim();
        var ext = MimeToExt(safeMime);
        var sha = Sha256Hex(bytes);
        var filePath = Path.Combine(_baseDir, $"{sha}.{ext}");

        if (!File.Exists(filePath))
        {
            await File.WriteAllBytesAsync(filePath, bytes, ct);
        }

        var url = $"/api/v1/admin/image-master/assets/file/{sha}.{ext}";
        return new StoredAsset(sha, url, bytes.LongLength, safeMime);
    }

    public async Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct)
    {
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha)) return null;
        if (sha.Length < 16) return null;

        // 支持常见图片扩展
        var exts = new[] { "png", "jpg", "jpeg", "webp", "gif" };
        foreach (var ext in exts)
        {
            var fp = Path.Combine(_baseDir, $"{sha}.{ext}");
            if (!File.Exists(fp)) continue;
            var bytes = await File.ReadAllBytesAsync(fp, ct);
            return (bytes, ExtToMime(ext));
        }
        return null;
    }

    public Task DeleteByShaAsync(string sha256, CancellationToken ct)
    {
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha)) return Task.CompletedTask;
        if (sha.Length < 16) return Task.CompletedTask;

        // 支持常见图片扩展（与读取逻辑保持一致）
        var exts = new[] { "png", "jpg", "jpeg", "webp", "gif" };
        foreach (var ext in exts)
        {
            ct.ThrowIfCancellationRequested();
            var fp = Path.Combine(_baseDir, $"{sha}.{ext}");
            try
            {
                if (File.Exists(fp)) File.Delete(fp);
            }
            catch
            {
                // ignore：删除失败不应阻断主流程（控制层可选择记录日志）
            }
        }

        return Task.CompletedTask;
    }

    private static string Sha256Hex(byte[] bytes)
    {
        using var sha = SHA256.Create();
        var h = sha.ComputeHash(bytes);
        return Convert.ToHexString(h).ToLowerInvariant();
    }

    private static string MimeToExt(string mime)
    {
        return mime.ToLowerInvariant() switch
        {
            "image/jpeg" or "image/jpg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            _ => "png"
        };
    }

    private static string ExtToMime(string ext)
    {
        return ext.ToLowerInvariant() switch
        {
            "jpg" or "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => "image/png"
        };
    }
}


