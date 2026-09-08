using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.MdToPpt;

public sealed record HtmlPptPublishResult(
    HostedSite Site,
    HostedSiteRevision Revision,
    string ContentHash);

public sealed class HtmlPptPublishPendingException : Exception
{
    public HtmlPptPublishPendingException(string code, string message) : base(message) => Code = code;
    public string Code { get; }
}

public interface IHtmlPptPublishCoordinator
{
    Task<HtmlPptPublishResult> PublishAsync(
        MdToPptRun run,
        string title,
        string? description,
        IReadOnlyCollection<string> tags,
        IReadOnlyCollection<string> teamIds,
        CancellationToken ct = default);

    Task<int> RecoverPendingAsync(int limit = 50, CancellationToken ct = default);
}

/// <summary>
/// HTML PPT 发布协调器。专用 Run 先持久化发布意图，再以租约 CAS 驱动确定性站点、
/// 真实 HostedSiteRevision 和公共生命周期绑定，进程中断后可从 Run 继续。
/// </summary>
public sealed class HtmlPptPublishCoordinator : IHtmlPptPublishCoordinator
{
    public const string PendingCode = "ppt_publish_pending";
    public const string DeadLetterCode = "ppt_publish_dead_letter";
    public const string BytesMismatchCode = "ppt_published_bytes_mismatch";
    internal const int MaxAttempts = 5;
    internal static readonly TimeSpan LeaseTtl = TimeSpan.FromMinutes(2);

    private readonly MongoDbContext _db;
    private readonly IHostedSiteService _sites;
    private readonly IHostedSiteRevisionService _revisions;
    private readonly IHtmlPptDesignArtifactAdapter _artifacts;
    private readonly ILogger<HtmlPptPublishCoordinator> _logger;

    public HtmlPptPublishCoordinator(
        MongoDbContext db,
        IHostedSiteService sites,
        IHostedSiteRevisionService revisions,
        IHtmlPptDesignArtifactAdapter artifacts,
        ILogger<HtmlPptPublishCoordinator> logger)
    {
        _db = db;
        _sites = sites;
        _revisions = revisions;
        _artifacts = artifacts;
        _logger = logger;
    }

    public async Task<HtmlPptPublishResult> PublishAsync(
        MdToPptRun run,
        string title,
        string? description,
        IReadOnlyCollection<string> tags,
        IReadOnlyCollection<string> teamIds,
        CancellationToken ct = default)
    {
        if (run.Status != "done" || run.Op == "outline" || string.IsNullOrWhiteSpace(run.HtmlHash))
            throw new HtmlPptPublishPendingException("ppt_run_not_ready", "发布来源任务尚未完成");

        var actualHash = Hash(Encoding.UTF8.GetBytes(run.Html ?? string.Empty));
        if (!FixedHashEquals(actualHash, run.HtmlHash))
            throw new HtmlPptPublishPendingException(BytesMismatchCode, "发布来源字节与完成态哈希不一致");

        var intentId = BuildIntentId(run.Id, actualHash);
        run = await EnsureIntentAsync(run, intentId, actualHash, title, description, tags, teamIds);
        return await ExecuteAsync(run, ct);
    }

    public async Task<int> RecoverPendingAsync(int limit = 50, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var runs = await _db.MdToPptRuns.Find(run =>
                run.PublishIntentId != null
                && run.PublishIntentStatus != "completed"
                && run.PublishIntentStatus != "dead-letter"
                && (run.PublishIntentNextAttemptAt == null || run.PublishIntentNextAttemptAt <= now)
                && (run.PublishIntentStatus != "running"
                    || run.PublishIntentLeaseExpiresAt == null
                    || run.PublishIntentLeaseExpiresAt <= now))
            .SortBy(run => run.PublishIntentNextAttemptAt)
            .Limit(Math.Clamp(limit, 1, 200))
            .ToListAsync(ct);

        var recovered = 0;
        foreach (var run in runs)
        {
            try
            {
                await ExecuteAsync(run, CancellationToken.None);
                recovered++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "HTML PPT 发布恢复尚未完成 runId={RunId}", run.Id);
            }
        }
        return recovered;
    }

    private async Task<MdToPptRun> EnsureIntentAsync(
        MdToPptRun run,
        string intentId,
        string htmlHash,
        string title,
        string? description,
        IReadOnlyCollection<string> tags,
        IReadOnlyCollection<string> teamIds)
    {
        if (string.IsNullOrWhiteSpace(run.PublishIntentId))
        {
            var created = await _db.MdToPptRuns.FindOneAndUpdateAsync(
                item => item.Id == run.Id
                        && item.UserId == run.UserId
                        && item.Status == "done"
                        && item.PublishIntentId == null,
                Builders<MdToPptRun>.Update
                    .Set(item => item.PublishIntentId, intentId)
                    .Set(item => item.PublishIntentStatus, "pending")
                    .Set(item => item.PublishIntentHtmlHash, htmlHash)
                    .Set(item => item.PublishIntentTitle, title)
                    .Set(item => item.PublishIntentDescription, description)
                    .Set(item => item.PublishIntentTags, Normalize(tags))
                    .Set(item => item.PublishIntentTeamIds, Normalize(teamIds))
                    .Set(item => item.PublishIntentNextAttemptAt, DateTime.UtcNow)
                    .Set(item => item.ArtifactContractSynchronizedAt, null)
                    .Set(item => item.UpdatedAt, DateTime.UtcNow),
                new FindOneAndUpdateOptions<MdToPptRun, MdToPptRun>
                {
                    ReturnDocument = ReturnDocument.After,
                },
                CancellationToken.None);
            if (created != null) return created;
        }

        var existing = await _db.MdToPptRuns.Find(item => item.Id == run.Id && item.UserId == run.UserId)
            .FirstOrDefaultAsync(CancellationToken.None)
            ?? throw new HtmlPptPublishPendingException("ppt_run_not_found", "发布来源任务不存在");
        if (!string.Equals(existing.PublishIntentId, intentId, StringComparison.Ordinal)
            || !FixedHashEquals(existing.PublishIntentHtmlHash, htmlHash))
            throw new HtmlPptPublishPendingException("ppt_publish_intent_conflict", "该完成态已经建立另一条发布意图");
        return existing;
    }

    private async Task<HtmlPptPublishResult> ExecuteAsync(MdToPptRun run, CancellationToken ct)
    {
        if (run.PublishIntentStatus == "completed") return await LoadCompletedAsync(run, ct);
        if (run.PublishIntentStatus == "dead-letter")
            throw new HtmlPptPublishPendingException(DeadLetterCode, "发布恢复已暂停，需要管理员处理");

        var now = DateTime.UtcNow;
        var owner = Guid.NewGuid().ToString("N");
        var fb = Builders<MdToPptRun>.Filter;
        var claimableState = fb.In(item => item.PublishIntentStatus, ["pending", "retry"])
                             & (fb.Eq(item => item.PublishIntentNextAttemptAt, null)
                                | fb.Lte(item => item.PublishIntentNextAttemptAt, now));
        var staleRunning = fb.Eq(item => item.PublishIntentStatus, "running")
                           & (fb.Eq(item => item.PublishIntentLeaseExpiresAt, null)
                              | fb.Lte(item => item.PublishIntentLeaseExpiresAt, now));
        var claimed = await _db.MdToPptRuns.FindOneAndUpdateAsync(
            fb.Eq(item => item.Id, run.Id)
            & fb.Eq(item => item.PublishIntentId, run.PublishIntentId)
            & fb.Or(claimableState, staleRunning),
            Builders<MdToPptRun>.Update
                .Set(item => item.PublishIntentStatus, "running")
                .Set(item => item.PublishIntentLeaseOwnerId, owner)
                .Set(item => item.PublishIntentLeaseExpiresAt, now.Add(LeaseTtl))
                .Inc(item => item.PublishIntentAttemptCount, 1)
                .Set(item => item.PublishIntentNextAttemptAt, null),
            new FindOneAndUpdateOptions<MdToPptRun, MdToPptRun>
            {
                ReturnDocument = ReturnDocument.After,
            },
            CancellationToken.None);
        if (claimed == null)
        {
            var current = await _db.MdToPptRuns.Find(item => item.Id == run.Id).FirstOrDefaultAsync(ct);
            if (current?.PublishIntentStatus == "completed") return await LoadCompletedAsync(current, ct);
            throw new HtmlPptPublishPendingException(PendingCode, "发布正在由另一个请求处理");
        }

        try
        {
            var htmlBytes = Encoding.UTF8.GetBytes(claimed.Html ?? string.Empty);
            var site = await _sites.CreateFromHtmlIdempotentAsync(
                claimed.UserId,
                htmlBytes,
                "index.html",
                claimed.PublishIntentTitle,
                claimed.PublishIntentDescription,
                null,
                claimed.PublishIntentTags,
                "md-to-ppt",
                claimed.PublishIntentId!,
                CancellationToken.None);

            if (claimed.PublishIntentTeamIds.Count > 0)
            {
                site = await _sites.SetSharedTeamsAsync(
                    site.Id,
                    claimed.UserId,
                    claimed.PublishIntentTeamIds,
                    CancellationToken.None)
                    ?? throw new InvalidOperationException("发布站点团队归属失败");
            }

            var entry = await _sites.GetRevisionEntryHtmlAsync(site.Id, claimed.UserId, CancellationToken.None);
            var actualHash = Hash(Encoding.UTF8.GetBytes(entry.Html));
            if (!FixedHashEquals(actualHash, claimed.PublishIntentHtmlHash)
                || !FixedHashEquals(actualHash, claimed.HtmlHash))
                throw new HtmlPptPublishPendingException(BytesMismatchCode, "最终托管字节与发布意图不一致");

            var revision = await _revisions.EnsureGeneratedSnapshotAsync(
                site.Id,
                claimed.UserId,
                entry,
                DesignArtifactRuntimes.HtmlPptPipeline,
                claimed.Id,
                claimed.KnowledgeReferences.Select(item => item.EntryId).ToArray(),
                CancellationToken.None);
            var pointerWrite = await _db.HostedSites.UpdateOneAsync(
                item => item.Id == site.Id
                        && item.OwnerUserId == claimed.UserId
                        && item.ContentVersion == entry.ContentVersion
                        && (item.PublishedRevisionId == null || item.PublishedRevisionId == revision.Id),
                Builders<HostedSite>.Update.Set(item => item.PublishedRevisionId, revision.Id),
                cancellationToken: CancellationToken.None);
            if (pointerWrite.MatchedCount == 0)
                throw new InvalidOperationException("发布站点版本指针已变化");
            site.PublishedRevisionId = revision.Id;

            var persist = await _db.MdToPptRuns.UpdateOneAsync(
                item => item.Id == claimed.Id
                        && item.PublishIntentId == claimed.PublishIntentId
                        && item.PublishIntentStatus == "running"
                        && item.PublishIntentLeaseOwnerId == owner,
                Builders<MdToPptRun>.Update
                    .Set(item => item.PublishedSiteId, site.Id)
                    .Set(item => item.PublishedVersionId, revision.Id)
                    .Set(item => item.PublishedHtmlHash, actualHash)
                    .Set(item => item.ArtifactContractSynchronizedAt, null)
                    .Set(item => item.UpdatedAt, DateTime.UtcNow),
                cancellationToken: CancellationToken.None);
            if (persist.ModifiedCount != 1)
                throw new HtmlPptPublishPendingException(PendingCode, "发布租约已变化，等待恢复器接管");

            claimed.PublishedSiteId = site.Id;
            claimed.PublishedVersionId = revision.Id;
            claimed.PublishedHtmlHash = actualHash;
            claimed.ArtifactContractSynchronizedAt = null;
            await _artifacts.BindPublishedAsync(claimed, site.Id, revision.Id, CancellationToken.None);

            var completedAt = DateTime.UtcNow;
            var completed = await _db.MdToPptRuns.UpdateOneAsync(
                item => item.Id == claimed.Id
                        && item.PublishIntentId == claimed.PublishIntentId
                        && item.PublishIntentStatus == "running"
                        && item.PublishIntentLeaseOwnerId == owner,
                Builders<MdToPptRun>.Update
                    .Set(item => item.PublishIntentStatus, "completed")
                    .Set(item => item.PublishIntentCompletedAt, completedAt)
                    .Set(item => item.PublishIntentLeaseOwnerId, null)
                    .Set(item => item.PublishIntentLeaseExpiresAt, null)
                    .Set(item => item.PublishIntentLastFailureCode, null)
                    .Set(item => item.PublishIntentNextAttemptAt, null)
                    .Set(item => item.UpdatedAt, completedAt),
                cancellationToken: CancellationToken.None);
            if (completed.ModifiedCount != 1)
                throw new HtmlPptPublishPendingException(PendingCode, "发布结果已保留，完成标记等待恢复");
            return new HtmlPptPublishResult(site, revision, actualHash);
        }
        catch (Exception ex)
        {
            await ScheduleRetryAsync(claimed, owner, StableFailureCode(ex));
            throw;
        }
    }

    private async Task<HtmlPptPublishResult> LoadCompletedAsync(MdToPptRun run, CancellationToken ct)
    {
        var site = await _db.HostedSites.Find(item => item.Id == run.PublishedSiteId && item.OwnerUserId == run.UserId)
            .FirstOrDefaultAsync(ct);
        var revision = await _db.HostedSiteRevisions.Find(item => item.Id == run.PublishedVersionId
                                                                  && item.SiteId == run.PublishedSiteId
                                                                  && item.Status == HostedSiteRevisionStatuses.Published)
            .FirstOrDefaultAsync(ct);
        if (site == null || revision == null || string.IsNullOrWhiteSpace(run.PublishedHtmlHash))
            throw new HtmlPptPublishPendingException(PendingCode, "发布完成记录正在恢复");
        return new HtmlPptPublishResult(site, revision, run.PublishedHtmlHash);
    }

    private async Task ScheduleRetryAsync(MdToPptRun run, string owner, string failureCode)
    {
        var failedAt = DateTime.UtcNow;
        var deadLetter = run.PublishIntentAttemptCount >= MaxAttempts;
        await _db.MdToPptRuns.UpdateOneAsync(
            item => item.Id == run.Id
                    && item.PublishIntentStatus == "running"
                    && item.PublishIntentLeaseOwnerId == owner,
            Builders<MdToPptRun>.Update
                .Set(item => item.PublishIntentStatus, deadLetter ? "dead-letter" : "retry")
                .Set(item => item.PublishIntentLastFailureCode, deadLetter ? DeadLetterCode : failureCode)
                .Set(item => item.PublishIntentNextAttemptAt,
                    deadLetter ? null : failedAt.Add(Backoff(run.PublishIntentAttemptCount)))
                .Set(item => item.PublishIntentLeaseOwnerId, null)
                .Set(item => item.PublishIntentLeaseExpiresAt, null)
                .Set(item => item.UpdatedAt, failedAt),
            cancellationToken: CancellationToken.None);
    }

    internal static string BuildIntentId(string runId, string htmlHash) =>
        Hash(Encoding.UTF8.GetBytes($"{runId.Trim()}\n{htmlHash.Trim().ToLowerInvariant()}"));

    internal static TimeSpan Backoff(int attempt)
    {
        var exponent = Math.Clamp(attempt - 1, 0, 6);
        return TimeSpan.FromSeconds(Math.Min(300, 5 * (1 << exponent)));
    }

    private static string StableFailureCode(Exception ex) => ex switch
    {
        HtmlPptPublishPendingException pending => pending.Code,
        DesignArtifactLifecycleException => "ppt_publish_binding_failed",
        _ => "ppt_publish_failed",
    };

    private static List<string> Normalize(IEnumerable<string> values) => values
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .Select(value => value.Trim())
        .Distinct(StringComparer.Ordinal)
        .ToList();

    private static string Hash(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static bool FixedHashEquals(string? left, string? right)
    {
        if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right)) return false;
        try
        {
            return CryptographicOperations.FixedTimeEquals(
                Convert.FromHexString(left.Trim()),
                Convert.FromHexString(right.Trim()));
        }
        catch (FormatException)
        {
            return false;
        }
    }
}

public sealed class HtmlPptPublishRecoveryWorker : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<HtmlPptPublishRecoveryWorker> _logger;

    public HtmlPptPublishRecoveryWorker(
        IServiceScopeFactory scopeFactory,
        ILogger<HtmlPptPublishRecoveryWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = _scopeFactory.CreateAsyncScope();
                var coordinator = scope.ServiceProvider.GetRequiredService<IHtmlPptPublishCoordinator>();
                await coordinator.RecoverPendingAsync(50, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "HTML PPT 发布恢复轮询失败");
            }

            try
            {
                await Task.Delay(Interval, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
        }
    }
}
