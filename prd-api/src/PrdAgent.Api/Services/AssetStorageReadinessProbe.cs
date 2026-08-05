using System.Diagnostics;
using System.Net;
using PrdAgent.Api.Json;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 对统一资产存储执行真实的写、读、公开访问和清理探针。
/// 该探针用于部署就绪判定，不能被进程存活检查替代。
/// </summary>
public sealed class AssetStorageReadinessProbe
{
    private const string ProbePrefix = "_it/asset-storage-readiness";
    internal const int RepresentativePayloadBytes = 640 * 1024;
    private static readonly TimeSpan DefaultCacheTtl = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan DefaultFailureCacheTtl = TimeSpan.FromSeconds(15);

    private readonly IAssetStorage _storage;
    private readonly IAssetStorageRuntimeInfo _runtimeInfo;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IConfiguration _configuration;
    private readonly ILogger<AssetStorageReadinessProbe> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private AssetStorageReadinessResponse? _cached;

    public AssetStorageReadinessProbe(
        IAssetStorage storage,
        IAssetStorageRuntimeInfo runtimeInfo,
        IHttpClientFactory httpClientFactory,
        IConfiguration configuration,
        ILogger<AssetStorageReadinessProbe> logger)
    {
        _storage = storage;
        _runtimeInfo = runtimeInfo;
        _httpClientFactory = httpClientFactory;
        _configuration = configuration;
        _logger = logger;
    }

    public async Task<AssetStorageReadinessResponse> CheckAsync(
        bool force = false,
        CancellationToken cancellationToken = default)
    {
        var successCacheTtl = TimeSpan.FromSeconds(Math.Clamp(
            _configuration.GetValue<int?>("AssetStorageReadiness:CacheSeconds")
                ?? (int)DefaultCacheTtl.TotalSeconds,
            15,
            900));
        var failureCacheTtl = TimeSpan.FromSeconds(Math.Clamp(
            _configuration.GetValue<int?>("AssetStorageReadiness:FailureCacheSeconds")
                ?? (int)DefaultFailureCacheTtl.TotalSeconds,
            1,
            60));
        var cached = _cached;
        if (!force && IsFresh(cached, successCacheTtl, failureCacheTtl))
        {
            return cached!;
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            cached = _cached;
            if (!force && IsFresh(cached, successCacheTtl, failureCacheTtl))
            {
                return cached!;
            }

            var result = await ExecuteAsync(cancellationToken);
            // 普通公开请求也短时缓存失败，避免存储故障时放大写读删压力。
            // 受保护的 force 探针始终绕过缓存，因此发布门禁和故障恢复不会被旧失败阻塞。
            _cached = result;
            return result;
        }
        finally
        {
            _gate.Release();
        }
    }

    private static bool IsFresh(
        AssetStorageReadinessResponse? cached,
        TimeSpan successCacheTtl,
        TimeSpan failureCacheTtl)
    {
        if (cached == null)
        {
            return false;
        }

        var ttl = string.Equals(cached.Status, "healthy", StringComparison.Ordinal)
            ? successCacheTtl
            : failureCacheTtl;
        return DateTime.UtcNow - cached.CheckedAt < ttl;
    }

    internal async Task<AssetStorageReadinessResponse> ExecuteAsync(
        CancellationToken cancellationToken)
    {
        var stopwatch = Stopwatch.StartNew();
        var provider = CanonicalProvider(_runtimeInfo.ProviderName);
        var expectedRaw = (_configuration["ASSETS_EXPECTED_PROVIDER"] ?? string.Empty).Trim();
        var expected = string.IsNullOrWhiteSpace(expectedRaw)
            ? null
            : CanonicalProvider(expectedRaw);

        if (expected != null &&
            !string.Equals(provider, expected, StringComparison.Ordinal))
        {
            return Failure(
                provider,
                expected,
                "provider_mismatch",
                $"对象存储提供商不符合环境合同：期望 {expected}，实际 {provider}",
                stopwatch);
        }

        // 必须覆盖真实录音的请求形态。历史上的几十字节文本探针会通过，
        // 但 646415 字节录音在同一 R2 PutObject 路径返回 SignatureDoesNotMatch。
        var key = $"{ProbePrefix}/{Guid.NewGuid():N}.m4a";
        var payload = CreateRepresentativeAudioPayload();
        var stage = "write";
        var uploaded = false;
        var writeVerified = false;
        var internalReadVerified = false;
        var publicReadVerified = false;
        var cleanupVerified = false;
        AssetStorageReadinessResponse? result = null;

        try
        {
            await _storage.UploadToKeyAsync(
                key,
                payload,
                // 与 iOS Safari MediaRecorder 的真实 MIME 完全一致。只测 audio/mp4
                // 曾让健康检查通过，但真实录音归档因带 codecs 参数而持续验签失败。
                "audio/mp4;codecs=mp4a.40.2",
                cancellationToken);
            uploaded = true;
            writeVerified = true;

            stage = "internal_read";
            var downloaded = await _storage.TryDownloadBytesAsync(key, cancellationToken);
            if (downloaded == null || !downloaded.AsSpan().SequenceEqual(payload))
            {
                throw new InvalidDataException("对象存储内部读取内容与写入内容不一致");
            }
            internalReadVerified = true;

            stage = "public_read";
            var publicUrl = _storage.BuildUrlForKey(key);
            var uri = ResolvePublicUri(provider, publicUrl);
            var publicBytes = await ReadPublicBytesWithRetryAsync(uri, cancellationToken);
            if (!publicBytes.AsSpan().SequenceEqual(payload))
            {
                throw new InvalidDataException("对象存储公开 URL 内容与写入内容不一致");
            }
            publicReadVerified = true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException ||
                                   !cancellationToken.IsCancellationRequested)
        {
            var code = stage switch
            {
                "write" => "write_failed",
                "internal_read" => "internal_read_failed",
                "public_read" => "public_read_failed",
                _ => "probe_failed",
            };
            _logger.LogError(
                ex,
                "Asset storage readiness probe failed. provider={Provider} stage={Stage}",
                provider,
                stage);
            result = Failure(
                provider,
                expected,
                code,
                SanitizedMessage(stage, ex),
                stopwatch,
                writeVerified,
                internalReadVerified,
                publicReadVerified,
                cleanupVerified);
        }
        finally
        {
            if (uploaded)
            {
                try
                {
                    await _storage.DeleteByKeyAsync(key, CancellationToken.None);
                    cleanupVerified = true;
                }
                catch (Exception ex)
                {
                    _logger.LogError(
                        ex,
                        "Asset storage readiness cleanup failed. provider={Provider}",
                        provider);
                    result ??= Failure(
                        provider,
                        expected,
                        "cleanup_failed",
                        "对象存储探针对象无法安全清理",
                        stopwatch,
                        writeVerified,
                        internalReadVerified,
                        publicReadVerified,
                        cleanupVerified);
                }
            }
        }

        if (result != null)
        {
            result.CleanupVerified = cleanupVerified;
            result.ProbeBytes = payload.LongLength;
            result.DurationMs = stopwatch.ElapsedMilliseconds;
            return result;
        }

        return new AssetStorageReadinessResponse
        {
            Status = "healthy",
            Provider = provider,
            ExpectedProvider = expected,
            WriteVerified = writeVerified,
            InternalReadVerified = internalReadVerified,
            PublicReadVerified = publicReadVerified,
            CleanupVerified = cleanupVerified,
            ProbeBytes = payload.LongLength,
            CheckedAt = DateTime.UtcNow,
            DurationMs = stopwatch.ElapsedMilliseconds,
        };
    }

    internal static byte[] CreateRepresentativeAudioPayload()
    {
        var payload = new byte[RepresentativePayloadBytes];
        for (var index = 0; index < payload.Length; index++)
        {
            payload[index] = (byte)((index * 31 + 17) & 0xff);
        }
        return payload;
    }

    internal static bool CanForceProbe(IPAddress? remoteAddress)
        => remoteAddress != null && IPAddress.IsLoopback(remoteAddress);

    private async Task<byte[]> ReadPublicBytesWithRetryAsync(
        Uri uri,
        CancellationToken cancellationToken)
    {
        HttpStatusCode? lastStatus = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            using var response = await _httpClientFactory
                .CreateClient("AssetStorageReadiness")
                .GetAsync(uri, cancellationToken);
            lastStatus = response.StatusCode;
            if (response.StatusCode == HttpStatusCode.OK)
            {
                return await response.Content.ReadAsByteArrayAsync(cancellationToken);
            }

            if (attempt < 3)
            {
                var delay = attempt == 1
                    ? TimeSpan.FromMilliseconds(200)
                    : TimeSpan.FromMilliseconds(500);
                await Task.Delay(delay, cancellationToken);
            }
        }

        throw new HttpRequestException(
            $"对象存储公开 URL 返回 HTTP {(int)(lastStatus ?? HttpStatusCode.ServiceUnavailable)}",
            null,
            lastStatus);
    }

    private Uri ResolvePublicUri(string provider, string publicUrl)
    {
        if (Uri.TryCreate(publicUrl, UriKind.Absolute, out var absolute)
            && (absolute.Scheme == Uri.UriSchemeHttp || absolute.Scheme == Uri.UriSchemeHttps))
        {
            return absolute;
        }

        if (!string.Equals(provider, "local", StringComparison.Ordinal)
            || !Uri.TryCreate(publicUrl, UriKind.Relative, out var relative))
        {
            throw new InvalidDataException("对象存储公开 URL 无效");
        }

        var publicBaseUrl = (_configuration["AssetStorageReadiness:PublicBaseUrl"]
            ?? string.Empty).Trim();
        if (!Uri.TryCreate(publicBaseUrl, UriKind.Absolute, out var publicBase)
            || (publicBase.Scheme != Uri.UriSchemeHttp
                && publicBase.Scheme != Uri.UriSchemeHttps))
        {
            throw new InvalidDataException("本地资产公开访问基地址未配置");
        }

        return new Uri(publicBase, relative);
    }

    internal static string CanonicalProvider(string? value)
    {
        var normalized = (value ?? string.Empty)
            .Trim()
            .Replace("-", string.Empty, StringComparison.Ordinal)
            .Replace("_", string.Empty, StringComparison.Ordinal)
            .ToLowerInvariant();
        return normalized switch
        {
            "tencentcos" or "cos" => "tencentCos",
            "cloudflarer2" or "r2" => "cloudflareR2",
            "local" => "local",
            _ => string.IsNullOrWhiteSpace(normalized) ? "unknown" : normalized,
        };
    }

    private static AssetStorageReadinessResponse Failure(
        string provider,
        string? expected,
        string code,
        string message,
        Stopwatch stopwatch,
        bool writeVerified = false,
        bool internalReadVerified = false,
        bool publicReadVerified = false,
        bool cleanupVerified = false)
    {
        return new AssetStorageReadinessResponse
        {
            Status = "unhealthy",
            Provider = provider,
            ExpectedProvider = expected,
            ErrorCode = code,
            ErrorMessage = message,
            WriteVerified = writeVerified,
            InternalReadVerified = internalReadVerified,
            PublicReadVerified = publicReadVerified,
            CleanupVerified = cleanupVerified,
            CheckedAt = DateTime.UtcNow,
            DurationMs = stopwatch.ElapsedMilliseconds,
        };
    }

    private static string SanitizedMessage(string stage, Exception ex)
    {
        if (ex is TimeoutException or TaskCanceledException)
        {
            return "对象存储探针超时";
        }
        if (ex is HttpRequestException http && http.StatusCode.HasValue)
        {
            return $"对象存储探针请求失败，HTTP {(int)http.StatusCode.Value}";
        }
        return stage switch
        {
            "write" => "对象存储写入失败",
            "internal_read" => "对象存储服务端读取校验失败",
            "public_read" => "对象存储公开 URL 读取校验失败",
            _ => "对象存储探针失败",
        };
    }
}
