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

    private string ResolveDir(string? domain, string? type)
    {
        // 默认保持向后兼容：不传 domain/type 时，仍使用构造参数 baseDir
        if (string.IsNullOrWhiteSpace(domain) || string.IsNullOrWhiteSpace(type)) return _baseDir;
        var d = AppDomainPaths.NormDomain(domain);
        var t = AppDomainPaths.NormType(type);
        return Path.Combine(_baseDir, d, t);
    }

    public async Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null)
    {
        if (bytes == null || bytes.Length == 0) throw new ArgumentException("bytes empty");
        var safeMime = string.IsNullOrWhiteSpace(mime) ? "image/png" : mime.Trim();
        var ext = MimeToExt(safeMime);
        var sha = Sha256Hex(bytes);
        var dir = ResolveDir(domain, type);
        Directory.CreateDirectory(dir);
        var filePath = Path.Combine(dir, $"{sha}.{ext}");

        if (!File.Exists(filePath))
        {
            await File.WriteAllBytesAsync(filePath, bytes, ct);
        }

        // 本地存储：仍通过 image-master 文件读取接口读取（兼容旧前端/旧 URL）。
        // 注意：该接口按 sha 查找，不包含 domain/type；因此本地模式只建议用于单机开发调试。
        var url = $"/api/v1/admin/image-master/assets/file/{sha}.{ext}";
        return new StoredAsset(sha, url, bytes.LongLength, safeMime);
    }

    public async Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
    {
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha)) return null;
        if (sha.Length < 16) return null;

        var dirs = new List<string>();
        // 1) domain/type 指定目录优先
        try
        {
            if (!string.IsNullOrWhiteSpace(domain) && !string.IsNullOrWhiteSpace(type))
            {
                dirs.Add(ResolveDir(domain, type));
            }
        }
        catch
        {
            // ignore
        }
        // 2) baseDir 兜底（兼容旧数据）
        dirs.Add(_baseDir);

        // 支持常见图片/字体扩展
        var exts = new[] { "png", "jpg", "jpeg", "webp", "gif", "ttf", "otf", "woff", "woff2" };
        foreach (var dir in dirs.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            foreach (var ext in exts)
            {
                var fp = Path.Combine(dir, $"{sha}.{ext}");
                if (!File.Exists(fp)) continue;
                var bytes = await File.ReadAllBytesAsync(fp, ct);
                return (bytes, ExtToMime(ext));
            }
        }
        return null;
    }

    public Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
    {
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha)) return Task.CompletedTask;
        if (sha.Length < 16) return Task.CompletedTask;

        var dirs = new List<string>();
        try
        {
            if (!string.IsNullOrWhiteSpace(domain) && !string.IsNullOrWhiteSpace(type))
            {
                dirs.Add(ResolveDir(domain, type));
            }
        }
        catch
        {
            // ignore
        }
        dirs.Add(_baseDir);

        // 支持常见图片/字体扩展（与读取逻辑保持一致）
        var exts = new[] { "png", "jpg", "jpeg", "webp", "gif", "ttf", "otf", "woff", "woff2" };
        foreach (var dir in dirs.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            foreach (var ext in exts)
            {
                ct.ThrowIfCancellationRequested();
                var fp = Path.Combine(dir, $"{sha}.{ext}");
                try
                {
                    if (File.Exists(fp)) File.Delete(fp);
                }
                catch
                {
                    // ignore：删除失败不应阻断主流程（控制层可选择记录日志）
                }
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
            "font/ttf" or "application/x-font-ttf" or "application/font-sfnt" => "ttf",
            "font/otf" or "application/x-font-opentype" => "otf",
            "font/woff" or "application/font-woff" => "woff",
            "font/woff2" or "application/font-woff2" => "woff2",
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
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            _ => "image/png"
        };
    }
}

