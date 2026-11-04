using System.Net;
using Microsoft.Extensions.Caching.Memory;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

/// <summary>
/// 迁移期间只读兼容历史附件：仅探测管理员已配置的 COS 公域，不访问记录中的未知旧域。
/// 当前提供方和当前 COS 地址原样保留；旧记录只在同 key 对象存在且长度吻合时切换读取地址。
/// </summary>
public sealed class HistoricalAssetUrlResolver(
    IConfiguration configuration,
    IHttpClientFactory httpClientFactory,
    ILogger<HistoricalAssetUrlResolver>? logger = null) : IDisposable
{
    private readonly SemaphoreSlim _probes = new(4);
    private readonly MemoryCache cache = new(new MemoryCacheOptions { SizeLimit = 512 });

    public void Dispose()
    {
        cache.Dispose();
        _probes.Dispose();
    }

    public async Task ResolveAttachmentsForReadAsync(IEnumerable<DefectReport> defects, CancellationToken ct)
    {
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(TimeSpan.FromSeconds(4));
        // 列表会立即渲染图片，日志按需下载；不能让日志占满整页预算而饿死可见图片。
        var attachments = defects.SelectMany(x => x.Attachments)
            .OrderByDescending(x => (x.MimeType ?? string.Empty).StartsWith("image/", StringComparison.OrdinalIgnoreCase));
        await Task.WhenAll(attachments.Select(async attachment =>
        {
            try
            {
                var original = attachment.Url;
                var resolved = await ResolveAttachmentUrlAsync(attachment, budget.Token);
                attachment.Url = resolved;
                if (attachment.ThumbnailUrl == original) attachment.ThumbnailUrl = resolved;
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
        }));
    }

    public static string? ResolveLegacyPublicBaseUrl(IConfiguration configuration)
    {
        if (!string.Equals(AssetStorageProviderResolver.ResolveProviderName(configuration),
                AssetStorageProviderResolver.CloudflareR2, StringComparison.OrdinalIgnoreCase))
            return null;
        var raw = (configuration["TENCENT_COS_PUBLIC_BASE_URL"] ?? string.Empty).Trim().TrimEnd('/');
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
            || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment))
            return null;
        return raw;
    }

    public async Task<string> ResolveAttachmentUrlAsync(DefectAttachment attachment, CancellationToken ct)
    {
        var original = attachment.Url;
        var legacyBase = ResolveLegacyPublicBaseUrl(configuration);
        var currentBase = AssetStorageProviderResolver.ResolveCloudPublicBaseUrl(configuration);
        if (string.IsNullOrWhiteSpace(legacyBase)
            || attachment.FileSize <= 0
            || !Uri.TryCreate(original, UriKind.Absolute, out var source)
            || source.Scheme is not ("https" or "http")
            || !string.IsNullOrEmpty(source.UserInfo) || !string.IsNullOrEmpty(source.Query)
            || !string.IsNullOrEmpty(source.Fragment)
            || IsUnderBase(source, legacyBase) || IsUnderBase(source, currentBase)
            || IsNativeCosAddress(source))
            return original;

        // 附件只能来自上传接口生成的业务命名空间；不重写外部链接、头像、路径穿越或签名 URL。
        var key = source.AbsolutePath.TrimStart('/');
        if (!System.Text.RegularExpressions.Regex.IsMatch(key,
                @"\Adata/defect-agent/(?:img|log)/[a-z0-9]{26}\.[a-z0-9]{1,8}\z",
                System.Text.RegularExpressions.RegexOptions.CultureInvariant))
            return original;
        var candidate = $"{legacyBase}/{key}";
        var cacheKey = $"historical-asset:{candidate}:{attachment.FileSize}";
        if (cache.TryGetValue(cacheKey, out bool found)) return found ? candidate : original;

        await _probes.WaitAsync(ct);
        try
        {
            ct.ThrowIfCancellationRequested();
            if (cache.TryGetValue(cacheKey, out found)) return found ? candidate : original;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(4));
            using var request = new HttpRequestMessage(HttpMethod.Head, candidate);
            using var client = httpClientFactory.CreateClient(nameof(HistoricalAssetUrlResolver));
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            // 不把重定向后的未知来源当作可信 COS 对象。
            found = response.StatusCode == HttpStatusCode.OK
                && response.RequestMessage?.RequestUri is { } actual
                && string.Equals(actual.AbsoluteUri, candidate, StringComparison.Ordinal)
                && attachment.FileSize > 0
                && response.Content.Headers.ContentLength == attachment.FileSize;
            cache.Set(cacheKey, found, new MemoryCacheEntryOptions
            {
                Size = 1,
                AbsoluteExpirationRelativeToNow = found ? TimeSpan.FromMinutes(10) : TimeSpan.FromSeconds(30)
            });
            logger?.LogDebug("Historical attachment read probe: attachment={AttachmentId}, found={Found}, status={Status}",
                attachment.Id, found, (int)response.StatusCode);
            return found ? candidate : original;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            logger?.LogDebug("Historical attachment read probe timed out: attachment={AttachmentId}", attachment.Id);
            return original;
        }
        catch (HttpRequestException ex)
        {
            logger?.LogDebug(ex, "Historical attachment read probe failed: attachment={AttachmentId}", attachment.Id);
            return original;
        }
        finally { _probes.Release(); }
    }

    private static bool IsUnderBase(Uri source, string? baseUrl)
        => Uri.TryCreate(baseUrl?.TrimEnd('/') + "/", UriKind.Absolute, out var basis)
           && basis.IsBaseOf(source);

    private static bool IsNativeCosAddress(Uri source)
        // COS 固有的桶/地域源站地址保留原样；不把已完整的存储地址重新解释为过期 CDN，亦不新增读取权限。
        => source.Scheme == Uri.UriSchemeHttps && System.Text.RegularExpressions.Regex.IsMatch(source.DnsSafeHost,
            @"\A[a-z0-9][a-z0-9-]*-[0-9]+\.cos\.[a-z0-9-]+\.myqcloud\.com\z",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);
}
