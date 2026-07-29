using System.Diagnostics;
using System.Net;
using System.Text;
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
    private static readonly TimeSpan DefaultCacheTtl = TimeSpan.FromMinutes(2);

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
        var cacheSeconds = Math.Clamp(
            _configuration.GetValue<int?>("AssetStorageReadiness:CacheSeconds")
                ?? (int)DefaultCacheTtl.TotalSeconds,
            15,
            900);
        var cached = _cached;
        if (!force &&
            cached != null &&
            DateTime.UtcNow - cached.CheckedAt < TimeSpan.FromSeconds(cacheSeconds))
        {
            return cached;
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            cached = _cached;
            if (!force &&
                cached != null &&
                DateTime.UtcNow - cached.CheckedAt < TimeSpan.FromSeconds(cacheSeconds))
            {
                return cached;
            }

            _cached = await ExecuteAsync(cancellationToken);
            return _cached;
        }
        finally
        {
            _gate.Release();
        }
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

        var key = $"{ProbePrefix}/{Guid.NewGuid():N}.txt";
        var payload = Encoding.UTF8.GetBytes($"prd-agent-storage-readiness:{Guid.NewGuid():N}");
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
                "text/plain; charset=utf-8",
                cancellationToken,
                "no-store");
            uploaded = true;
            writeVerified = true;

            stage = "internal_read";
            var downloaded = await _storage.TryDownloadBytesAsync(key, cancellationToken);
            if (downloaded == null || !downloaded.AsSpan().SequenceEqual(payload))
            {
                throw new InvalidDataException("对象存储内部读取内容与写入内容不一致");
            }
            internalReadVerified = true;

            if (string.Equals(provider, "local", StringComparison.Ordinal))
            {
                publicReadVerified = true;
            }
            else
            {
                stage = "public_read";
                var publicUrl = _storage.BuildUrlForKey(key);
                if (!Uri.TryCreate(publicUrl, UriKind.Absolute, out var uri) ||
                    (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                {
                    throw new InvalidDataException("对象存储公开 URL 无效");
                }

                var publicBytes = await ReadPublicBytesWithRetryAsync(uri, cancellationToken);
                if (!publicBytes.AsSpan().SequenceEqual(payload))
                {
                    throw new InvalidDataException("对象存储公开 URL 内容与写入内容不一致");
                }
                publicReadVerified = true;
            }
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
            CheckedAt = DateTime.UtcNow,
            DurationMs = stopwatch.ElapsedMilliseconds,
        };
    }

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
