using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Services;

public sealed class QuickCreationExportWorker(IServiceScopeFactory scopes, IHttpClientFactory http,
    IConfiguration config, ILogger<QuickCreationExportWorker> logger) : BackgroundService
{
    private const int MaxExportBytes = 192 * 1024 * 1024;
    private static readonly TimeSpan LeaseTime = TimeSpan.FromMinutes(50);
    private static readonly TimeSpan Poll = TimeSpan.FromSeconds(4);

    internal static FilterDefinition<DesignArtifactRun> Scope
        => DesignArtifactTimingStats.ScopeFilter(DeploymentScope.CurrentDurable);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (await DelayAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
                var now = DateTime.UtcNow;
                var claim = Guid.NewGuid().ToString("N");
                var filter = Builders<DesignArtifactRun>.Filter;
                var updates = Builders<DesignArtifactRun>.Update;
                var run = await db.DesignArtifactRuns.FindOneAndUpdateAsync(Scope &
                    (filter.Eq(row => row.BrowserFilmExport!.Status, "queued")
                     | (filter.Eq(row => row.BrowserFilmExport!.Status, "running")
                         & filter.Lte(row => row.BrowserFilmExport!.ExpiresAt, now))),
                    updates.Set(row => row.BrowserFilmExport!.Status, "running")
                        .Set(row => row.BrowserFilmExport!.Lease, claim)
                        .Set(row => row.BrowserFilmExport!.ExpiresAt, now.Add(LeaseTime)),
                    new FindOneAndUpdateOptions<DesignArtifactRun>
                    {
                        ReturnDocument = ReturnDocument.After,
                        Sort = Builders<DesignArtifactRun>.Sort.Ascending(row => row.BrowserFilmExport!.QueuedAt),
                    }, stoppingToken);
                if (run == null) continue;
                var owned = filter.Eq(row => row.Id, run.Id) & filter.Eq(row => row.BrowserFilmExport!.Lease, claim);
                try
                {
                    var key = await ExportAsync(run, scope.ServiceProvider, stoppingToken);
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
                    await db.DesignArtifactRuns.UpdateOneAsync(owned,
                        updates.Set(row => row.BrowserFilmExport!.Status, state)
                            .Set(row => row.BrowserFilmExport!.AssetKey, key)
                            .Set(row => row.BrowserFilmExport!.Error, error)
                            .Set(row => row.BrowserFilmExport!.Lease, null)
                            .Set(row => row.BrowserFilmExport!.ExpiresAt, null), cancellationToken: deadline.Token);
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
        }
    }

    private async Task<string?> ExportAsync(DesignArtifactRun run, IServiceProvider scope, CancellationToken ct)
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
        using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        if (response.StatusCode == HttpStatusCode.Conflict) return null;
        if (!response.IsSuccessStatusCode || response.Content.Headers.ContentType?.MediaType != "video/mp4"
            || response.Content.Headers.ContentLength is not (>= 32 and <= MaxExportBytes))
        {
            logger.LogWarning("OpenDesign film export response run={RunId} status={Status}", run.Id, (int)response.StatusCode);
            throw new InvalidOperationException("Cloud export did not return a complete MP4");
        }
        var content = await response.Content.ReadAsByteArrayAsync(token);
        if (content.Length != response.Content.Headers.ContentLength || content.Length < 32 || !content.AsSpan(4, 4).SequenceEqual("ftyp"u8))
            throw new InvalidOperationException("Cloud export file is incomplete");
        var saved = await storage.SaveAsync(content, "video/mp4", token, "web-hosting", "video", run.Id + ".mp4", ".mp4");
        return saved.Key ?? throw new InvalidOperationException("Cloud export did not report a storage key");
    }

    private static async Task<bool> DelayAsync(CancellationToken token)
    {
        try { await Task.Delay(Poll, token); return true; }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { return false; }
    }
}
