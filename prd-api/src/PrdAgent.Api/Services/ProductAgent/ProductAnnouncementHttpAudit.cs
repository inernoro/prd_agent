using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>公告公开源的有界读取与逐次响应审计，使用既有管理员调用日志入口。</summary>
public sealed class ProductAnnouncementHttpAudit(MongoDbContext db, ILogger logger)
{
    private const int MaxBytes = 2 * 1024 * 1024;
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(25);

    public async Task<T> ReadAsync<T>(IHttpClientFactory clients, string url, string runId, string operation,
        int attempt, Func<string, T> parse, CancellationToken token)
    {
        var uri = new Uri(url, UriKind.Absolute);
        var started = DateTime.UtcNow;
        var timer = Stopwatch.StartNew();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(Timeout);
        using var client = clients.CreateClient("ProductAnnouncements");
        client.DefaultRequestHeaders.UserAgent.ParseAdd("MAP-VersionAnnouncements/1.0");
        client.Timeout = Timeout;
        HttpResponseMessage? response = null;
        using var buffer = new MemoryStream();
        string? body = null;
        string stage = "request", outcome = "running";
        bool parseSucceeded = false, truncated = false;
        string? errorType = null;
        object? fields = null;
        try
        {
            response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            stage = "read_response";
            if (response.Content.Headers.ContentLength > MaxBytes)
            {
                truncated = true;
                throw new InvalidDataException("公开源响应超过读取上限。");
            }
            await using var stream = await response.Content.ReadAsStreamAsync(deadline.Token);
            var chunk = new byte[8192];
            int count;
            while ((count = await stream.ReadAsync(chunk, deadline.Token)) != 0)
            {
                var accepted = Math.Min(count, MaxBytes - (int)buffer.Length);
                buffer.Write(chunk, 0, accepted);
                if (accepted != count)
                {
                    truncated = true;
                    throw new InvalidDataException("公开源响应超过读取上限。");
                }
            }
            body = Encoding.UTF8.GetString(buffer.ToArray());
            stage = "http_status";
            response.EnsureSuccessStatusCode();
            stage = "parse";
            var result = parse(body);
            fields = Describe(result);
            parseSucceeded = true;
            stage = "completed";
            outcome = "success";
            return result;
        }
        catch (Exception ex)
        {
            errorType = ex.GetType().Name;
            outcome = ex is OperationCanceledException ? token.IsCancellationRequested ? "cancelled" : "timeout"
                : stage == "parse" ? "parse_failed" : stage == "http_status" ? "http_failed"
                : response == null ? "network_failed" : "response_read_failed";
            throw;
        }
        finally
        {
            timer.Stop();
            body ??= buffer.Length == 0 ? null : Encoding.UTF8.GetString(buffer.ToArray());
            var preview = Preview(body);
            var safeHeaders = new Dictionary<string, string>();
            if (response != null)
            {
                foreach (var key in new[] { "Date", "Content-Type", "Content-Length", "Retry-After", "X-Request-ID", "X-Correlation-ID", "traceparent" })
                {
                    var values = response.Headers.TryGetValues(key, out var headers) ? headers
                        : response.Content.Headers.TryGetValues(key, out headers) ? headers : null;
                    if (values != null) safeHeaders[key] = Safe(string.Join(",", values), true);
                }
            }
            var captureTruncated = truncated || stage == "read_response";
            var snapshotTruncated = body?.Length > 2048;
            var evidence = JsonSerializer.Serialize(new
            {
                auditVersion = 1, runId, operation, attempt, stage, outcome,
                responseReceived = response != null, parseSucceeded, errorType,
                httpStatus = response == null ? (int?)null : (int)response.StatusCode,
                safeResponseHeaders = safeHeaders, responsePreview = preview,
                fieldDiagnostics = fields, capturedBytes = buffer.Length,
                declaredBytes = response?.Content.Headers.ContentLength,
                captureTruncated, snapshotTruncated,
                truncationReason = captureTruncated ? truncated ? "response_limit" : "response_read_incomplete"
                    : snapshotTruncated ? "safe_summary_limit" : null,
                bodySha256 = body == null ? null : Convert.ToHexString(SHA256.HashData(buffer.ToArray())).ToLowerInvariant(),
                fingerprintScope = body == null ? null : captureTruncated ? "captured_prefix" : "complete_body",
                recovery = outcome == "success" ? "continue" : "keep_checkpoint_and_retry",
                timeoutSeconds = Timeout.TotalSeconds, maxCaptureBytes = MaxBytes,
                build = Safe(Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown"),
                instance = Safe(Environment.MachineName),
            });
            var log = new ApiRequestLog
            {
                Id = Guid.NewGuid().ToString("N"), RequestId = $"{runId}:{operation}:{attempt}",
                SessionId = runId, StartedAt = started, EndedAt = DateTime.UtcNow, DurationMs = timer.ElapsedMilliseconds,
                Method = "GET", Path = uri.AbsolutePath, Query = uri.Query, AbsoluteUrl = uri.AbsoluteUri,
                Protocol = uri.Scheme, TargetHost = uri.Host, Direction = "outbound", UserId = "system",
                ClientType = "server", AppId = "product-agent", AppName = "产品管理",
                StatusCode = response == null ? 0 : (int)response.StatusCode,
                ResponseContentType = response?.Content.Headers.ContentType?.MediaType,
                ApiSummary = $"公告公开源/{operation}/{outcome}", ErrorCode = outcome == "success" ? null : outcome,
                Status = outcome == "success" ? "completed" : outcome == "timeout" ? "timeout" : "failed",
                ResponseBody = evidence, ResponseBodyBytes = (int)buffer.Length,
                ResponseBodyTruncated = captureTruncated || snapshotTruncated,
            };
            try
            {
                using var auditDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                await db.ApiRequestLogs.InsertOneAsync(log, cancellationToken: auditDeadline.Token);
            }
            catch (Exception ex)
            {
                logger.LogError("公告响应审计无法保存：auditId={AuditId}, runId={RunId}, operation={Operation}, errorType={ErrorType}",
                    log.Id, runId, operation, ex.GetType().Name);
                throw new InvalidOperationException("公告响应审计未能保存，已保留抓取断点，请稍后重试。", ex);
            }
            finally { response?.Dispose(); }
        }
    }

    private static string Safe(string value, bool preserveTraceId = false) =>
        MiduoPlanetSsoAudit.SafeText(value, Array.Empty<string>(), preserveTraceId);

    private static string? Preview(string? body)
    {
        if (body == null) return null;
        var prefix = body[..Math.Min(body.Length, 8192)];
        try
        {
            prefix = Regex.Replace(prefix, @"<(script|style)\b[^>]*>.*?</\1>", " ", RegexOptions.IgnoreCase | RegexOptions.Singleline, TimeSpan.FromMilliseconds(100));
            prefix = Regex.Replace(prefix, "<[^>]+>", " ", RegexOptions.Singleline, TimeSpan.FromMilliseconds(100));
            prefix = Regex.Replace(prefix, @"\s+", " ", RegexOptions.None, TimeSpan.FromMilliseconds(100)).Trim();
            return Safe(prefix);
        }
        catch (RegexMatchTimeoutException) { return "[REDACTED: summary timeout]"; }
    }

    private static object? Describe<T>(T result) => result switch
    {
        AnnouncementPage page => new { kind = "list", count = page.Items.Count, page.HasNext,
            titles = page.Items.Take(3).Select(x => Safe(x.Title)).ToArray() },
        ValueTuple<string, string> dates => new { kind = "detail", publishedAtRaw = Safe(dates.Item1),
            publishedAtState = dates.Item1.Length == 0 ? "missing" : "present", footerTimeRaw = Safe(dates.Item2),
            footerTimeState = dates.Item2.Length == 0 ? "missing" : "present" },
        ProductWorkdayCalendar calendar => new { kind = "calendar", calendar.Year, dayCount = calendar.Overrides.Count },
        _ => null,
    };
}
