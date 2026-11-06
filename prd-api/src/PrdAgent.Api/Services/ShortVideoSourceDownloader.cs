using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

/// <summary>仅使用解析器已经返回的播放地址；逐次审计后，403 才切换到下一个地址。</summary>
public sealed class ShortVideoSourceDownloader(
    MongoDbContext db, IHttpClientFactory clients, ISafeOutboundUrlValidator validator,
    ILogger<ShortVideoSourceDownloader> logger)
{
    public sealed record Download(byte[] Bytes, string Mime);

    public static IReadOnlyList<string> SelectCandidates(string primaryUrl, string? metadataJson)
    {
        var urls = new List<string> { ShortVideoMaterialProcessor.RequireResolvedVideoUrl(primaryUrl) };
        try
        {
            using var metadata = JsonDocument.Parse(metadataJson ?? "{}");
            if (metadata.RootElement.ValueKind != JsonValueKind.Object || !metadata.RootElement.TryGetProperty("rawResponse", out var raw) || raw.ValueKind != JsonValueKind.String) return urls;
            using var upstream = JsonDocument.Parse(raw.GetString() ?? "{}");
            if (upstream.RootElement.ValueKind != JsonValueKind.Object || !upstream.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object) return urls;
            if (data.TryGetProperty("aweme_detail", out var detail)) data = detail;
            if (data.ValueKind != JsonValueKind.Object || !data.TryGetProperty("video", out var video) || video.ValueKind != JsonValueKind.Object) return urls;
            foreach (var key in new[] { "play_addr_h264", "play_addr", "play_addr_265" })
            {
                if (!video.TryGetProperty(key, out var address) || address.ValueKind != JsonValueKind.Object || !address.TryGetProperty("url_list", out var list)
                    || list.ValueKind != JsonValueKind.Array) continue;
                foreach (var item in list.EnumerateArray())
                {
                    var url = item.ValueKind == JsonValueKind.String ? item.GetString()?.Trim() : null;
                    if (ShortVideoMaterialProcessor.IsHttpUrl(url) && !urls.Contains(url!, StringComparer.Ordinal)) urls.Add(url!);
                    if (urls.Count == 3) return urls;
                }
            }
        }
        catch (JsonException) { /* 已解析的主地址仍可使用，不重新调用解析服务。 */ }
        return urls;
    }

    public async Task<Download> DownloadAsync(ShortVideoMaterialRun run, string primaryUrl, string? metadataJson)
    {
        var candidates = SelectCandidates(primaryUrl, metadataJson);
        using var client = clients.CreateClient("SafeOutbound");
        client.Timeout = TimeSpan.FromSeconds(180);
        var attempt = 0;
        for (var candidate = 0; candidate < candidates.Count; candidate++)
        {
            var current = candidates[candidate];
            for (var redirect = 0; redirect <= 5; redirect++)
            {
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(180));
                var started = DateTime.UtcNow;
                var timer = Stopwatch.StartNew();
                HttpResponseMessage? response = null;
                byte[]? bytes = null;
                string? preview = null, errorType = null, next = null;
                var outcome = "network_failed";
                var stage = "validate_url";
                var omitted = "no_response";
                var attemptNumber = ++attempt;
                try
                {
                    // 每个备用地址和每次重定向均重新检查，不能借恢复逻辑绕过内网限制。
                    var safe = await validator.EnsureSafeHttpUrlAsync(current, "短视频文件地址", deadline.Token);
                    stage = "request";
                    response = await client.GetAsync(safe, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
                    stage = "response";
                    outcome = "http_failed";
                    omitted = "non_media_response";
                    if ((int)response.StatusCode is >= 300 and <= 399 && response.Headers.Location != null)
                    {
                        if (redirect == 5) throw new InvalidOperationException("视频地址重定向次数过多");
                        next = new Uri(safe, response.Headers.Location).ToString();
                        outcome = "redirect";
                        omitted = "redirect_response";
                    }
                    else if (response.StatusCode == System.Net.HttpStatusCode.Forbidden)
                    {
                        preview = await ErrorPreviewAsync(response, deadline.Token);
                        // 只切换到同一次解析返回的地址；不重复提交解析、ASR 或模型任务。
                        if (candidate + 1 < candidates.Count) outcome = "switch_candidate";
                        else throw new InvalidOperationException("视频文件暂时无法下载，请稍后重新解析。");
                    }
                    else
                    {
                        if (!response.IsSuccessStatusCode) preview = await ErrorPreviewAsync(response, deadline.Token);
                        response.EnsureSuccessStatusCode();
                        var rawType = response.Content.Headers.ContentType?.MediaType;
                        var mime = string.IsNullOrWhiteSpace(rawType) || rawType.EndsWith("/octet-stream", StringComparison.OrdinalIgnoreCase)
                            ? "video/mp4" : rawType;
                        if (!mime.StartsWith("video/", StringComparison.OrdinalIgnoreCase))
                        {
                            outcome = "invalid_media";
                            preview = await ErrorPreviewAsync(response, deadline.Token);
                            throw new InvalidOperationException("下载地址未返回视频文件，请重新选择有效的视频链接。");
                        }
                        outcome = "response_read_failed";
                        bytes = await response.Content.ReadAsByteArrayAsync(deadline.Token);
                        if (bytes.Length == 0) throw new InvalidOperationException("视频文件为空，请重新解析。");
                        outcome = "success";
                        omitted = "media_body_excluded";
                        return new Download(bytes, mime);
                    }
                }
                catch (Exception ex)
                {
                    errorType = ex.GetType().Name;
                    if (ex is OperationCanceledException) outcome = "timeout";
                    throw new InvalidOperationException(outcome == "invalid_media"
                        ? "下载地址未返回视频文件，请重新选择有效的视频链接。"
                        : "视频文件暂时无法下载，请稍后重新解析。", ex);
                }
                finally
                {
                    timer.Stop();
                    var uri = Uri.TryCreate(current, UriKind.Absolute, out var parsed) ? parsed : null;
                    var safeTarget = uri == null ? "invalid-url" : $"{uri.Scheme}://{uri.Host}:{uri.Port}/[media-path-redacted]";
                    var headers = new Dictionary<string, string>();
                    if (response != null)
                        foreach (var key in new[] { "Date", "Content-Type", "Content-Length", "Retry-After", "X-Request-ID", "X-Correlation-ID", "traceparent" })
                        {
                            var values = response.Headers.TryGetValues(key, out var h) ? h : response.Content.Headers.TryGetValues(key, out h) ? h : null;
                            if (values != null) headers[key] = MiduoPlanetSsoAudit.SafeText(string.Join(",", values), Array.Empty<string>());
                        }
                    var evidence = JsonSerializer.Serialize(new
                    {
                        runId = run.Id, operation = "short_video_source_download", attempt = attemptNumber, candidate = candidate + 1,
                        responseReceived = response != null, httpStatus = response == null ? (int?)null : (int)response.StatusCode,
                        stage, outcome, errorType, safeResponseHeaders = headers, responsePreview = preview,
                        declaredBytes = response?.Content.Headers.ContentLength, capturedBytes = bytes?.LongLength,
                        bodySha256 = bytes == null ? null : Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                        omittedReason = omitted, previewLimitBytes = 2048, responsePreviewLimited = preview != null,
                        recovery = outcome == "switch_candidate" ? "next_parser_provided_url" : outcome == "redirect" ? "validate_redirect" : "none",
                        timeoutSeconds = 180, maxCandidates = 3, maxRedirects = 5,
                        build = Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown",
                        instance = Environment.MachineName,
                    });
                    try
                    {
                        using var auditDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                        await db.ApiRequestLogs.InsertOneAsync(new ApiRequestLog
                        {
                            Id = Guid.NewGuid().ToString("N"), RequestId = $"{run.Id}:video-download:{attemptNumber}", SessionId = run.Id,
                            StartedAt = started, EndedAt = DateTime.UtcNow, DurationMs = timer.ElapsedMilliseconds,
                            Method = "GET", Path = "/short-video-source-download", AbsoluteUrl = safeTarget, TargetHost = uri?.Host,
                            Direction = "outbound", UserId = run.UserId, AppId = "document-store", AppName = "知识库", ClientType = "server",
                            StatusCode = response == null ? 0 : (int)response.StatusCode, ResponseContentType = response?.Content.Headers.ContentType?.MediaType,
                            ApiSummary = "短视频文件下载/" + outcome, Status = outcome == "success" || outcome == "redirect" ? "completed" : outcome == "timeout" ? "timeout" : "failed",
                            ErrorCode = outcome is "success" or "redirect" ? null : outcome, ResponseBody = evidence,
                            ResponseBodyTruncated = true,
                        }, cancellationToken: auditDeadline.Token);
                    }
                    catch (Exception ex)
                    {
                        logger.LogError("短视频下载审计保存失败 runId={RunId}, attempt={Attempt}, errorType={ErrorType}", run.Id, attemptNumber, ex.GetType().Name);
                        throw new InvalidOperationException("下载审计未能保存，请稍后重试。", ex);
                    }
                    finally { response?.Dispose(); }
                }
                if (next == null) break;
                current = next;
            }
        }
        throw new InvalidOperationException("视频文件暂时无法下载，请稍后重新解析。");
    }

    private static async Task<string> ErrorPreviewAsync(HttpResponseMessage response, CancellationToken ct)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        var buffer = new byte[2048];
        var count = 0;
        while (count < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(count), ct);
            if (read == 0) break;
            count += read;
        }
        var text = Encoding.UTF8.GetString(buffer, 0, count);
        text = Regex.Replace(text, @"https?://[^\s""'<>]+", "[REDACTED URL]", RegexOptions.IgnoreCase, TimeSpan.FromMilliseconds(100));
        return MiduoPlanetSsoAudit.SafeText(text, Array.Empty<string>());
    }
}
