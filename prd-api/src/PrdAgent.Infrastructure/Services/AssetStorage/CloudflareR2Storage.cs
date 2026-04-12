using System.Security.Cryptography;
using Amazon;
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Logging;

namespace PrdAgent.Infrastructure.Services.AssetStorage;

/// <summary>
/// Cloudflare R2 资产存储（S3 兼容 API）。
/// 复用 TencentCosStorage 的 key 组织体系（domain/type/sha.ext）。
/// </summary>
public sealed class CloudflareR2Storage : IAssetStorage, IDisposable
{
    private readonly string _bucket;
    private readonly string _publicBaseUrl;
    private readonly string _prefix;
    private readonly ILogger<CloudflareR2Storage> _logger;
    private readonly bool _enableSafeDelete;
    private readonly string[] _safeDeleteAllowPrefixes;

    private readonly AmazonS3Client _s3;
    private bool _disposed;

    public CloudflareR2Storage(
        string accountId,
        string accessKeyId,
        string secretAccessKey,
        string bucket,
        string? publicBaseUrl,
        string? prefix,
        string? endpoint,
        bool enableSafeDelete,
        IEnumerable<string>? safeDeleteAllowPrefixes,
        ILogger<CloudflareR2Storage> logger)
    {
        var aid = (accountId ?? string.Empty).Trim();
        var akid = (accessKeyId ?? string.Empty).Trim();
        var sk = (secretAccessKey ?? string.Empty).Trim();
        _bucket = (bucket ?? string.Empty).Trim();
        _logger = logger;

        if (string.IsNullOrWhiteSpace(aid)) throw new ArgumentException("R2:AccountId 不能为空", nameof(accountId));
        if (string.IsNullOrWhiteSpace(akid)) throw new ArgumentException("R2:AccessKeyId 不能为空", nameof(accessKeyId));
        if (string.IsNullOrWhiteSpace(sk)) throw new ArgumentException("R2:SecretAccessKey 不能为空", nameof(secretAccessKey));
        if (string.IsNullOrWhiteSpace(_bucket)) throw new ArgumentException("R2:Bucket 不能为空", nameof(bucket));

        _prefix = NormalizePrefix(prefix);

        // publicBaseUrl 必须配置（R2 无默认公开域名）
        var rawUrl = (publicBaseUrl ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(rawUrl))
        {
            // 降级为 r2.dev 子域名（需要在 Cloudflare 控制台开启）
            _publicBaseUrl = $"https://{_bucket}.{aid}.r2.dev";
            _logger.LogWarning("R2_PUBLIC_BASE_URL 未设置，降级为 r2.dev 子域名：{Url}（需在 Cloudflare 控制台开启公开访问）", _publicBaseUrl);
        }
        else
        {
            if (!rawUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                !rawUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                rawUrl = "https://" + rawUrl;
            _publicBaseUrl = rawUrl.TrimEnd('/');
        }

        _enableSafeDelete = enableSafeDelete;
        _safeDeleteAllowPrefixes = NormalizeSafeDeleteAllowPrefixes(safeDeleteAllowPrefixes, _prefix);

        // R2 S3 兼容 endpoint: https://{accountId}.r2.cloudflarestorage.com
        var ep = (endpoint ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(ep))
            ep = $"https://{aid}.r2.cloudflarestorage.com";

        var config = new AmazonS3Config
        {
            ServiceURL = ep,
            ForcePathStyle = true, // R2 要求 path-style
            RequestTimeout = TimeSpan.FromSeconds(120),
        };

        _s3 = new AmazonS3Client(akid, sk, config);
    }

    public void Dispose()
    {
        _disposed = true;
        _s3.Dispose();
    }

    public async Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null)
    {
        ThrowIfDisposed();
        if (bytes == null || bytes.Length == 0) throw new ArgumentException("bytes empty");

        var safeMime = string.IsNullOrWhiteSpace(mime) ? "image/png" : mime.Trim();
        var ext = MimeToExt(safeMime);
        var sha = Sha256Hex(bytes);
        var d = string.IsNullOrWhiteSpace(domain) ? AppDomainPaths.DomainVisualAgent : AppDomainPaths.NormDomain(domain);
        var t = string.IsNullOrWhiteSpace(type) ? AppDomainPaths.TypeImg : AppDomainPaths.NormType(type);
        var key = BuildObjectKey(d, t, sha, ext);

        // 去重
        if (!await ExistsAsync(key, ct).ConfigureAwait(false))
        {
            await UploadBytesInternalAsync(key, bytes, safeMime, ct).ConfigureAwait(false);
        }

        var url = BuildPublicUrl(key);
        return new StoredAsset(sha, url, bytes.LongLength, safeMime);
    }

    public async Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
    {
        ThrowIfDisposed();
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha) || sha.Length < 16) return null;

        var d = string.IsNullOrWhiteSpace(domain) ? null : AppDomainPaths.NormDomain(domain);
        var t = string.IsNullOrWhiteSpace(type) ? null : AppDomainPaths.NormType(type);

        var exts = new[] { "png", "jpg", "jpeg", "webp", "gif", "ttf", "otf", "woff", "woff2", "txt" };
        foreach (var ext in exts)
        {
            if (!string.IsNullOrWhiteSpace(d) && !string.IsNullOrWhiteSpace(t))
            {
                var key = BuildObjectKey(d!, t!, sha, ext);
                var bytes = await TryDownloadBytesAsync(key, ct).ConfigureAwait(false);
                if (bytes != null && bytes.Length > 0) return (bytes, ExtToMime(ext));
            }
        }
        return null;
    }

    public async Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
    {
        ThrowIfDisposed();
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha) || sha.Length < 16) return;

        var d = string.IsNullOrWhiteSpace(domain) ? null : AppDomainPaths.NormDomain(domain);
        var t = string.IsNullOrWhiteSpace(type) ? null : AppDomainPaths.NormType(type);

        var exts = new[] { "png", "jpg", "jpeg", "webp", "gif", "ttf", "otf", "woff", "woff2", "txt" };
        foreach (var ext in exts)
        {
            try
            {
                if (!string.IsNullOrWhiteSpace(d) && !string.IsNullOrWhiteSpace(t))
                {
                    var key = BuildObjectKey(d!, t!, sha, ext);
                    await DeleteByKeyAsync(key, ct).ConfigureAwait(false);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "R2 deleteBySha failed. sha={Sha}", sha);
            }
        }
    }

    public string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null)
    {
        if (_disposed) return null;
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha) || sha.Length < 16) return null;

        var d = string.IsNullOrWhiteSpace(domain) ? AppDomainPaths.DomainVisualAgent : AppDomainPaths.NormDomain(domain);
        var t = string.IsNullOrWhiteSpace(type) ? AppDomainPaths.TypeImg : AppDomainPaths.NormType(type);
        var ext = MimeToExt(mime);
        var key = BuildObjectKey(d, t, sha, ext);
        return BuildPublicUrl(key);
    }

    public async Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct)
    {
        ThrowIfDisposed();
        var k = NormalizeKey(key);
        try
        {
            var resp = await _s3.GetObjectAsync(_bucket, k, ct).ConfigureAwait(false);
            await using var stream = resp.ResponseStream;
            using var ms = new MemoryStream();
            await stream.CopyToAsync(ms, ct).ConfigureAwait(false);
            return ms.ToArray();
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }
    }

    public async Task<bool> ExistsAsync(string key, CancellationToken ct)
    {
        ThrowIfDisposed();
        var k = NormalizeKey(key);
        try
        {
            await _s3.GetObjectMetadataAsync(_bucket, k, ct).ConfigureAwait(false);
            return true;
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return false;
        }
    }

    public async Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct)
    {
        ThrowIfDisposed();
        await UploadBytesInternalAsync(NormalizeKey(key), bytes, contentType, ct).ConfigureAwait(false);
    }

    public string BuildUrlForKey(string key)
    {
        return BuildPublicUrl(NormalizeKey(key));
    }

    public async Task DeleteByKeyAsync(string key, CancellationToken ct)
    {
        ThrowIfDisposed();
        var k = NormalizeKey(key);

        if (!IsSafeDeleteAllowed(k, out var reason))
        {
            _logger.LogWarning("R2 delete blocked. bucket={Bucket} key={Key} reason={Reason}", _bucket, k, reason);
            throw new InvalidOperationException("R2 删除被安全策略拦截：仅允许删除 _it 测试目录下对象，或启用受控删除并命中白名单前缀");
        }

        try
        {
            await _s3.DeleteObjectAsync(_bucket, k, ct).ConfigureAwait(false);
        }
        catch (AmazonS3Exception ex) when (ex.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            // ignore
        }
    }

    public string BuildSiteKey(string siteId, string filePath)
    {
        var sid = (siteId ?? string.Empty).Trim();
        var fp = (filePath ?? string.Empty).Trim().TrimStart('/');
        if (string.IsNullOrWhiteSpace(sid)) throw new ArgumentException("siteId empty", nameof(siteId));
        if (string.IsNullOrWhiteSpace(fp)) throw new ArgumentException("filePath empty", nameof(filePath));
        var rel = $"web-hosting/sites/{sid}/{fp}";
        if (string.IsNullOrWhiteSpace(_prefix)) return rel;
        return $"{_prefix}/{rel}";
    }

    // ========================== Private ==========================

    private async Task UploadBytesInternalAsync(string key, byte[] bytes, string? contentType, CancellationToken ct)
    {
        if (bytes == null || bytes.Length == 0) throw new ArgumentException("bytes empty", nameof(bytes));
        var putReq = new PutObjectRequest
        {
            BucketName = _bucket,
            Key = key,
            InputStream = new MemoryStream(bytes, writable: false),
            ContentType = (contentType ?? string.Empty).Trim(),
            DisablePayloadSigning = true, // R2 推荐
        };
        await _s3.PutObjectAsync(putReq, ct).ConfigureAwait(false);
    }

    private string BuildPublicUrl(string key)
    {
        var parts = key.Split('/', StringSplitOptions.RemoveEmptyEntries);
        for (var i = 0; i < parts.Length; i++)
            parts[i] = Uri.EscapeDataString(parts[i]);
        return $"{_publicBaseUrl}/{string.Join('/', parts)}";
    }

    private string BuildObjectKey(string domain, string type, string sha, string ext)
    {
        var d = AppDomainPaths.NormDomain(domain);
        var t = AppDomainPaths.NormType(type);
        var s = (sha ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(s)) throw new ArgumentException("sha empty", nameof(sha));
        var e = (ext ?? string.Empty).Trim().TrimStart('.').ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(e)) e = "png";

        var sid = Sha256HexToBase32Lower128(s);
        var rel = $"{d}/{t}/{sid}.{e}";
        if (string.IsNullOrWhiteSpace(_prefix)) return rel;
        return $"{_prefix}/{rel}";
    }

    private static string NormalizeKey(string key)
    {
        var k = (key ?? string.Empty).Trim().TrimStart('/');
        if (string.IsNullOrWhiteSpace(k)) throw new ArgumentException("key empty", nameof(key));
        return k;
    }

    private static string NormalizePrefix(string? prefix)
    {
        var p = (prefix ?? string.Empty).Trim().Trim('/');
        if (p.EndsWith("/assets", StringComparison.OrdinalIgnoreCase))
            p = p[..^"/assets".Length].TrimEnd('/');
        if (string.Equals(p, "assets", StringComparison.OrdinalIgnoreCase))
            p = string.Empty;
        return p.ToLowerInvariant();
    }

    private static string Sha256Hex(byte[] bytes)
    {
        using var sha = SHA256.Create();
        var h = sha.ComputeHash(bytes);
        return Convert.ToHexString(h).ToLowerInvariant();
    }

    private static string Sha256HexToBase32Lower128(string shaHex)
    {
        var s = (shaHex ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(s)) throw new ArgumentException("sha empty", nameof(shaHex));
        var bytes = Convert.FromHexString(s);
        if (bytes.Length != 32) throw new ArgumentException("sha256 hex must be 32 bytes", nameof(shaHex));
        return Base32LowerNoPadding(bytes.AsSpan(0, 16));
    }

    private static string Base32LowerNoPadding(ReadOnlySpan<byte> data)
    {
        const string alphabet = "abcdefghijklmnopqrstuvwxyz234567";
        if (data.IsEmpty) return string.Empty;
        var outputLen = (data.Length * 8 + 4) / 5;
        var sb = new System.Text.StringBuilder(outputLen);
        var buffer = 0;
        var bitsLeft = 0;
        for (var i = 0; i < data.Length; i++)
        {
            buffer = (buffer << 8) | data[i];
            bitsLeft += 8;
            while (bitsLeft >= 5)
            {
                var idx = (buffer >> (bitsLeft - 5)) & 31;
                bitsLeft -= 5;
                sb.Append(alphabet[idx]);
            }
        }
        if (bitsLeft > 0)
        {
            var idx = (buffer << (5 - bitsLeft)) & 31;
            sb.Append(alphabet[idx]);
        }
        return sb.ToString();
    }

    private static string MimeToExt(string mime)
    {
        var m = (mime ?? string.Empty).Trim().ToLowerInvariant();
        var semi = m.IndexOf(';');
        if (semi > 0) m = m[..semi].Trim();
        return m switch
        {
            "image/jpeg" or "image/jpg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
            "image/svg+xml" => "svg",
            "font/ttf" or "application/x-font-ttf" or "application/font-sfnt" => "ttf",
            "font/otf" or "application/x-font-opentype" => "otf",
            "font/woff" or "application/font-woff" => "woff",
            "font/woff2" or "application/font-woff2" => "woff2",
            "text/plain" => "txt",
            "text/markdown" => "md",
            "text/html" => "html",
            "text/csv" => "csv",
            "application/json" => "json",
            "application/pdf" => "pdf",
            "application/xml" or "text/xml" => "xml",
            _ => "png"
        };
    }

    private static string ExtToMime(string ext)
    {
        return (ext ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "jpg" or "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "svg" => "image/svg+xml",
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            "woff" => "font/woff",
            "woff2" => "font/woff2",
            "txt" => "text/plain; charset=utf-8",
            "md" => "text/markdown; charset=utf-8",
            "html" or "htm" => "text/html; charset=utf-8",
            "csv" => "text/csv; charset=utf-8",
            "json" => "application/json; charset=utf-8",
            "pdf" => "application/pdf",
            "xml" => "application/xml; charset=utf-8",
            _ => "image/png"
        };
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(CloudflareR2Storage));
    }

    // ========================== 安全删除（与 TencentCosStorage 同等策略） ==========================

    private bool IsSafeDeleteAllowed(string normalizedKey, out string reason)
    {
        if (IsItTestKey(normalizedKey)) { reason = "_it"; return true; }
        if (!_enableSafeDelete) { reason = "disabled"; return false; }
        if (_safeDeleteAllowPrefixes.Length == 0) { reason = "empty_allowlist"; return false; }

        var rel = StripConfiguredPrefix(normalizedKey, _prefix);
        foreach (var p in _safeDeleteAllowPrefixes)
        {
            if (rel.StartsWith(p + "/", StringComparison.Ordinal)) { reason = "whitelist"; return true; }
        }
        reason = "not_whitelisted";
        return false;
    }

    private static bool IsItTestKey(string key)
    {
        var k = (key ?? string.Empty).Trim().Replace('\\', '/');
        return k.StartsWith("_it/", StringComparison.OrdinalIgnoreCase) ||
               k.Contains("/_it/", StringComparison.OrdinalIgnoreCase);
    }

    private static string StripConfiguredPrefix(string key, string prefix)
    {
        var k = (key ?? string.Empty).Trim().Replace('\\', '/').TrimStart('/');
        var p = (prefix ?? string.Empty).Trim().Replace('\\', '/').Trim('/');
        if (string.IsNullOrWhiteSpace(p)) return k;
        var pre = p + "/";
        if (k.StartsWith(pre, StringComparison.OrdinalIgnoreCase)) return k[pre.Length..];
        return k;
    }

    private static string[] NormalizeSafeDeleteAllowPrefixes(IEnumerable<string>? allowPrefixes, string prefix)
    {
        if (allowPrefixes == null) return Array.Empty<string>();
        var list = new List<string>();
        foreach (var raw in allowPrefixes)
        {
            var s = (raw ?? string.Empty).Trim().Replace('\\', '/').Trim().Trim('/');
            if (string.IsNullOrWhiteSpace(s)) continue;
            s = StripConfiguredPrefix(s, prefix).Trim().Trim('/');
            if (string.IsNullOrWhiteSpace(s)) continue;
            var parts = s.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 2) continue;
            try
            {
                var d = AppDomainPaths.NormDomain(parts[0]);
                var t = AppDomainPaths.NormType(parts[1]);
                list.Add($"{d}/{t}");
            }
            catch { /* ignore invalid */ }
        }
        return list.Distinct(StringComparer.Ordinal).OrderBy(x => x, StringComparer.Ordinal).ToArray();
    }
}
