using System.Net;
using System.Diagnostics;
using System.Text.Json;
using MongoDB.Driver;
using Microsoft.Extensions.Caching.Memory;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.Infrastructure.Security;

namespace PrdAgent.Api.Services;

/// <summary>
/// 迁移期间只读兼容历史附件：仅探测管理员已配置的 COS 公域，不访问记录中的未知旧域。
/// 当前提供方和当前 COS 地址原样保留；旧记录只在同 key 对象存在且长度吻合时切换读取地址。
/// </summary>
public sealed class HistoricalAssetUrlResolver(
    IConfiguration configuration,
    IHttpClientFactory httpClientFactory,
    ILogger<HistoricalAssetUrlResolver>? logger = null,
    IMongoCollection<ApiRequestLog>? auditLogs = null,
    IHttpContextAccessor? httpContextAccessor = null) : IDisposable
{
    private readonly SemaphoreSlim _probes = new(4);
    private readonly MemoryCache cache = new(new MemoryCacheOptions { SizeLimit = 512 });
    // 整页共享 4 秒：网络最多 3.8 秒，为最后一批已发请求的审计预留 200ms。
    private static readonly TimeSpan ProbeBudget = TimeSpan.FromMilliseconds(3800);
    private static readonly TimeSpan AuditBudget = TimeSpan.FromMilliseconds(200);

    public void Dispose()
    {
        cache.Dispose();
        _probes.Dispose();
    }

    public async Task ResolveAttachmentsForReadAsync(IEnumerable<DefectReport> defects, CancellationToken ct)
    {
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
        budget.CancelAfter(ProbeBudget);
        // 列表会立即渲染图片，日志按需下载；不能让日志占满整页预算而饿死可见图片。
        var attachments = defects.SelectMany(defect => defect.Attachments.Select(attachment => (defect, attachment)))
            .OrderByDescending(x => (x.attachment.MimeType ?? string.Empty).StartsWith("image/", StringComparison.OrdinalIgnoreCase));
        await Task.WhenAll(attachments.Select(async item =>
        {
            var attachment = item.attachment;
            try
            {
                var original = attachment.Url;
                var resolved = await ResolveAttachmentUrlCoreAsync(attachment, budget.Token, ct, item.defect.Id, item.defect.ProjectId);
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

    public Task<string> ResolveAttachmentUrlAsync(DefectAttachment attachment, CancellationToken ct)
        => ResolveAttachmentUrlCoreAsync(attachment, ct, ct);

    private async Task<string> ResolveAttachmentUrlCoreAsync(DefectAttachment attachment, CancellationToken ct,
        CancellationToken callerCancellation, string? defectId = null, string? projectId = null)
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
        ApiRequestLog? audit = null;
        HttpResponseMessage? response = null;
        var reason = "unexpected_failure";
        var startedAt = DateTime.UtcNow;
        var stopwatch = Stopwatch.StartNew();
        try
        {
            ct.ThrowIfCancellationRequested();
            if (cache.TryGetValue(cacheKey, out found)) return found ? candidate : original;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(ProbeBudget);
            using var request = new HttpRequestMessage(HttpMethod.Head, candidate);
            using var client = httpClientFactory.CreateClient(nameof(HistoricalAssetUrlResolver));
            var context = httpContextAccessor?.HttpContext;
            audit = new ApiRequestLog
            {
                Id = Guid.NewGuid().ToString("N"),
                RequestId = SafeLabel(context?.Items["RequestId"]?.ToString())
                    ?? Activity.Current?.Id ?? context?.TraceIdentifier ?? Guid.NewGuid().ToString("N"),
                AppName = "defect-agent", AppId = "defect-agent",
                UserId = SafeLabel(context?.User.FindFirst("sub")?.Value) ?? "system",
                ClientType = "server", Direction = "outbound", Method = "HEAD",
                // 配置基址的路径也可能包含秘密；只存受控对象路径，不存原始 URL、query 或请求头。
                Path = "/" + key, AbsoluteUrl = $"https://{new Uri(candidate).Host}/[historical-attachment]",
                Protocol = "https", TargetHost = new Uri(candidate).Host, StartedAt = startedAt
            };
            request.Options.Set(MapModelEgressHandler.DisableRedirects, true);
            response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            // 不把重定向后的未知来源当作可信 COS 对象。
            found = response.StatusCode == HttpStatusCode.OK
                && response.RequestMessage?.RequestUri is { } actual
                && string.Equals(actual.AbsoluteUri, candidate, StringComparison.Ordinal)
                && attachment.FileSize > 0
                && response.Content.Headers.ContentLength == attachment.FileSize;
            reason = response.StatusCode != HttpStatusCode.OK ? "http_status"
                : response.RequestMessage?.RequestUri?.AbsoluteUri != candidate ? "unexpected_target"
                : response.Content.Headers.ContentLength != attachment.FileSize ? "length_mismatch" : "matched";
            cache.Set(cacheKey, found, new MemoryCacheEntryOptions
            {
                Size = 1,
                AbsoluteExpirationRelativeToNow = found ? TimeSpan.FromMinutes(10) : TimeSpan.FromSeconds(30)
            });
            return found ? candidate : original;
        }
        catch (OperationCanceledException)
        {
            reason = callerCancellation.IsCancellationRequested ? "caller_cancelled"
                : ct.IsCancellationRequested ? "page_budget_exhausted" : "upstream_timeout";
            if (ct.IsCancellationRequested) throw;
            return original;
        }
        catch (HttpRequestException)
        {
            reason = "network_failure";
            return original;
        }
        finally
        {
            stopwatch.Stop();
            // 释放的是网络并发槽；审计不会占用后续图片的探测机会。
            _probes.Release();
            if (audit != null)
            {
                audit.EndedAt = DateTime.UtcNow;
                audit.DurationMs = stopwatch.ElapsedMilliseconds;
                audit.StatusCode = response == null ? 0 : (int)response.StatusCode;
                audit.Status = reason == "matched" ? "completed"
                    : reason is "page_budget_exhausted" or "upstream_timeout" ? "timeout" : "failed";
                audit.ErrorCode = reason == "matched" ? null : reason;
                audit.ApiSummary = $"historical-asset.head:{reason}";
                audit.ResponseContentType = SafeLabel(response?.Content.Headers.ContentType?.MediaType);
                audit.ResponseBodyBytes = response == null ? null : 0; // HEAD 的对象长度并非响应体长度。
                audit.ResponseBody = JsonSerializer.Serialize(new
                {
                    service = "historical-cos", operation = "historical-asset.head", attempt = 1,
                    attachmentId = SafeLabel(attachment.Id), defectId = SafeLabel(defectId), projectId = SafeLabel(projectId),
                    receivedResponse = response != null, httpStatus = response == null ? (int?)null : (int)response.StatusCode,
                    expectedLength = attachment.FileSize, actualLength = response?.Content.Headers.ContentLength,
                    reason, recovery = reason == "matched" ? "use_verified_legacy_url" : "preserve_original_url",
                    bodyOmission = response == null ? "no response received" : "HEAD has no response body",
                    upstreamRequestIdSha256 = HashUpstreamRequestId(response),
                    provider = "cloudflareR2", probeTimeoutMs = 3800, auditTimeoutMs = 200,
                    evidenceLimitChars = 4096, configUpdatedAt = (string?)null,
                    build = SafeLabel(typeof(HistoricalAssetUrlResolver).Assembly
                        .GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
                        .OfType<System.Reflection.AssemblyInformationalVersionAttribute>().FirstOrDefault()?.InformationalVersion),
                    instance = SafeLabel(Environment.MachineName)
                });
                response?.Dispose();
                await PersistAuditAsync(audit, SafeLabel(attachment.Id));
            }
        }
    }

    private async Task PersistAuditAsync(ApiRequestLog audit, string? attachmentId)
    {
        if (auditLogs == null) return; // 仅供不接数据库的单元构造；生产工厂强制注入现有受控集合。
        using var deadline = new CancellationTokenSource(AuditBudget);
        try
        {
            // 与已取消的业务 token 分离，保证取消/预算用尽也有机会落库；等待仍严格有界。
            await auditLogs.InsertOneAsync(audit, cancellationToken: deadline.Token).WaitAsync(deadline.Token);
        }
        catch (Exception ex)
        {
            // 不记录 Mongo 连接串或异常原文，明确报告证据缺失，不能声称已持久化。
            logger?.LogError("Historical asset audit missing: request={RequestId}, attachment={AttachmentId}, failure={FailureType}",
                audit.RequestId, attachmentId, ex.GetType().Name);
        }
    }

    private static string? SafeLabel(string? value)
        => value != null && System.Text.RegularExpressions.Regex.IsMatch(value, @"\A[a-zA-Z0-9_.:/|+\-]{1,128}\z") ? value : null;

    private static string? HashUpstreamRequestId(HttpResponseMessage? response)
    {
        if (response == null || !response.Headers.TryGetValues("x-cos-request-id", out var values)) return null;
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(string.Join(",", values))));
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
