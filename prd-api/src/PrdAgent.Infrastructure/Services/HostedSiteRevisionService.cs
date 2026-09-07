using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 站点入口 HTML 的草稿与发布版本服务。
/// 历史版本只追加；回退的语义是“用旧内容发布一个新版本”。
/// </summary>
public sealed class HostedSiteRevisionService : IHostedSiteRevisionService
{
    internal static readonly TimeSpan PublishAttemptTtl = TimeSpan.FromMinutes(2);
    private readonly MongoDbContext _db;
    private readonly IHostedSiteService _sites;

    public HostedSiteRevisionService(MongoDbContext db, IHostedSiteService sites)
    {
        _db = db;
        _sites = sites;
    }

    public Task<HostedSiteRevision> EnsureCurrentSnapshotAsync(
        string siteId,
        string userId,
        HostedSiteEditableEntry? knownEntry = null,
        CancellationToken ct = default) =>
        EnsureSnapshotAsync(siteId, userId, knownEntry, [], null, null, null, ct);

    public Task<HostedSiteRevision> EnsureGeneratedSnapshotAsync(
        string siteId,
        string userId,
        HostedSiteEditableEntry knownEntry,
        string runtime,
        string sourceRunId,
        IReadOnlyCollection<string> knowledgeEntryIds,
        CancellationToken ct = default) =>
        EnsureSnapshotAsync(siteId, userId, knownEntry, [], runtime, sourceRunId, knowledgeEntryIds, ct);

    public Task<HostedSiteRevision> EnsureGeneratedVerifiedSnapshotAsync(
        string siteId,
        string userId,
        HostedSiteEditableEntry knownEntry,
        IReadOnlyList<HostedSiteVerifiedFile> files,
        string runtime,
        string sourceRunId,
        IReadOnlyCollection<string> knowledgeEntryIds,
        CancellationToken ct = default) =>
        EnsureSnapshotAsync(siteId, userId, knownEntry, files, runtime, sourceRunId, knowledgeEntryIds, ct);

    private async Task<HostedSiteRevision> EnsureSnapshotAsync(
        string siteId,
        string userId,
        HostedSiteEditableEntry? knownEntry,
        IReadOnlyList<HostedSiteVerifiedFile> verifiedFiles,
        string? runtime,
        string? sourceRunId,
        IReadOnlyCollection<string>? knowledgeEntryIds,
        CancellationToken ct)
    {
        var entry = knownEntry ?? await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        await ReconcileActivePublicationAsync(entry.Site.PublishedRevisionId, entry.ContentVersion);
        var existing = await _db.HostedSiteRevisions
            .Find(x => x.SiteId == siteId
                       && x.Status == HostedSiteRevisionStatuses.Published
                       && x.PublishedContentVersion == entry.ContentVersion)
            .FirstOrDefaultAsync(ct);
        if (existing != null) return existing;

        var baseline = new HostedSiteRevision
        {
            Id = $"baseline_{siteId}_{entry.ContentVersion.Ticks}",
            SiteId = siteId,
            CreatedByUserId = userId,
            Status = HostedSiteRevisionStatuses.Published,
            Source = HostedSiteRevisionSources.Baseline,
            SourceRunId = string.IsNullOrWhiteSpace(sourceRunId) ? null : sourceRunId.Trim(),
            Runtime = string.IsNullOrWhiteSpace(runtime) ? HostedSiteEditRuntimes.MapGateway : runtime.Trim(),
            KnowledgeEntryIds = (knowledgeEntryIds ?? Array.Empty<string>())
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.Trim())
                .Distinct(StringComparer.Ordinal)
                .ToList(),
            Html = entry.Html,
            VerifiedFiles = verifiedFiles.Select(file => new HostedSiteRevisionFile
            {
                Path = file.Path,
                Content = file.Content.ToArray(),
                Sha256 = file.Sha256,
                MimeType = file.MimeType,
            }).ToList(),
            BasedOnContentVersion = entry.ContentVersion,
            PublishedContentVersion = entry.ContentVersion,
            CreatedAt = entry.ContentVersion,
            PublishedAt = entry.ContentVersion,
        };

        try
        {
            await _db.HostedSiteRevisions.InsertOneAsync(baseline, cancellationToken: ct);
            return baseline;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return await _db.HostedSiteRevisions.Find(x => x.Id == baseline.Id).FirstAsync(ct);
        }
    }

    public async Task<HostedSiteRevision> CreateDraftAsync(
        string siteId,
        string userId,
        string html,
        string instruction,
        string runtime,
        string runId,
        string parentRevisionId,
        IReadOnlyCollection<string> knowledgeEntryIds,
        DateTime basedOnContentVersion,
        CancellationToken ct = default)
        => await CreateDraftCoreAsync(
            siteId, userId, html, [], instruction, runtime, runId, parentRevisionId,
            knowledgeEntryIds, basedOnContentVersion, ct);

    public async Task<HostedSiteRevision> CreateVerifiedDraftAsync(
        string siteId,
        string userId,
        string html,
        IReadOnlyList<HostedSiteVerifiedFile> files,
        string instruction,
        string runtime,
        string runId,
        string parentRevisionId,
        IReadOnlyCollection<string> knowledgeEntryIds,
        DateTime basedOnContentVersion,
        CancellationToken ct = default)
        => await CreateDraftCoreAsync(
            siteId, userId, html, files, instruction, runtime, runId, parentRevisionId,
            knowledgeEntryIds, basedOnContentVersion, ct);

    private async Task<HostedSiteRevision> CreateDraftCoreAsync(
        string siteId,
        string userId,
        string html,
        IReadOnlyList<HostedSiteVerifiedFile> files,
        string instruction,
        string runtime,
        string runId,
        string parentRevisionId,
        IReadOnlyCollection<string> knowledgeEntryIds,
        DateTime basedOnContentVersion,
        CancellationToken ct)
    {
        HostedSiteRevisionRules.ValidateHtml(html);
        var current = await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        if (current.ContentVersion != basedOnContentVersion)
            throw new InvalidOperationException("站点在生成期间已经发生变化，请基于最新版本重新修改");

        var draft = new HostedSiteRevision
        {
            SiteId = siteId,
            CreatedByUserId = userId,
            Status = HostedSiteRevisionStatuses.Draft,
            Source = HostedSiteRevisionSources.AiEdit,
            ParentRevisionId = parentRevisionId,
            SourceRunId = runId,
            Instruction = instruction,
            Runtime = runtime,
            KnowledgeEntryIds = knowledgeEntryIds
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Distinct(StringComparer.Ordinal)
                .ToList(),
            Html = html,
            VerifiedFiles = files.Select(file => new HostedSiteRevisionFile
            {
                Path = file.Path,
                Content = file.Content.ToArray(),
                Sha256 = file.Sha256,
                MimeType = file.MimeType,
            }).ToList(),
            BasedOnContentVersion = basedOnContentVersion,
            CreatedAt = DateTime.UtcNow,
        };
        await _db.HostedSiteRevisions.InsertOneAsync(draft, cancellationToken: ct);
        return draft;
    }

    public async Task<bool> CompensateUnpublishedDraftAsync(
        string siteId,
        string runId,
        string userId,
        string? revisionId = null,
        CancellationToken ct = default)
    {
        var fb = Builders<HostedSiteRevision>.Filter;
        var filter = fb.Eq(x => x.SiteId, siteId)
                     & fb.Eq(x => x.SourceRunId, runId)
                     & fb.Eq(x => x.CreatedByUserId, userId)
                     & fb.Eq(x => x.Status, HostedSiteRevisionStatuses.Draft)
                     & fb.Eq(x => x.PublishedAt, null)
                     & fb.Eq(x => x.PublishedContentVersion, null);
        if (!string.IsNullOrWhiteSpace(revisionId))
            filter &= fb.Eq(x => x.Id, revisionId);
        var result = await _db.HostedSiteRevisions.DeleteManyAsync(filter, ct);
        return result.DeletedCount > 0;
    }

    public async Task<IReadOnlyList<HostedSiteRevision>> ListAsync(
        string siteId,
        string userId,
        CancellationToken ct = default)
    {
        var entry = await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        await ReconcileActivePublicationAsync(entry.Site.PublishedRevisionId, entry.ContentVersion);
        return await _db.HostedSiteRevisions
            .Find(x => x.SiteId == siteId)
            .SortByDescending(x => x.CreatedAt)
            .Limit(100)
            .ToListAsync(ct);
    }

    public async Task<HostedSiteRevision?> GetAsync(
        string siteId,
        string revisionId,
        string userId,
        CancellationToken ct = default)
    {
        var entry = await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        await ReconcileActivePublicationAsync(entry.Site.PublishedRevisionId, entry.ContentVersion);
        return await _db.HostedSiteRevisions
            .Find(x => x.Id == revisionId && x.SiteId == siteId)
            .FirstOrDefaultAsync(ct);
    }

    public async Task<HostedSiteRevisionMutationResult> PublishAsync(
        string siteId,
        string revisionId,
        string userId,
        CancellationToken ct = default)
    {
        var draft = await GetAsync(siteId, revisionId, userId, ct)
            ?? throw new KeyNotFoundException("版本不存在");
        var current = await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        if (draft.Status == HostedSiteRevisionStatuses.Published
            && current.Site.PublishedRevisionId == draft.Id)
            return new HostedSiteRevisionMutationResult(draft, current.Site, false);
        if (draft.Status is not (HostedSiteRevisionStatuses.Draft or HostedSiteRevisionStatuses.Publishing))
            throw new InvalidOperationException("只有草稿可以发布");

        if (draft.Status == HostedSiteRevisionStatuses.Publishing)
        {
            // 上一次调用可能已经切换站点指针，只在账本最终写入时失败。
            if (current.Site.PublishedRevisionId == draft.Id)
            {
                var recovered = await FinalizePublishedRevisionAsync(draft, current.ContentVersion, draft.PublishAttemptId);
                return new HostedSiteRevisionMutationResult(recovered, current.Site, false);
            }

            var staleBefore = DateTime.UtcNow - PublishAttemptTtl;
            if (draft.PublishAttemptStartedAt.HasValue && draft.PublishAttemptStartedAt > staleBefore)
                throw new InvalidOperationException("该草稿正在由另一个请求发布，请稍后刷新");
            if (!await TryResetPublishingAttemptAsync(
                    _db,
                    draft.Id,
                    draft.PublishAttemptId,
                    CancellationToken.None))
            {
                draft = await _db.HostedSiteRevisions.Find(x => x.Id == draft.Id).FirstAsync(CancellationToken.None);
                if (draft.Status == HostedSiteRevisionStatuses.Published
                    && current.Site.PublishedRevisionId == draft.Id)
                    return new HostedSiteRevisionMutationResult(draft, current.Site, false);
                throw new InvalidOperationException("该草稿的发布状态已经发生变化，请刷新后重试");
            }
            draft.Status = HostedSiteRevisionStatuses.Draft;
            draft.PublishAttemptId = null;
            draft.PublishAttemptStartedAt = null;
        }

        if (current.ContentVersion != draft.BasedOnContentVersion)
            throw new InvalidOperationException("站点在发布时已经发生变化，请刷新后重试");
        await EnsureCurrentSnapshotAsync(siteId, userId, current, ct);

        var attemptId = Guid.NewGuid().ToString("N");
        var attemptStartedAt = DateTime.UtcNow;
        var claimed = await _db.HostedSiteRevisions.UpdateOneAsync(
            x => x.Id == draft.Id && x.Status == HostedSiteRevisionStatuses.Draft,
            Builders<HostedSiteRevision>.Update
                .Set(x => x.Status, HostedSiteRevisionStatuses.Publishing)
                .Set(x => x.PublishAttemptId, attemptId)
                .Set(x => x.PublishAttemptStartedAt, attemptStartedAt)
                .Set(x => x.LastPublishFailureCode, null)
                .Set(x => x.LastPublishFailedAt, null),
            cancellationToken: CancellationToken.None);
        if (claimed.ModifiedCount == 0)
            throw new InvalidOperationException("该草稿正在由另一个请求发布，请稍后刷新");

        HostedSite site;
        try
        {
            site = draft.VerifiedFiles.Count > 0
                ? await _sites.ReplaceWithVerifiedFilesAsync(
                    siteId,
                    userId,
                    draft.VerifiedFiles.Select(file => new HostedSiteVerifiedFile(
                        file.Path,
                        file.Content,
                        file.Sha256,
                        file.MimeType)).ToArray(),
                    draft.BasedOnContentVersion,
                    draft.Id,
                    CancellationToken.None)
                : await _sites.ReplaceEntryHtmlAsync(
                    siteId,
                    userId,
                    draft.Html,
                    draft.BasedOnContentVersion,
                    draft.Id,
                    CancellationToken.None);
        }
        catch
        {
            // 上传或站点 CAS 抛错时先重读地面真值：响应丢失不等于写入失败。
            // 指针命中就补写账本；未命中才按当前 attempt 回退，旧请求不能解锁新请求。
            try
            {
                var afterFailure = await _sites.GetEditableEntryHtmlAsync(siteId, userId, CancellationToken.None);
                if (afterFailure.Site.PublishedRevisionId == draft.Id)
                {
                    var recovered = await FinalizePublishedRevisionAsync(draft, afterFailure.ContentVersion, attemptId);
                    return new HostedSiteRevisionMutationResult(recovered, afterFailure.Site, true);
                }
                await TryResetPublishingAttemptAsync(
                    _db,
                    draft.Id,
                    attemptId,
                    CancellationToken.None,
                    draft.Source == HostedSiteRevisionSources.Rollback
                        ? "rollback_publish_failed"
                        : "publish_failed",
                    DateTime.UtcNow);
            }
            catch
            {
                // 无法确认站点是否已切换时保留 publishing，后续请求会按发布指针恢复，不能猜测回滚。
                try
                {
                    await TryMarkPublishingFailureAsync(
                        _db,
                        draft.Id,
                        attemptId,
                        draft.Source == HostedSiteRevisionSources.Rollback
                            ? "rollback_publish_state_unknown"
                            : "publish_state_unknown",
                        DateTime.UtcNow,
                        CancellationToken.None);
                }
                catch
                {
                    // 审计补写失败不能覆盖原始发布异常；publishing 围栏仍允许后续请求按地面真值恢复。
                }
            }
            throw;
        }

        return new HostedSiteRevisionMutationResult(
            await FinalizePublishedRevisionAsync(draft, site.ContentVersion, attemptId),
            site,
            true);
    }

    public async Task<HostedSiteRevisionMutationResult> RollbackAsync(
        string siteId,
        string revisionId,
        string userId,
        string idempotencyKey,
        CancellationToken ct = default)
    {
        var normalizedKey = NormalizeIdempotencyKey(idempotencyKey);
        var target = await GetAsync(siteId, revisionId, userId, ct)
            ?? throw new KeyNotFoundException("版本不存在");
        if (target.Status != HostedSiteRevisionStatuses.Published)
            throw new InvalidOperationException("只能回退到已经发布的版本");

        var current = await _sites.GetEditableEntryHtmlAsync(siteId, userId, ct);
        var existing = await _db.HostedSiteRevisions.Find(item =>
                item.SiteId == siteId
                && item.CreatedByUserId == userId
                && item.RollbackIdempotencyKey == normalizedKey)
            .FirstOrDefaultAsync(ct);
        if (existing != null)
        {
            if (existing.RollbackTargetRevisionId != target.Id)
                throw new InvalidOperationException("同一幂等键不能用于不同回退目标");
            return await ReplayRollbackAsync(siteId, userId, target.Id, existing, current, reportChange: false);
        }

        var parent = await EnsureCurrentSnapshotAsync(siteId, userId, current, ct);
        var rollback = new HostedSiteRevision
        {
            SiteId = siteId,
            CreatedByUserId = userId,
            Status = HostedSiteRevisionStatuses.Draft,
            Source = HostedSiteRevisionSources.Rollback,
            ParentRevisionId = parent.Id,
            RollbackTargetRevisionId = target.Id,
            RollbackIdempotencyKey = normalizedKey,
            Instruction = $"回退到 {target.Id}",
            // 回退是版本账本操作，不伪装成再次调用了原始 AI 执行器。
            // ParentRevisionId 仍可追溯到内容真正来自哪个历史版本。
            Runtime = HostedSiteEditRuntimes.Manual,
            KnowledgeEntryIds = target.KnowledgeEntryIds,
            Html = target.Html,
            VerifiedFiles = target.VerifiedFiles.Select(file => new HostedSiteRevisionFile
            {
                Path = file.Path,
                Content = file.Content.ToArray(),
                Sha256 = file.Sha256,
                MimeType = file.MimeType,
            }).ToList(),
            BasedOnContentVersion = current.ContentVersion,
            CreatedAt = DateTime.UtcNow,
        };
        try
        {
            await _db.HostedSiteRevisions.InsertOneAsync(rollback, cancellationToken: CancellationToken.None);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            var winner = await _db.HostedSiteRevisions.Find(item =>
                    item.SiteId == siteId
                    && item.CreatedByUserId == userId
                    && item.RollbackIdempotencyKey == normalizedKey)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (winner == null) throw;
            if (winner.RollbackTargetRevisionId != target.Id)
                throw new InvalidOperationException("同一幂等键不能用于不同回退目标");
            var latest = await _sites.GetEditableEntryHtmlAsync(siteId, userId, CancellationToken.None);
            return await ReplayRollbackAsync(siteId, userId, target.Id, winner, latest, reportChange: false);
        }
        return await ReplayRollbackAsync(siteId, userId, target.Id, rollback, current, reportChange: true);
    }

    private async Task<HostedSiteRevisionMutationResult> ReplayRollbackAsync(
        string siteId,
        string userId,
        string targetRevisionId,
        HostedSiteRevision initial,
        HostedSiteEditableEntry initialSite,
        bool reportChange)
    {
        var revision = initial;
        var current = initialSite;
        for (var attempt = 0; attempt < 40; attempt++)
        {
            if (revision.RollbackTargetRevisionId != targetRevisionId)
                throw new InvalidOperationException("同一幂等键不能用于不同回退目标");
            if (revision.Status == HostedSiteRevisionStatuses.Published)
                return new HostedSiteRevisionMutationResult(revision, current.Site, reportChange);
            if (revision.Status == HostedSiteRevisionStatuses.Draft
                || revision.Status == HostedSiteRevisionStatuses.Publishing
                   && current.Site.PublishedRevisionId == revision.Id)
            {
                try
                {
                    var result = await PublishAsync(siteId, revision.Id, userId, CancellationToken.None);
                    return result with { Changed = reportChange && result.Changed };
                }
                catch (InvalidOperationException) when (attempt < 39)
                {
                    // 同 key 并发调用可能由另一个请求先取得发布围栏；重读同一事实，不新建版本。
                }
            }

            await Task.Delay(50, CancellationToken.None);
            revision = await _db.HostedSiteRevisions.Find(item => item.Id == revision.Id)
                .FirstOrDefaultAsync(CancellationToken.None)
                ?? throw new KeyNotFoundException("版本不存在");
            current = await _sites.GetEditableEntryHtmlAsync(siteId, userId, CancellationToken.None);
        }
        throw new InvalidOperationException("同一回退请求正在处理，请稍后重试");
    }

    public async Task<(HostedSiteRevision Revision, bool Changed)> RejectAsync(
        string siteId,
        string revisionId,
        string userId,
        string? reason,
        CancellationToken ct = default)
    {
        var normalizedReason = HostedSiteRevisionRules.NormalizeRejectionReason(reason);
        var revision = await GetAsync(siteId, revisionId, userId, ct)
            ?? throw new KeyNotFoundException("版本不存在");
        if (revision.Status == HostedSiteRevisionStatuses.Rejected)
            return (revision, false);
        if (revision.Status != HostedSiteRevisionStatuses.Draft)
            throw new InvalidOperationException("只有草稿可以拒绝");

        var rejectedAt = DateTime.UtcNow;
        var write = await _db.HostedSiteRevisions.UpdateOneAsync(
            x => x.Id == revision.Id
                 && x.SiteId == siteId
                 && x.Status == HostedSiteRevisionStatuses.Draft,
            Builders<HostedSiteRevision>.Update
                .Set(x => x.Status, HostedSiteRevisionStatuses.Rejected)
                .Set(x => x.RejectedAt, rejectedAt)
                .Set(x => x.RejectedByUserId, userId)
                .Set(x => x.RejectionReason, normalizedReason),
            cancellationToken: CancellationToken.None);
        if (write.ModifiedCount == 1)
        {
            revision.Status = HostedSiteRevisionStatuses.Rejected;
            revision.RejectedAt = rejectedAt;
            revision.RejectedByUserId = userId;
            revision.RejectionReason = normalizedReason;
            return (revision, true);
        }

        var persisted = await _db.HostedSiteRevisions
            .Find(x => x.Id == revision.Id && x.SiteId == siteId)
            .FirstOrDefaultAsync(CancellationToken.None)
            ?? throw new KeyNotFoundException("版本不存在");
        if (persisted.Status == HostedSiteRevisionStatuses.Rejected)
            return (persisted, false);
        throw new InvalidOperationException("该草稿的状态已经发生变化，请刷新后重试");
    }

    private async Task ReconcileActivePublicationAsync(string? revisionId, DateTime contentVersion)
    {
        if (string.IsNullOrWhiteSpace(revisionId)) return;
        await _db.HostedSiteRevisions.UpdateOneAsync(
            x => x.Id == revisionId && x.Status == HostedSiteRevisionStatuses.Publishing,
            Builders<HostedSiteRevision>.Update
                .Set(x => x.Status, HostedSiteRevisionStatuses.Published)
                .Set(x => x.PublishedAt, DateTime.UtcNow)
                .Set(x => x.PublishedContentVersion, contentVersion)
                .Set(x => x.PublishAttemptId, null)
                .Set(x => x.PublishAttemptStartedAt, null),
            cancellationToken: CancellationToken.None);
    }

    internal async Task<HostedSiteRevision> FinalizePublishedRevisionAsync(
        HostedSiteRevision revision,
        DateTime contentVersion,
        string? attemptId)
    {
        var publishedAt = DateTime.UtcNow;
        await _db.HostedSiteRevisions.UpdateOneAsync(
            x => x.Id == revision.Id
                 && x.Status == HostedSiteRevisionStatuses.Publishing
                 && x.PublishAttemptId == attemptId,
            Builders<HostedSiteRevision>.Update
                .Set(x => x.Status, HostedSiteRevisionStatuses.Published)
                .Set(x => x.PublishedAt, publishedAt)
                .Set(x => x.PublishedContentVersion, contentVersion)
                .Set(x => x.PublishAttemptId, null)
                .Set(x => x.PublishAttemptStartedAt, null),
            cancellationToken: CancellationToken.None);

        var persisted = await _db.HostedSiteRevisions.Find(x => x.Id == revision.Id)
            .FirstOrDefaultAsync(CancellationToken.None)
            ?? throw new KeyNotFoundException("版本不存在");
        if (persisted.Status != HostedSiteRevisionStatuses.Published
            || persisted.PublishedContentVersion != contentVersion)
            throw new InvalidOperationException("站点内容已写入，版本账本正在恢复，请重试发布");
        return persisted;
    }

    internal static string NormalizeIdempotencyKey(string? value)
    {
        var normalized = value?.Trim() ?? string.Empty;
        if (normalized.Length is < 8 or > 128
            || normalized.Any(character => character < 0x21 || character > 0x7e))
            throw new InvalidOperationException("Idempotency-Key 必须是 8 到 128 个可见 ASCII 字符");
        return normalized;
    }

    internal static async Task<bool> TryResetPublishingAttemptAsync(
        MongoDbContext db,
        string revisionId,
        string? attemptId,
        CancellationToken ct,
        string? failureCode = null,
        DateTime? failedAt = null)
    {
        var update = Builders<HostedSiteRevision>.Update
            .Set(x => x.Status, HostedSiteRevisionStatuses.Draft)
            .Set(x => x.PublishAttemptId, null)
            .Set(x => x.PublishAttemptStartedAt, null);
        if (!string.IsNullOrWhiteSpace(failureCode))
        {
            update = update
                .Set(x => x.LastPublishFailureCode, failureCode)
                .Set(x => x.LastPublishFailedAt, failedAt ?? DateTime.UtcNow);
        }
        var write = await db.HostedSiteRevisions.UpdateOneAsync(
            x => x.Id == revisionId
                 && x.Status == HostedSiteRevisionStatuses.Publishing
                 && x.PublishAttemptId == attemptId,
            update,
            cancellationToken: ct);
        return write.ModifiedCount == 1;
    }

    internal static async Task<bool> TryMarkPublishingFailureAsync(
        MongoDbContext db,
        string revisionId,
        string? attemptId,
        string failureCode,
        DateTime failedAt,
        CancellationToken ct)
    {
        var write = await db.HostedSiteRevisions.UpdateOneAsync(
            x => x.Id == revisionId
                 && x.Status == HostedSiteRevisionStatuses.Publishing
                 && x.PublishAttemptId == attemptId,
            Builders<HostedSiteRevision>.Update
                .Set(x => x.LastPublishFailureCode, failureCode)
                .Set(x => x.LastPublishFailedAt, failedAt),
            cancellationToken: ct);
        return write.ModifiedCount == 1;
    }

}
