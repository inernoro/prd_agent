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

    public async Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null, string? fileName = null, string? extensionHint = null)
    {
        if (bytes == null || bytes.Length == 0) throw new ArgumentException("bytes empty");
        var safeMime = string.IsNullOrWhiteSpace(mime) ? "application/octet-stream" : mime.Trim();
        var ext = ResolveExtension(extensionHint, fileName, safeMime);
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
        // 防止 glob 注入：sha 必须是纯 hex（Directory.GetFiles 会解释 * / ?）
        if (!IsHex(sha)) return null;

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

        // 用文件系统通配 {sha}.* —— 不依赖硬编码扩展名列表
        // （ResolveExtension 现在按 fileName 决定后缀，可能是 mp3/m4a/pdf/bin 等任何值）
        foreach (var dir in dirs.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (!Directory.Exists(dir)) continue;
            string[] matches;
            try { matches = Directory.GetFiles(dir, $"{sha}.*"); }
            catch { continue; }
            foreach (var fp in matches)
            {
                var ext = Path.GetExtension(fp).TrimStart('.');
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
        // 防止 glob 注入：sha 必须是纯 hex（Directory.GetFiles 会解释 * / ?）
        if (!IsHex(sha)) return Task.CompletedTask;

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

        // 用文件系统通配 {sha}.* —— 删除该 sha 下的任意扩展名文件
        // （与 TryReadByShaAsync 同样不再硬编码扩展名列表）
        foreach (var dir in dirs.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            ct.ThrowIfCancellationRequested();
            if (!Directory.Exists(dir)) continue;
            string[] matches;
            try { matches = Directory.GetFiles(dir, $"{sha}.*"); }
            catch { continue; }
            foreach (var fp in matches)
            {
                ct.ThrowIfCancellationRequested();
                try { File.Delete(fp); }
                catch { /* ignore：删除失败不应阻断主流程 */ }
            }
        }

        return Task.CompletedTask;
    }

    /// <summary>
    /// 按 sha256 和 mime 类型构建本地访问 URL。
    /// 本地存储返回相对路径，通过 image-master 文件读取接口访问。
    /// </summary>
    public string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null)
    {
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha) || sha.Length < 16) return null;
        var ext = MimeToExt(mime ?? "image/png");
        return $"/api/v1/admin/image-master/assets/file/{sha}.{ext}";
    }

    public async Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct)
    {
        var filePath = Path.Combine(_baseDir, (key ?? string.Empty).Trim().Replace('/', Path.DirectorySeparatorChar));
        if (!File.Exists(filePath)) return null;
        return await File.ReadAllBytesAsync(filePath, ct);
    }

    public Task<bool> ExistsAsync(string key, CancellationToken ct)
    {
        var filePath = Path.Combine(_baseDir, (key ?? string.Empty).Trim().Replace('/', Path.DirectorySeparatorChar));
        return Task.FromResult(File.Exists(filePath));
    }

    public async Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct, string? cacheControl = null)
    {
        // 本地存储无对象级 Cache-Control 概念，cacheControl 仅在 COS/R2 生效，这里忽略。
        var filePath = Path.Combine(_baseDir, key.Replace('/', Path.DirectorySeparatorChar));
        var dir = Path.GetDirectoryName(filePath);
        if (dir != null) Directory.CreateDirectory(dir);
        await File.WriteAllBytesAsync(filePath, bytes, ct);
    }

    public string BuildUrlForKey(string key)
    {
        return $"/local-assets/{key}";
    }

    public Task DeleteByKeyAsync(string key, CancellationToken ct)
    {
        var filePath = Path.Combine(_baseDir, key.Replace('/', Path.DirectorySeparatorChar));
        if (File.Exists(filePath)) File.Delete(filePath);
        return Task.CompletedTask;
    }

    public string BuildSiteKey(string siteId, string filePath)
    {
        return $"web-hosting/sites/{siteId}/{filePath.TrimStart('/')}";
    }

    private static string Sha256Hex(byte[] bytes)
    {
        using var sha = SHA256.Create();
        var h = sha.ComputeHash(bytes);
        return Convert.ToHexString(h).ToLowerInvariant();
    }

    /// <summary>
    /// 决定存储文件的扩展名。优先级：extensionHint > fileName 后缀 > mime 反推 > .bin
    /// 关键原则：
    ///   1. 知识库允许存任何东西，"未知 mime → png" 这种兜底是错误的
    ///      （音视频会被 CDN 按图片处理，跨域 CORS 崩溃）
    ///   2. 用户上传时 fileName 永远存在，扩展名是最可靠的真相来源
    ///   3. mime 反推只用于"没有 fileName"的内部调用（如服务端生成的图片）
    /// </summary>
    private static string ResolveExtension(string? extensionHint, string? fileName, string mime)
    {
        // 1. 显式提示优先（去掉前导点 + 转小写 + 仅保留字母数字）
        if (!string.IsNullOrWhiteSpace(extensionHint))
        {
            var clean = SanitizeExt(extensionHint);
            if (clean != null) return clean;
        }

        // 2. fileName 后缀次之
        if (!string.IsNullOrWhiteSpace(fileName))
        {
            var fromFile = Path.GetExtension(fileName);
            var clean = SanitizeExt(fromFile);
            if (clean != null) return clean;
        }

        // 3. mime 反推（只有内部生成场景才会走到这里，例如 ImageGenWorker 拿到 PNG bytes）
        var byMime = MimeToExt(mime);
        return byMime;
    }

    /// <summary>
    /// 判断是否为纯 16 进制串（防止 sha 被注入 glob 通配符）。
    /// SHA256 hex = 64 字符 0-9a-f，但有些调用传短 sha（如前缀），所以只检查字符集不限长度。
    /// </summary>
    private static bool IsHex(string s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        foreach (var c in s)
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        return true;
    }

    private static string? SanitizeExt(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var s = raw.Trim().TrimStart('.').ToLowerInvariant();
        if (s.Length == 0 || s.Length > 8) return null;
        // 仅允许 a-z 0-9
        foreach (var c in s)
            if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return null;
        return s;
    }

    private static string MimeToExt(string mime)
    {
        // 提取 mime type 主体部分（去掉 charset 等参数）
        var m = mime.ToLowerInvariant();
        var semi = m.IndexOf(';');
        if (semi > 0) m = m[..semi].Trim();

        return m switch
        {
            // 图片
            "image/jpeg" or "image/jpg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            "image/svg+xml" => "svg",
            "image/png" => "png",
            // 字体
            "font/ttf" or "application/x-font-ttf" or "application/font-sfnt" => "ttf",
            "font/otf" or "application/x-font-opentype" => "otf",
            "font/woff" or "application/font-woff" => "woff",
            "font/woff2" or "application/font-woff2" => "woff2",
            // 文本/文档
            "text/plain" => "txt",
            "text/markdown" => "md",
            "text/html" => "html",
            "text/csv" => "csv",
            "application/json" => "json",
            "application/pdf" => "pdf",
            "application/xml" or "text/xml" => "xml",
            // 音频 — 修复 2026-05-08：以前 audio/* 全部 fallback 到 .png，导致 CDN 按图片
            // 处理跨域 decode 失败、wavesurfer 无法工作。
            "audio/mpeg" or "audio/mp3" => "mp3",
            "audio/mp4" or "audio/m4a" or "audio/x-m4a" => "m4a",
            "audio/wav" or "audio/wave" or "audio/x-wav" => "wav",
            "audio/aac" => "aac",
            "audio/ogg" or "audio/vorbis" => "ogg",
            "audio/flac" or "audio/x-flac" => "flac",
            "audio/webm" => "weba",
            // 视频
            "video/mp4" => "mp4",
            "video/webm" => "webm",
            "video/quicktime" => "mov",
            "video/x-matroska" => "mkv",
            "video/x-msvideo" => "avi",
            // 兜底：.bin（不再用 .png，否则知识库存音视频/zip/docx 会被 CDN 按图片处理）
            _ => "bin"
        };
    }

    private static string ExtToMime(string ext)
    {
        return ext.ToLowerInvariant() switch
        {
            "jpg" or "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "txt" => "text/plain; charset=utf-8",
            "md" => "text/markdown; charset=utf-8",
            "html" => "text/html; charset=utf-8",
            "csv" => "text/csv; charset=utf-8",
            "json" => "application/json; charset=utf-8",
            "pdf" => "application/pdf",
            "xml" => "application/xml; charset=utf-8",
            // 音频
            "mp3" => "audio/mpeg",
            "m4a" => "audio/mp4",
            "wav" => "audio/wav",
            "aac" => "audio/aac",
            "ogg" => "audio/ogg",
            "flac" => "audio/flac",
            "weba" => "audio/webm",
            // 视频
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "mkv" => "video/x-matroska",
            "avi" => "video/x-msvideo",
            "bin" => "application/octet-stream",
            _ => "application/octet-stream"
        };
    }
}

