using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

public sealed class QuickCreationExportWorker(IServiceScopeFactory scopes, IHttpClientFactory http,
    IConfiguration config, IHostApplicationLifetime lifetime, ILogger<QuickCreationExportWorker> logger) : BackgroundService
{
    private const int MaxExportBytes = 384 * 1024 * 1024;
    private static readonly TimeSpan LeaseTime = TimeSpan.FromMinutes(50);
    private static readonly TimeSpan Poll = TimeSpan.FromSeconds(4);
    private readonly SemaphoreSlim _exportSlot = new(1, 1);

    internal static FilterDefinition<DesignArtifactRun> Scope
        => DesignArtifactTimingStats.ScopeFilter(DeploymentScope.CurrentDurable);

    internal void NotifyQueuedExport(string runId)
    {
        logger.LogInformation("Browser film export notified run={RunId}", runId);
        _ = ProcessNextAsync(lifetime.ApplicationStopping);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Browser film export worker ready");
        while (await DelayAsync(stoppingToken))
            await ProcessNextAsync(stoppingToken);
    }

    private async Task ProcessNextAsync(CancellationToken stoppingToken)
    {
        if (stoppingToken.IsCancellationRequested || !_exportSlot.Wait(0)) return;
        try
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
            var now = DateTime.UtcNow;
            var claim = Guid.NewGuid().ToString("N");
            var filter = Builders<DesignArtifactRun>.Filter;
            var updates = Builders<DesignArtifactRun>.Update;
            var eligible = Scope & (filter.Eq(row => row.BrowserFilmExport!.Status, "queued")
                | (filter.Eq(row => row.BrowserFilmExport!.Status, "running")
                   & filter.Lte(row => row.BrowserFilmExport!.ExpiresAt, now)));
            using var claimDeadline = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            claimDeadline.CancelAfter(TimeSpan.FromSeconds(20));
            var run = await db.DesignArtifactRuns.Find(eligible)
                .SortBy(row => row.BrowserFilmExport!.QueuedAt).Limit(1).FirstOrDefaultAsync(claimDeadline.Token);
            if (run == null) return;
            var sameRun = filter.Eq(row => row.Id, run.Id);
            var claimed = await db.DesignArtifactRuns.UpdateOneAsync(sameRun & eligible,
                updates.Set(row => row.BrowserFilmExport!.Status, "running")
                    .Set(row => row.BrowserFilmExport!.Lease, claim)
                    .Set(row => row.BrowserFilmExport!.ExpiresAt, now.Add(LeaseTime)), cancellationToken: claimDeadline.Token);
            if (claimed.ModifiedCount != 1) return;
            logger.LogInformation("Browser film export claimed run={RunId}", run.Id);
            var owned = sameRun & filter.Eq(row => row.BrowserFilmExport!.Lease, claim);
            var attempt = new QuickCreationExportAttempt { Id = claim };
            try
            {
                var key = await ExportAsync(run, scope.ServiceProvider, attempt, stoppingToken);
                await FinishAsync(key == null ? "queued" : "done", key, null);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                await FinishAsync("queued", null, null);
                return;
            }
            catch (Exception error)
            {
                logger.LogWarning("Browser film export failed run={RunId} kind={ErrorType}", run.Id, error.GetType().Name);
                await FinishAsync("failed", null, "云端导出没有完成，播放网页仍保留，可以重试。");
            }

            async Task FinishAsync(string state, string? key, string? error)
            {
                using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                var change = updates.Set(row => row.BrowserFilmExport!.Status, state)
                    .Set(row => row.BrowserFilmExport!.AssetKey, key)
                    .Set(row => row.BrowserFilmExport!.Error, error)
                    .Set(row => row.BrowserFilmExport!.Lease, null)
                    .Set(row => row.BrowserFilmExport!.ExpiresAt, null);
                if (attempt.StartedAt != default)
                {
                    attempt.EndedAt = DateTime.UtcNow;
                    change = updates.Combine(change,
                        updates.PushEach(row => row.BrowserFilmExportAttempts, new[] { attempt }, slice: -100),
                        updates.Inc(row => row.BrowserFilmExportAttemptCount, 1L));
                }
                await db.DesignArtifactRuns.UpdateOneAsync(owned, change, cancellationToken: deadline.Token);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            return;
        }
        catch (Exception error)
        {
            logger.LogWarning("Browser film export polling failed kind={ErrorType}", error.GetType().Name);
        }
        finally
        {
            _exportSlot.Release();
        }
    }

    private async Task<string?> ExportAsync(DesignArtifactRun run, IServiceProvider scope,
        QuickCreationExportAttempt attempt, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromMinutes(46));
        var token = deadline.Token;
        var broker = scope.GetRequiredService<IDesignArtifactWorkspaceBroker>();
        var storage = scope.GetRequiredService<IAssetStorage>();
        var package = await broker.ReadCommittedCodeFilmAsync(run, token);
        var file = package.Files.Single(item => item.Path == "film-bundle.json");
        var bytes = Convert.FromBase64String(file.ContentBase64);
        using var bundle = JsonDocument.Parse(bytes);
        var transport = OpenDesignTransportResolver.ResolveForCodeFilmSlot(config, run.CodeFilmRuntimeSlot);
        if (transport.BaseUrl == null || transport.ApiKey == null || transport.Problem != null)
            throw new InvalidOperationException("Cloud film export service is unavailable");
        using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(transport.BaseUrl, "/v1/film-exports"))
        {
            Content = JsonContent.Create(new { html = QuickCreationBrowserPlayback.RenderSandbox(bytes),
                aac = bundle.RootElement.GetProperty("aac").GetString(), durationSec = run.QuickCreationMedia!.DurationSec }),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", transport.ApiKey);
        using var client = http.CreateClient(OpenDesignTransportServiceCollectionExtensions.ServiceHttpClientName);
        client.Timeout = Timeout.InfiniteTimeSpan;
        attempt.StartedAt = DateTime.UtcNow;
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        attempt.HttpStatus = (int)response.StatusCode;
        attempt.MediaType = response.Content.Headers.ContentType?.MediaType switch
        {
            null => null,
            "video/mp4" => "video/mp4",
            "application/json" => "application/json",
            _ => "other",
        };
        attempt.ContentBytes = response.Content.Headers.ContentLength;
        if (!response.IsSuccessStatusCode)
        {
            attempt.Outcome = "rejected";
            attempt.ResponseCode = await ReadResponseCodeAsync(response.Content, token);
            if (response.StatusCode == HttpStatusCode.Conflict)
            {
                attempt.Outcome = "busy";
                return null;
            }
            throw new InvalidOperationException("Cloud export refused the request");
        }
        attempt.Outcome = "invalid_mp4";
        if (attempt.MediaType != "video/mp4" || attempt.ContentBytes is not (>= 32 and <= MaxExportBytes))
            throw new InvalidOperationException("Cloud export did not return a complete MP4");
        var content = await response.Content.ReadAsByteArrayAsync(token);
        if (content.Length != attempt.ContentBytes || content.Length < 32 || !content.AsSpan(4, 4).SequenceEqual("ftyp"u8))
            throw new InvalidOperationException("Cloud export file is incomplete");
        attempt.ContentSha256 = Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant();
        attempt.Outcome = "storage_failed";
        var saved = await storage.SaveAsync(content, "video/mp4", token, "web-hosting", "video", run.Id + ".mp4", ".mp4");
        var key = saved.Key ?? throw new InvalidOperationException("Cloud export did not report a storage key");
        attempt.Outcome = "stored";
        return key;
    }

    private static async Task<string> ReadResponseCodeAsync(HttpContent content, CancellationToken ct)
    {
        if (content.Headers.ContentType?.MediaType != "application/json") return "non_json";
        using var stream = await content.ReadAsStreamAsync(ct);
        var buffer = new byte[4097];
        var size = await stream.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false, cancellationToken: ct);
        if (size == buffer.Length) return "body_too_large";
        try
        {
            using var json = JsonDocument.Parse(buffer.AsMemory(0, size));
            if (json.RootElement.ValueKind != JsonValueKind.Object
                || !json.RootElement.TryGetProperty("error", out var error) || error.ValueKind != JsonValueKind.Object
                || !error.TryGetProperty("code", out var code) || code.ValueKind != JsonValueKind.String)
                return "missing_code";
            return code.GetString() switch
            {
                "export_busy" => "export_busy",
                "export_unavailable" => "export_unavailable",
                "export_failed" => "export_failed",
                "unauthorized" => "unauthorized",
                "api_key_not_configured" => "api_key_not_configured",
                _ => "unrecognized_code",
            };
        }
        catch (JsonException) { return "invalid_json"; }
    }

    private static async Task<bool> DelayAsync(CancellationToken token)
    {
        try { await Task.Delay(Poll, token); return true; }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return false; }
    }
}
