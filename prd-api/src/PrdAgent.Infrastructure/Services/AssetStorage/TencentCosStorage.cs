using System.Security.Cryptography;
using System.Net.Http;
using COSXML;
using COSXML.Auth;
using COSXML.CosException;
using COSXML.Model.Object;
using Microsoft.Extensions.Logging;

namespace PrdAgent.Infrastructure.Services.AssetStorage;

/// <summary>
/// 腾讯云 COS 资产存储（生命周期集中管理：初始化/上传/下载/删除/存在性检查/URL 构建）。
/// </summary>
public sealed class TencentCosStorage : IAssetStorage, IDisposable
{
    private readonly string _bucket;
    private readonly string _region;
    private readonly string _publicBaseUrl;
    private readonly string _prefix;
    private readonly string _tempDir;
    private readonly ILogger<TencentCosStorage> _logger;

    private readonly CosXmlServer _cos;
    private bool _disposed;

    public TencentCosStorage(
        string bucket,
        string region,
        string secretId,
        string secretKey,
        string? publicBaseUrl,
        string? prefix,
        string? tempDir,
        ILogger<TencentCosStorage> logger)
    {
        _bucket = (bucket ?? string.Empty).Trim();
        _region = (region ?? string.Empty).Trim();
        var sid = (secretId ?? string.Empty).Trim();
        var sk = (secretKey ?? string.Empty).Trim();
        _logger = logger;

        if (string.IsNullOrWhiteSpace(_bucket)) throw new ArgumentException("TencentCos:Bucket 不能为空", nameof(bucket));
        if (string.IsNullOrWhiteSpace(_region)) throw new ArgumentException("TencentCos:Region 不能为空", nameof(region));
        if (string.IsNullOrWhiteSpace(sid)) throw new ArgumentException("TencentCos:SecretId 不能为空", nameof(secretId));
        if (string.IsNullOrWhiteSpace(sk)) throw new ArgumentException("TencentCos:SecretKey 不能为空", nameof(secretKey));

        _prefix = NormalizePrefix(prefix);
        _publicBaseUrl = NormalizePublicBaseUrl(publicBaseUrl, _bucket, _region);
        _tempDir = NormalizeTempDir(tempDir);
        Directory.CreateDirectory(_tempDir);

        var config = new CosXmlConfig.Builder()
            .IsHttps(true)
            .SetRegion(_region)
            .Build();

        // 这里使用长期密钥（非 STS 临时密钥）；durationSecond 对签名有效期参数意义不大，给一个合理值即可。
        var credentialProvider = new DefaultQCloudCredentialProvider(sid, sk, 600);
        _cos = new CosXmlServer(config, credentialProvider);
    }

    public void Dispose()
    {
        _disposed = true;
        // CosXmlServer 当前版本未提供显式 Dispose；标记即可，避免后续使用。
    }

    /// <summary>
    /// 上传 bytes 到指定 key（可选设置 Content-Type）。
    /// </summary>
    public async Task UploadBytesAsync(string key, byte[] bytes, string? contentType, CancellationToken ct)
    {
        ThrowIfDisposed();
        var k = NormalizeKey(key);
        if (bytes == null || bytes.Length == 0) throw new ArgumentException("bytes empty", nameof(bytes));

        await using var ms = new MemoryStream(bytes, writable: false);
        var req = new PutObjectRequest(_bucket, k, ms);
        ct.ThrowIfCancellationRequested();
        await Task.Run(() => _cos.PutObject(req), ct).ConfigureAwait(false);
    }

    /// <summary>
    /// 下载指定 key 的 bytes（不存在返回 null）。\n    /// </summary>
    public async Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct)
    {
        ThrowIfDisposed();
        var k = NormalizeKey(key);
        try
        {
            // 使用 SDK 的 GetObjectBytes* API：直接拿到 bytes，避免 GetObjectRequest 的落盘行为差异
            var req = new GetObjectBytesRequest(_bucket, k);
            ct.ThrowIfCancellationRequested();
            var result = await Task.Run(() => _cos.GetObject(req), ct).ConfigureAwait(false);
            var bytes = TryGetBytesFromResult(result);
            if (bytes != null && bytes.Length > 0) return bytes;

            // Fallback：使用 SDK 内的 GetObjectUrl 生成（可能带签名的）URL，再用标准 HTTPS GET 取回 bytes
            // - 原因：该版本 SDK 的 GetObject/GetObjectBytesResult 在某些环境下无法把内容落盘/回填到 result.content
            // - 仍然复用 SDK 的签名逻辑，避免自己实现 COS 签名算法
            var url = TryBuildObjectUrl(k);
            if (!string.IsNullOrWhiteSpace(url))
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
                using var resp = await http.GetAsync(url, ct).ConfigureAwait(false);
                if (resp.IsSuccessStatusCode)
                {
                    var body = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
                    if (body.Length > 0) return body;
                }
            }

            // Fallback：尝试从 request 内部字段拿到签名后的 URL（某些版本只写入私有字段 requestUrlWithSign）
            var signedUrl = (TryGetStringMember(req, "RequestURLWithSign") ?? TryGetStringMember(req, "requestUrlWithSign") ?? string.Empty).Trim();
            if (!string.IsNullOrWhiteSpace(signedUrl) &&
                (signedUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
                 signedUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase)))
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(60) };
                using var resp = await http.GetAsync(signedUrl, ct).ConfigureAwait(false);
                if (resp.IsSuccessStatusCode)
                {
                    var body = await resp.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
                    if (body.Length > 0) return body;
                }
            }

            // Fallback：尝试用 GetObjectRequest(bucket,key) 拿响应流（某些版本 bytes 结果不返回 content）
            var streamBytes = await TryDownloadByGetObjectStreamAsync(k, ct).ConfigureAwait(false);
            if (streamBytes != null && streamBytes.Length > 0) return streamBytes;

            var rdesc = DescribeObjectForDebug(result);
            var qdesc = DescribeObjectForDebug(req);
            throw new InvalidOperationException($"COS download returned empty. bucket={_bucket} key={k} request={qdesc} result={rdesc}");
        }
        catch (CosServerException ex) when (LooksLikeNotFound(ex))
        {
            return null;
        }
        catch (CosClientException ex)
        {
            _logger.LogWarning(ex, "COS download client error: bucket={Bucket} key={Key}", _bucket, k);
            throw;
        }
        catch (CosServerException ex)
        {
            _logger.LogWarning(ex, "COS download server error: bucket={Bucket} key={Key}", _bucket, k);
            throw;
        }
    }

    private string? TryBuildObjectUrl(string key)
    {
        try
        {
            var t = _cos.GetType();
            var methods = t.GetMethods()
                .Where(m => string.Equals(m.Name, "GetObjectUrl", StringComparison.Ordinal))
                .ToArray();

            foreach (var m in methods)
            {
                var ps = m.GetParameters();
                var args = new object?[ps.Length];
                var stringCount = 0;
                var ok = true;
                for (var i = 0; i < ps.Length; i++)
                {
                    var pt = ps[i].ParameterType;
                    if (pt == typeof(string))
                    {
                        args[i] = stringCount == 0 ? _bucket : key;
                        stringCount++;
                    }
                    else if (pt == typeof(int))
                    {
                        args[i] = 600;
                    }
                    else if (pt == typeof(long))
                    {
                        args[i] = 600L;
                    }
                    else if (pt == typeof(bool))
                    {
                        args[i] = true;
                    }
                    else if (pt == typeof(DateTime))
                    {
                        args[i] = DateTime.UtcNow.AddMinutes(10);
                    }
                    else if (pt == typeof(TimeSpan))
                    {
                        args[i] = TimeSpan.FromMinutes(10);
                    }
                    else if (pt.IsEnum)
                    {
                        args[i] = Activator.CreateInstance(pt);
                    }
                    else
                    {
                        ok = false;
                        break;
                    }
                }
                if (!ok || stringCount < 2) continue;

                var v = m.Invoke(_cos, args);
                var url = v switch
                {
                    string s => s,
                    Uri u => u.ToString(),
                    _ => null
                };
                url = (url ?? string.Empty).Trim();
                if (!string.IsNullOrWhiteSpace(url)) return url;
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    private async Task<byte[]?> TryDownloadByGetObjectStreamAsync(string key, CancellationToken ct)
    {
        try
        {
            var ctor = typeof(GetObjectRequest).GetConstructor(new[] { typeof(string), typeof(string) });
            if (ctor == null) return null;

            var req = (GetObjectRequest)ctor.Invoke(new object[] { _bucket, key });
            ct.ThrowIfCancellationRequested();
            var result = await Task.Run(() => _cos.GetObject(req), ct).ConfigureAwait(false);
            var stream = TryGetStreamFromResult(result);
            if (stream == null) return null;

            await using (stream.ConfigureAwait(false))
            {
                using var ms = new MemoryStream(capacity: 1024 * 1024);
                await stream.CopyToAsync(ms, ct).ConfigureAwait(false);
                return ms.ToArray();
            }
        }
        catch (CosServerException ex) when (LooksLikeNotFound(ex))
        {
            return null;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// 删除对象（不存在也视为成功）。\n    /// </summary>
    public async Task DeleteAsync(string key, CancellationToken ct)
    {
        ThrowIfDisposed();
        var k = NormalizeKey(key);
        try
        {
            var req = new DeleteObjectRequest(_bucket, k);
            ct.ThrowIfCancellationRequested();
            await Task.Run(() => _cos.DeleteObject(req), ct).ConfigureAwait(false);
        }
        catch (CosServerException ex) when (LooksLikeNotFound(ex))
        {
            // ignore
        }
    }

    /// <summary>
    /// 判断对象是否存在。\n    /// </summary>
    public async Task<bool> ExistsAsync(string key, CancellationToken ct)
    {
        ThrowIfDisposed();
        var k = NormalizeKey(key);
        try
        {
            var req = new HeadObjectRequest(_bucket, k);
            ct.ThrowIfCancellationRequested();
            var result = await Task.Run(() => _cos.HeadObject(req), ct).ConfigureAwait(false);

            // SDK 某些版本对 404/403 不一定抛异常，而是通过 result.httpCode 表达。
            // 这里以 2xx 为“存在”，其余一律视为“不存在/不可用”，避免误判导致跳过上传（最终 URL 404）。
            var httpCode =
                TryGetIntMember(result, "httpCode") ??
                TryGetIntMember(result, "HttpCode") ??
                TryGetIntMember(result, "statusCode") ??
                TryGetIntMember(result, "StatusCode");

            if (httpCode is >= 200 and < 300) return true;
            return false;
        }
        catch (CosServerException ex) when (LooksLikeNotFound(ex))
        {
            return false;
        }
    }

    /// <summary>
    /// 构建对外可访问的稳定 URL（不带签名）。\n    /// </summary>
    public string BuildPublicUrl(string key)
    {
        ThrowIfDisposed();
        var k = NormalizeKey(key);
        return $"{_publicBaseUrl}/{EscapeKeyPath(k)}";
    }

    public async Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct)
    {
        ThrowIfDisposed();
        if (bytes == null || bytes.Length == 0) throw new ArgumentException("bytes empty");

        var safeMime = string.IsNullOrWhiteSpace(mime) ? "image/png" : mime.Trim();
        var ext = MimeToExt(safeMime);
        var sha = Sha256Hex(bytes);
        var key = BuildObjectKey(sha, ext);

        // 去重：存在则不重复上传（即使重复上传也不会影响正确性，但浪费带宽）
        if (!await ExistsAsync(key, ct).ConfigureAwait(false))
        {
            await UploadBytesAsync(key, bytes, safeMime, ct).ConfigureAwait(false);
        }

        var url = BuildPublicUrl(key);
        return new StoredAsset(sha, url, bytes.LongLength, safeMime);
    }

    public async Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct)
    {
        ThrowIfDisposed();
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha)) return null;
        if (sha.Length < 16) return null;

        // 支持常见图片扩展
        var exts = new[] { "png", "jpg", "jpeg", "webp", "gif" };
        foreach (var ext in exts)
        {
            var key = BuildObjectKey(sha, ext);
            var bytes = await TryDownloadBytesAsync(key, ct).ConfigureAwait(false);
            if (bytes == null || bytes.Length == 0) continue;
            return (bytes, ExtToMime(ext));
        }
        return null;
    }

    public async Task DeleteByShaAsync(string sha256, CancellationToken ct)
    {
        ThrowIfDisposed();
        var sha = (sha256 ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(sha)) return;
        if (sha.Length < 16) return;

        // 由于 ext 可能未知，这里按常见图片扩展逐个尝试删除（不存在视为成功）
        var exts = new[] { "png", "jpg", "jpeg", "webp", "gif" };
        foreach (var ext in exts)
        {
            var key = BuildObjectKey(sha, ext);
            await DeleteAsync(key, ct).ConfigureAwait(false);
        }
    }

    private static bool LooksLikeNotFound(CosServerException ex)
    {
        // SDK 版本差异较大：避免引用不确定的 statusCode 属性名，退化为字符串判断，确保可编译/可运行。
        var msg = ex?.Message ?? string.Empty;
        if (msg.Contains("404", StringComparison.OrdinalIgnoreCase)) return true;
        if (msg.Contains("NoSuchKey", StringComparison.OrdinalIgnoreCase)) return true;
        if (msg.Contains("NotFound", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static string NormalizePrefix(string? prefix)
    {
        var p = (prefix ?? "data/assets").Trim();
        p = p.Trim('/');
        return p;
    }

    private static string NormalizePublicBaseUrl(string? publicBaseUrl, string bucket, string region)
    {
        var raw = (publicBaseUrl ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(raw))
        {
            // 默认 COS 访问域名：bucket.cos.region.myqcloud.com
            return $"https://{bucket}.cos.{region}.myqcloud.com";
        }

        if (!raw.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
            !raw.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
        {
            raw = "https://" + raw;
        }
        return raw.TrimEnd('/');
    }

    private static string NormalizeTempDir(string? tempDir)
    {
        var raw = (tempDir ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(raw)) return raw;

        // 默认使用 app/data/tmp（与 docker-compose 的 ./data:/app/data 映射保持一致）
        return Path.Combine(AppContext.BaseDirectory, "data", "tmp");
    }

    private string BuildObjectKey(string sha, string ext)
    {
        var s = (sha ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(s)) throw new ArgumentException("sha empty", nameof(sha));
        var e = (ext ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(e)) e = "png";

        if (string.IsNullOrWhiteSpace(_prefix)) return $"{s}.{e}";
        return $"{_prefix}/{s}.{e}";
    }

    private static string NormalizeKey(string key)
    {
        var k = (key ?? string.Empty).Trim();
        k = k.TrimStart('/'); // COS object key 不需要以 / 开头
        if (string.IsNullOrWhiteSpace(k)) throw new ArgumentException("key empty", nameof(key));
        return k;
    }

    private static string EscapeKeyPath(string key)
    {
        // key 允许包含 /，需要按 path segment 编码
        var parts = key.Split('/', StringSplitOptions.RemoveEmptyEntries);
        for (var i = 0; i < parts.Length; i++)
        {
            parts[i] = Uri.EscapeDataString(parts[i]);
        }
        return string.Join('/', parts);
    }

    private static string Sha256Hex(byte[] bytes)
    {
        using var sha = SHA256.Create();
        var h = sha.ComputeHash(bytes);
        return Convert.ToHexString(h).ToLowerInvariant();
    }

    private static string MimeToExt(string mime)
    {
        return (mime ?? string.Empty).Trim().ToLowerInvariant() switch
        {
            "image/jpeg" or "image/jpg" => "jpg",
            "image/webp" => "webp",
            "image/gif" => "gif",
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
            _ => "image/png"
        };
    }

    private void ThrowIfDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(TencentCosStorage));
    }

    private static void TryDeleteFile(string filePath)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(filePath) && File.Exists(filePath))
            {
                File.Delete(filePath);
            }
        }
        catch
        {
            // ignore
        }
    }

    private static void TryDeleteDirectory(string dirPath)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(dirPath) && Directory.Exists(dirPath))
            {
                Directory.Delete(dirPath, recursive: true);
            }
        }
        catch
        {
            // ignore
        }
    }

    private static byte[]? TryGetBytesFromResult(object? result)
    {
        if (result == null) return null;
        try
        {
            var t = result.GetType();

            foreach (var p in t.GetProperties())
            {
                if (p.PropertyType != typeof(byte[])) continue;
                if (p.GetValue(result) is byte[] b && b.Length > 0) return b;
            }
            foreach (var f in t.GetFields(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic))
            {
                if (f.FieldType != typeof(byte[])) continue;
                if (f.GetValue(result) is byte[] b && b.Length > 0) return b;
            }

            // 常见：无参方法直接返回 byte[]
            foreach (var m in t.GetMethods(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic))
            {
                if (m.GetParameters().Length != 0) continue;
                if (m.ReturnType != typeof(byte[])) continue;
                var v = m.Invoke(result, Array.Empty<object>());
                if (v is byte[] b && b.Length > 0) return b;
            }

            // 兼容：List<byte> / IEnumerable<byte>
            foreach (var p in t.GetProperties())
            {
                if (!typeof(System.Collections.IEnumerable).IsAssignableFrom(p.PropertyType)) continue;
                if (p.PropertyType == typeof(string)) continue;
                var v = p.GetValue(result);
                if (v is IEnumerable<byte> eb)
                {
                    var arr = eb as byte[] ?? eb.ToArray();
                    if (arr.Length > 0) return arr;
                }
            }

            var s = TryGetStreamFromResult(result);
            if (s != null)
            {
                using var ms = new MemoryStream(capacity: 1024 * 1024);
                s.CopyTo(ms);
                return ms.ToArray();
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    private static string DescribeObjectForDebug(object? obj)
    {
        if (obj == null) return "<null>";
        try
        {
            var t = obj.GetType();
            string extra = string.Empty;
            try
            {
                var pUrl = t.GetProperty("RequestURLWithSign");
                if (pUrl != null && pUrl.PropertyType == typeof(string))
                {
                    var url = (pUrl.GetValue(obj) as string) ?? string.Empty;
                    url = url.Trim();
                    if (!string.IsNullOrWhiteSpace(url))
                    {
                        var head = url.Length <= 80 ? url : url[..80] + "...";
                        extra = $" urlHead={head}";
                    }
                    else
                    {
                        extra = " urlHead=<empty>";
                    }
                }
            }
            catch
            {
                // ignore
            }
            var props = t.GetProperties()
                .Select(p => $"{p.Name}:{p.PropertyType.Name}")
                .Take(20);
            var fields = t.GetFields(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)
                .Select(f => $"{f.Name}:{f.FieldType.Name}")
                .Take(20);
            return $"{t.FullName}{extra} props=[{string.Join(",", props)}] fields=[{string.Join(",", fields)}]";
        }
        catch
        {
            return obj.GetType().FullName ?? obj.GetType().Name;
        }
    }

    private static string? TryGetStringMember(object instance, string name)
    {
        try
        {
            var t = instance.GetType();
            var p = t.GetProperty(name);
            if (p != null && p.PropertyType == typeof(string))
            {
                return p.GetValue(instance) as string;
            }

            var f = t.GetField(name, System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);
            if (f != null && f.FieldType == typeof(string))
            {
                return f.GetValue(instance) as string;
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    private static int? TryGetIntMember(object? instance, string name)
    {
        if (instance == null) return null;
        try
        {
            var t = instance.GetType();
            var p = t.GetProperty(name);
            if (p != null && (p.PropertyType == typeof(int) || p.PropertyType == typeof(int?)))
            {
                var v = p.GetValue(instance);
                return v is int i ? i : v as int?;
            }

            var f = t.GetField(name, System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);
            if (f != null && (f.FieldType == typeof(int) || f.FieldType == typeof(int?)))
            {
                var v = f.GetValue(instance);
                return v is int i ? i : v as int?;
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }

    private static Stream? TryGetStreamFromResult(object? result)
    {
        if (result == null) return null;
        try
        {
            var t = result.GetType();

            // 常见：提供 GetResponseStream() 方法
            var mi = t.GetMethod("GetResponseStream", Type.EmptyTypes);
            if (mi != null && typeof(Stream).IsAssignableFrom(mi.ReturnType))
            {
                var v = mi.Invoke(result, Array.Empty<object>());
                if (v is Stream s1) return s1;
            }

            var props = t.GetProperties();
            foreach (var p in props)
            {
                if (!typeof(Stream).IsAssignableFrom(p.PropertyType)) continue;
                var v = p.GetValue(result);
                if (v is Stream s) return s;
            }
        }
        catch
        {
            // ignore
        }
        return null;
    }
}


