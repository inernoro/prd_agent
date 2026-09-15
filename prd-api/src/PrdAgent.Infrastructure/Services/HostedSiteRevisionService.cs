using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

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
    private readonly IAssetStorage? _storage;

    public HostedSiteRevisionService(MongoDbContext db, IHostedSiteService sites)
        : this(db, sites, null)
    {
    }

    public HostedSiteRevisionService(
        MongoDbContext db,
        IHostedSiteService sites,
        IAssetStorage? storage)
    {
        _db = db;
        _sites = sites;
        _storage = storage;
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
        if (!string.Equals(entry.Site.Id, siteId, StringComparison.Ordinal))
            throw new InvalidOperationException("站点快照与请求归属不一致");
        await ReconcileActivePublicationAsync(entry.Site.PublishedRevisionId, entry.ContentVersion);
        var existing = await _db.HostedSiteRevisions
            .Find(x => x.SiteId == siteId
                       && x.Status == HostedSiteRevisionStatuses.Published
                       && x.PublishedContentVersion == entry.ContentVersion)
            .FirstOrDefaultAsync(ct);
        if (existing != null)
            return await ResolveExistingSnapshotAsync(
                existing,
                entry,
                userId,
                verifiedFiles,
                runtime,
                sourceRunId,
                knowledgeEntryIds,
                ct);

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
            // 记下建档那一刻线上站点是什么形态。多文件站点的旁挂对象（CSS、图片）不在这条
            // 版本里，日后回退时必须拦住，而那时站点早已变样、看当时的形态是唯一可靠来源。
            CapturedContentShape = HasUncapturedSidecars(entry.Site)
                ? HostedSiteContentShapes.MultiFile
                : HostedSiteContentShapes.SelfContainedHtml,
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
            var winner = await _db.HostedSiteRevisions.Find(x => x.Id == baseline.Id).FirstAsync(ct);
            return await ResolveExistingSnapshotAsync(
                winner,
                entry,
                userId,
                verifiedFiles,
                runtime,
                sourceRunId,
                knowledgeEntryIds,
                ct);
        }
    }

    private async Task<HostedSiteRevision> ResolveExistingSnapshotAsync(
        HostedSiteRevision existing,
        HostedSiteEditableEntry entry,
        string userId,
        IReadOnlyList<HostedSiteVerifiedFile> verifiedFiles,
        string? runtime,
        string? sourceRunId,
        IReadOnlyCollection<string>? knowledgeEntryIds,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(sourceRunId)) return existing;

        var expectedRunId = sourceRunId.Trim();
        var expectedRuntime = string.IsNullOrWhiteSpace(runtime)
            ? throw new InvalidOperationException("生成版本缺少运行时来源")
            : runtime.Trim();
        var expectedKnowledge = NormalizeKnowledgeEntryIds(knowledgeEntryIds);
        var canPopulateVerifiedFiles = string.IsNullOrWhiteSpace(existing.SourceRunId)
                                       && existing.VerifiedFiles.Count == 0
                                       && verifiedFiles.Count > 0;
        if (canPopulateVerifiedFiles)
            await ValidateHostedSitePackageAsync(
                entry,
                userId,
                expectedRunId,
                expectedRuntime,
                verifiedFiles,
                ct);
        ValidateGeneratedSnapshotIdentity(
            existing,
            entry,
            userId,
            verifiedFiles,
            expectedRuntime,
            expectedRunId,
            expectedKnowledge,
            allowMissingVerifiedFiles: canPopulateVerifiedFiles);
        if (string.Equals(existing.SourceRunId, expectedRunId, StringComparison.Ordinal))
            return existing;

        var claimFilter = Builders<HostedSiteRevision>.Filter.And(
            Builders<HostedSiteRevision>.Filter.Eq(revision => revision.Id, existing.Id),
            Builders<HostedSiteRevision>.Filter.Eq(revision => revision.SiteId, entry.Site.Id),
            Builders<HostedSiteRevision>.Filter.Eq(revision => revision.CreatedByUserId, userId),
            Builders<HostedSiteRevision>.Filter.Eq(revision => revision.Status, HostedSiteRevisionStatuses.Published),
            Builders<HostedSiteRevision>.Filter.Eq(revision => revision.Source, HostedSiteRevisionSources.Baseline),
            Builders<HostedSiteRevision>.Filter.Eq(revision => revision.SourceRunId, null),
            Builders<HostedSiteRevision>.Filter.Eq(revision => revision.Runtime, existing.Runtime),
            Builders<HostedSiteRevision>.Filter.Eq(revision => revision.Html, existing.Html),
            Builders<HostedSiteRevision>.Filter.Eq(revision => revision.BasedOnContentVersion, entry.ContentVersion),
            Builders<HostedSiteRevision>.Filter.Eq(revision => revision.PublishedContentVersion, entry.ContentVersion));
        if (canPopulateVerifiedFiles)
            claimFilter &= Builders<HostedSiteRevision>.Filter.Size(revision => revision.VerifiedFiles, 0);
        var claimUpdate = Builders<HostedSiteRevision>.Update
            .Set(revision => revision.SourceRunId, expectedRunId)
            .Set(revision => revision.Runtime, expectedRuntime)
            .Set(revision => revision.KnowledgeEntryIds, expectedKnowledge);
        if (canPopulateVerifiedFiles)
            claimUpdate = claimUpdate.Set(
                revision => revision.VerifiedFiles,
                verifiedFiles.Select(ToRevisionFile).ToList());
        var claimed = await _db.HostedSiteRevisions.FindOneAndUpdateAsync(
            claimFilter,
            claimUpdate,
            new FindOneAndUpdateOptions<HostedSiteRevision, HostedSiteRevision>
            {
                ReturnDocument = ReturnDocument.After,
            },
            ct);
        if (claimed != null) return claimed;

        var winner = await _db.HostedSiteRevisions.Find(revision => revision.Id == existing.Id)
            .FirstAsync(ct);
        ValidateGeneratedSnapshotIdentity(
            winner,
            entry,
            userId,
            verifiedFiles,
            expectedRuntime,
            expectedRunId,
            expectedKnowledge,
            allowMissingVerifiedFiles: false);
        if (!string.Equals(winner.SourceRunId, expectedRunId, StringComparison.Ordinal))
            throw new InvalidOperationException("该站点版本已经归属于另一生成任务");
        return winner;
    }

    private static void ValidateGeneratedSnapshotIdentity(
        HostedSiteRevision existing,
        HostedSiteEditableEntry entry,
        string userId,
        IReadOnlyList<HostedSiteVerifiedFile> verifiedFiles,
        string expectedRuntime,
        string expectedRunId,
        IReadOnlyList<string> expectedKnowledge,
        bool allowMissingVerifiedFiles = false)
    {
        if (!string.Equals(existing.SiteId, entry.Site.Id, StringComparison.Ordinal)
            || !string.Equals(existing.CreatedByUserId, userId, StringComparison.Ordinal)
            || existing.Status != HostedSiteRevisionStatuses.Published
            || existing.Source != HostedSiteRevisionSources.Baseline
            || existing.BasedOnContentVersion != entry.ContentVersion
            || existing.PublishedContentVersion != entry.ContentVersion)
            throw new InvalidOperationException("现有站点版本与生成任务归属不一致");
        if (!SameContentHash(existing.Html, entry.Html))
            throw new InvalidOperationException("现有站点版本与生成结果哈希不一致");
        if (!allowMissingVerifiedFiles && !VerifiedFilesMatch(existing.VerifiedFiles, verifiedFiles))
            throw new InvalidOperationException("现有站点版本与已验证文件不一致");
        if (!string.IsNullOrWhiteSpace(existing.SourceRunId)
            && !string.Equals(existing.SourceRunId, expectedRunId, StringComparison.Ordinal))
            throw new InvalidOperationException("该站点版本已经归属于另一生成任务");
        if (string.Equals(existing.SourceRunId, expectedRunId, StringComparison.Ordinal)
            && (!string.Equals(existing.Runtime, expectedRuntime, StringComparison.Ordinal)
                || !existing.KnowledgeEntryIds.SequenceEqual(expectedKnowledge, StringComparer.Ordinal)))
            throw new InvalidOperationException("现有站点版本的生成来源记录不一致");
    }

    private async Task ValidateHostedSitePackageAsync(
        HostedSiteEditableEntry entry,
        string userId,
        string expectedRunId,
        string expectedRuntime,
        IReadOnlyList<HostedSiteVerifiedFile> expectedFiles,
        CancellationToken ct)
    {
        if (_storage == null)
            throw new InvalidOperationException("无法验证站点对象包，不能认领生成版本");
        var site = await _db.HostedSites.Find(item => item.Id == entry.Site.Id).FirstOrDefaultAsync(ct)
                   ?? throw new InvalidOperationException("站点不存在，不能认领生成版本");
        var sourceRun = await _db.DesignArtifactRuns.Find(run => run.DeploymentSlug == DeploymentScope.Current && (run.Id == expectedRunId
                && run.UserId == userId
                && run.Runtime == expectedRuntime
                && run.ArtifactType == DesignArtifactTypes.WebPage
                && run.Operation == DesignArtifactOperations.Generate
                && run.Status == RunStatuses.Committing
                && run.ProducedArtifactSiteId == null
                && run.ProducedArtifactRevisionId == null))
            .FirstOrDefaultAsync(ct);
        if (sourceRun == null)
            throw new InvalidOperationException("生成任务状态或产物归属已变化，不能认领版本");
        if (!string.Equals(site.OwnerUserId, userId, StringComparison.Ordinal)
            || !string.Equals(site.SourceType, "design-agent", StringComparison.Ordinal)
            || !string.Equals(site.SourceRef, expectedRunId, StringComparison.Ordinal)
            || site.ContentVersion != entry.ContentVersion)
            throw new InvalidOperationException("站点与生成任务归属不一致");

        var hostedFiles = (site.Files ?? []).OrderBy(file => file.Path, StringComparer.Ordinal).ToList();
        var verifiedFiles = expectedFiles.OrderBy(file => file.Path, StringComparer.Ordinal).ToList();
        if (hostedFiles.Count != verifiedFiles.Count
            || site.TotalSize != hostedFiles.Sum(file => file.Size))
            throw new InvalidOperationException("站点文件清单与生成结果不一致");
        for (var index = 0; index < hostedFiles.Count; index++)
        {
            var hosted = hostedFiles[index];
            var expected = verifiedFiles[index];
            if (string.IsNullOrWhiteSpace(hosted.CosKey)
                || !string.Equals(hosted.Path, expected.Path, StringComparison.Ordinal)
                || !string.Equals(hosted.MimeType, expected.MimeType, StringComparison.OrdinalIgnoreCase)
                || hosted.Size != expected.Content.LongLength
                || !MatchesSha256(expected.Content, expected.Sha256))
                throw new InvalidOperationException("站点文件清单与生成结果不一致");
            var stored = await _storage.TryDownloadBytesAsync(hosted.CosKey, ct);
            if (stored == null
                || !MatchesSha256(stored, expected.Sha256)
                || !CryptographicOperations.FixedTimeEquals(stored, expected.Content))
                throw new InvalidOperationException("站点对象内容与生成结果不一致");
        }
    }

    private static bool MatchesSha256(byte[] content, string expected) =>
        string.Equals(
            Convert.ToHexString(SHA256.HashData(content)).ToLowerInvariant(),
            expected,
            StringComparison.OrdinalIgnoreCase);

    private static HostedSiteRevisionFile ToRevisionFile(HostedSiteVerifiedFile file) => new()
    {
        Path = file.Path,
        Content = file.Content.ToArray(),
        Sha256 = file.Sha256,
        MimeType = file.MimeType,
    };

    private static List<string> NormalizeKnowledgeEntryIds(IReadOnlyCollection<string>? values) =>
        (values ?? Array.Empty<string>())
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .Select(value => value.Trim())
        .Distinct(StringComparer.Ordinal)
        .ToList();

    private static bool SameContentHash(string left, string right) =>
        CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(left)),
            SHA256.HashData(Encoding.UTF8.GetBytes(right)));

    private static bool VerifiedFilesMatch(
        IReadOnlyList<HostedSiteRevisionFile> existing,
        IReadOnlyList<HostedSiteVerifiedFile> expected)
    {
        if (existing.Count != expected.Count) return false;
        for (var index = 0; index < existing.Count; index++)
        {
            var left = existing[index];
            var right = expected[index];
            if (!string.Equals(left.Path, right.Path, StringComparison.Ordinal)
                || !string.Equals(left.MimeType, right.MimeType, StringComparison.Ordinal)
                || !string.Equals(left.Sha256, right.Sha256, StringComparison.OrdinalIgnoreCase)
                || !CryptographicOperations.FixedTimeEquals(left.Content, right.Content))
                return false;
        }
        return true;
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
        // 只取元数据：整页 HTML 与整包文件字节留在库里不读（契约见接口注释）。
        // 一次 100 条 x 多兆的包 = 打开版本面板就分配几百兆。
        return await _db.HostedSiteRevisions
            .Find(x => x.SiteId == siteId)
            .Project<HostedSiteRevision>(Builders<HostedSiteRevision>.Projection
                .Exclude(x => x.Html)
                .Exclude(x => x.VerifiedFiles))
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

    public async Task<HostedSiteRevisionFile?> GetVerifiedFileAsync(
        string siteId,
        string revisionId,
        string path,
        string userId,
        CancellationToken ct = default)
    {
        if (await _sites.GetByIdAsync(siteId, userId, ct) == null)
            throw new KeyNotFoundException("站点不存在");
        var filter = Builders<HostedSiteRevision>.Filter.Eq(revision => revision.Id, revisionId)
                     & Builders<HostedSiteRevision>.Filter.Eq(revision => revision.SiteId, siteId)
                     & Builders<HostedSiteRevision>.Filter.ElemMatch(
                         revision => revision.VerifiedFiles,
                         file => file.Path == path);
        var projection = Builders<HostedSiteRevision>.Projection.ElemMatch(
            revision => revision.VerifiedFiles,
            file => file.Path == path);
        var projected = await _db.HostedSiteRevisions
            .Find(filter)
            .Project<HostedSiteRevision>(projection)
            .FirstOrDefaultAsync(ct);
        return projected?.VerifiedFiles.SingleOrDefault();
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
        if (!CanReproduceSite(target, current.Site))
            throw new InvalidOperationException(
                "该版本只留下了入口 HTML，当时站点的样式与图片没有一并存档，回退会得到一个残缺站点；"
                + "请改用「另存为新版本」或重新生成。");
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

    /// <summary>
    /// 这条版本自己的内容，够不够把站点还原成它当时的样子。
    ///
    /// 带整包 VerifiedFiles 的够；只有入口 HTML 的，仅当那时站点本来就是单文件形态才够。
    /// 多文件站点的旁挂对象只存在于对象存储里，而下一次整包发布会把它们回收掉——那之后
    /// 按入口 HTML 回退，拿到的是旧 HTML 配新版本的样式与图片，或者干脆指向已删对象
    /// （Codex P1，2026-09-15）。存量版本没有记过形态，退而按站点当前形态判断：
    /// 当前就是单文件的，入口 HTML 足以还原；当前是多文件的，不给还原。
    /// </summary>
    internal static bool CanReproduceSite(HostedSiteRevision revision, HostedSite currentSite)
    {
        if (revision.VerifiedFiles.Count > 0) return true;
        if (string.IsNullOrWhiteSpace(revision.CapturedContentShape))
            return !HasUncapturedSidecars(currentSite);
        return string.Equals(
            revision.CapturedContentShape,
            HostedSiteContentShapes.SelfContainedHtml,
            StringComparison.Ordinal);
    }

    /// <summary>
    /// 这个站点除入口文件之外，还有没有只存在于对象存储里、不会被入口 HTML 带走的旁挂内容。
    ///
    /// 问的是「旁挂对象」而不是直接套 <see cref="HostedSiteContentShapeRules.IsSelfContainedHtml"/>：
    /// 后者对**一个文件都没登记**的站点也返回 false，而那种站点根本没有内容会丢。
    /// 生成包那六个路径（manifest 与 assets 下的几份 JSON）按既有产品语义算自包含——
    /// 入口 HTML 不靠它们渲染，替换入口时本来就会一并丢掉。
    /// </summary>
    private static bool HasUncapturedSidecars(HostedSite site)
    {
        var files = site.Files ?? new List<HostedSiteFile>();
        if (files.Count == 0) return false;
        if (HostedSiteContentShapeRules.IsSelfContainedHtml(site)) return false;
        return files.Any(file => !string.Equals(file.Path, site.EntryFile, StringComparison.OrdinalIgnoreCase));
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
        InvalidOperationException? lastRefusal = null;
        for (var attempt = 0; attempt < 40; attempt++)
        {
            if (revision.RollbackTargetRevisionId != targetRevisionId)
                throw new InvalidOperationException("同一幂等键不能用于不同回退目标");
            if (revision.Status == HostedSiteRevisionStatuses.Published)
                return new HostedSiteRevisionMutationResult(revision, current.Site, reportChange);
            // Publishing 一律交给 PublishAsync 判，不在这里先拿站点指针筛一道：
            // 进程在「标成 Publishing」之后、「切换站点指针」之前停掉时，指针永远对不上，
            // 而 PublishAsync 自己有按 PublishAttemptTtl 接管过期尝试的路径——这里筛掉它，
            // 那条尝试就再也没人接得了，40 轮全部空转，回退接口对这条记录永久失效。
            if (revision.Status == HostedSiteRevisionStatuses.Draft
                || revision.Status == HostedSiteRevisionStatuses.Publishing)
            {
                try
                {
                    var result = await PublishAsync(siteId, revision.Id, userId, CancellationToken.None);
                    return result with { Changed = reportChange && result.Changed };
                }
                catch (InvalidOperationException refusal) when (attempt < 39)
                {
                    // 同 key 并发调用可能由另一个请求先取得发布围栏；重读同一事实，不新建版本。
                    lastRefusal = refusal;
                }
            }

            await Task.Delay(50, CancellationToken.None);
            revision = await _db.HostedSiteRevisions.Find(item => item.Id == revision.Id)
                .FirstOrDefaultAsync(CancellationToken.None)
                ?? throw new KeyNotFoundException("版本不存在");
            current = await _sites.GetEditableEntryHtmlAsync(siteId, userId, CancellationToken.None);
        }
        // 把最后一次拒绝的真实原因交出去：换成一句笼统的「正在处理」，
        // 会把「站点在发布时已经变了」这类可行动的结论抹成一条无从下手的提示。
        throw lastRefusal ?? new InvalidOperationException("同一回退请求正在处理，请稍后重试");
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
