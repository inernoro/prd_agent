using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services.MdToPpt;

public interface IHtmlPptDesignArtifactAdapter
{
    Task BeginAsync(MdToPptRun run, CancellationToken ct = default);

    Task CompletePlanAsync(MdToPptRun run, CancellationToken ct = default);

    Task CommitAndCompleteAsync(MdToPptRun run, CancellationToken ct = default);

    Task FailAsync(MdToPptRun run, string failureCode, CancellationToken ct = default);

    Task BindPublishedAsync(
        MdToPptRun run,
        string hostedSiteId,
        string hostedVersionId,
        CancellationToken ct = default);

    Task<int> RecoverPendingAsync(int limit = 100, CancellationToken ct = default);
}

/// <summary>
/// 把 HTML PPT 专用流水线投影到公共 DesignArtifact v2 合同。
/// 适配器不参与生成算法，也不接收模型、网关地址、凭证或 CDS 连接配置。
/// </summary>
public sealed class HtmlPptDesignArtifactAdapter : IHtmlPptDesignArtifactAdapter
{
    public const string AdapterId = "html-ppt-design-artifact";
    public const string GenerationFailureCode = "html_ppt_generation_failed";
    public const string PersistenceFailureCode = "html_ppt_persist_failed";
    public const string RecoveryFailureCode = "html_ppt_recovery_failed";
    public const string StaleRunningFailureCode = "html_ppt_stale_running";
    public const string RecoveryDeadLetterCode = "html_ppt_recovery_dead_letter";
    internal const int MaxRecoveryAttempts = 5;
    internal static readonly TimeSpan StaleRunTtl = TimeSpan.FromMinutes(15);

    private static readonly HashSet<string> AllowedFailureCodes = new(StringComparer.Ordinal)
    {
        GenerationFailureCode,
        PersistenceFailureCode,
        RecoveryFailureCode,
        StaleRunningFailureCode,
        RecoveryDeadLetterCode,
        "html_ppt_knowledge_changed",
        "html_ppt_outline_invalid",
        "html_ppt_output_invalid",
        "html_ppt_runtime_failed",
    };

    private readonly MongoDbContext _db;
    private readonly IDesignArtifactLifecycleService _lifecycle;
    private readonly ILogger<HtmlPptDesignArtifactAdapter> _logger;

    public HtmlPptDesignArtifactAdapter(
        MongoDbContext db,
        IDesignArtifactLifecycleService lifecycle,
        ILogger<HtmlPptDesignArtifactAdapter> logger)
    {
        _db = db;
        _lifecycle = lifecycle;
        _logger = logger;
    }

    public async Task BeginAsync(MdToPptRun run, CancellationToken ct = default)
    {
        EnsureAdapterOwnedRun(run);
        var current = await FindPublicRunAsync(run.Id);
        if (current == null)
        {
            // 旧集合与其他部署的账本只能读取，不能借用同一 PPT 身份在本部署重建并遮住历史。
            if (await _db.FindDesignArtifactRunHistoryAsync(item => item.Id == run.Id, CancellationToken.None) != null)
                throw Conflict();
            try
            {
                current = await _lifecycle.CreateSessionAsync(BuildSession(run), CancellationToken.None);
            }
            catch (DesignArtifactLifecycleException ex)
                when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict)
            {
                current = await FindPublicRunAsync(run.Id);
                if (current == null) throw;
            }
        }

        EnsureMatchingSession(run, current);
    }

    public async Task CompletePlanAsync(MdToPptRun run, CancellationToken ct = default)
    {
        EnsureAdapterOwnedRun(run);
        if (run.Op != "outline" || run.Status != "done")
            throw Invalid("HTML PPT 规划任务状态无效");

        var current = await EnsureSessionAsync(run);
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (current.Status == RunStatuses.Done)
            {
                await MarkSynchronizedAsync(run.Id, "done");
                return;
            }
            if (current.Status != RunStatuses.Running || current.Operation != DesignArtifactOperations.Plan)
                throw Conflict();
            try
            {
                current = await _lifecycle.CompleteAsync(
                    new DesignArtifactLifecycleMutationRequest(
                        current.Id,
                        current.UserId,
                        Expected(current),
                        BuildPlanReceipt(run)),
                    CancellationToken.None);
            }
            catch (DesignArtifactLifecycleException ex)
                when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict && attempt < 2)
            {
                current = await RequirePublicRunAsync(run.Id);
                continue;
            }
            await MarkSynchronizedAsync(run.Id, "done");
            return;
        }
        throw Conflict();
    }

    public async Task CommitAndCompleteAsync(MdToPptRun run, CancellationToken ct = default)
    {
        EnsureAdapterOwnedRun(run);
        if (run.Op == "outline" || run.Status != "done")
            throw Invalid("HTML PPT 产物任务状态无效");

        var bytes = Encoding.UTF8.GetBytes(run.Html ?? string.Empty);
        var byteHash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        if (bytes.Length == 0
            || string.IsNullOrWhiteSpace(run.HtmlHash)
            || !FixedHashEquals(byteHash, run.HtmlHash))
            throw Invalid("HTML PPT manifest 与专用 Run 哈希不一致");

        var current = await EnsureSessionAsync(run);
        for (var attempt = 0; attempt < 4; attempt++)
        {
            if (current.Status == RunStatuses.Done)
            {
                EnsureManifestMatches(current, byteHash, bytes.LongLength);
                await MarkSynchronizedIfNoPendingPublicationAsync(run.Id);
                return;
            }

            try
            {
                if (current.Status == RunStatuses.Running)
                {
                    current = await _lifecycle.CommitManifestAsync(
                        new CommitDesignArtifactManifestRequest(
                            current.Id,
                            current.UserId,
                            Expected(current),
                            BuildManifest(byteHash, bytes.LongLength),
                            BuildValidationReceipt(current, byteHash, bytes.LongLength)),
                        CancellationToken.None);
                }
                if (current.Status != RunStatuses.Committing)
                    throw Conflict();

                EnsureManifestMatches(current, byteHash, bytes.LongLength);
                current = await _lifecycle.CompleteAsync(
                    new DesignArtifactLifecycleMutationRequest(
                        current.Id,
                        current.UserId,
                        Expected(current)),
                    CancellationToken.None);
                await MarkSynchronizedIfNoPendingPublicationAsync(run.Id);
                return;
            }
            catch (DesignArtifactLifecycleException ex)
                when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict && attempt < 3)
            {
                current = await RequirePublicRunAsync(run.Id);
            }
        }
        throw Conflict();
    }

    public async Task FailAsync(MdToPptRun run, string failureCode, CancellationToken ct = default)
    {
        EnsureAdapterOwnedRun(run);
        if (run.Status != "error") throw Invalid("HTML PPT 失败任务状态无效");
        if (!AllowedFailureCodes.Contains(failureCode)) failureCode = GenerationFailureCode;

        var current = await EnsureSessionAsync(run);
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (current.Status == RunStatuses.Error)
            {
                await MarkSynchronizedAsync(run.Id, "error");
                return;
            }
            if (current.Status == RunStatuses.Done) throw Conflict();
            try
            {
                current = await _lifecycle.FailAsync(
                    new FailDesignArtifactSessionRequest(
                        current.Id,
                        current.UserId,
                        Expected(current),
                        failureCode),
                    CancellationToken.None);
            }
            catch (DesignArtifactLifecycleException ex)
                when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict && attempt < 2)
            {
                current = await RequirePublicRunAsync(run.Id);
                continue;
            }
            await MarkSynchronizedAsync(run.Id, "error");
            return;
        }
        throw Conflict();
    }

    public async Task BindPublishedAsync(
        MdToPptRun run,
        string hostedSiteId,
        string hostedVersionId,
        CancellationToken ct = default)
    {
        EnsureAdapterOwnedRun(run);
        if (run.Status != "done" || run.Op == "outline")
            throw Invalid("HTML PPT 发布来源状态无效");
        if (string.IsNullOrWhiteSpace(hostedSiteId) || string.IsNullOrWhiteSpace(hostedVersionId))
            throw Invalid("HTML PPT 托管版本标识无效");
        if (!FixedHashEquals(run.HtmlHash, run.PublishedHtmlHash))
            throw Invalid("HTML PPT 发布内容与源 manifest 不一致");

        var hostedSite = await _db.HostedSites
            .Find(site => site.Id == hostedSiteId
                          && site.OwnerUserId == run.UserId
                          && site.PublishedRevisionId == hostedVersionId)
            .FirstOrDefaultAsync(CancellationToken.None);
        var hostedRevision = await _db.HostedSiteRevisions
            .Find(revision => revision.Id == hostedVersionId
                              && revision.SiteId == hostedSiteId
                              && revision.CreatedByUserId == run.UserId
                              && revision.Status == HostedSiteRevisionStatuses.Published)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (hostedSite == null
            || hostedRevision == null
            || hostedRevision.PublishedContentVersion != hostedSite.ContentVersion)
            throw Invalid("HTML PPT 托管版本不存在或不属于当前用户");

        var publishedBytes = Encoding.UTF8.GetBytes(hostedRevision.Html ?? string.Empty);
        var publishedHash = Convert.ToHexString(SHA256.HashData(publishedBytes)).ToLowerInvariant();
        if (!FixedHashEquals(run.HtmlHash, publishedHash)
            || !FixedHashEquals(run.PublishedHtmlHash, publishedHash))
            throw Invalid("HTML PPT 托管版本字节与源 manifest 不一致");

        await CommitAndCompleteAsync(run, CancellationToken.None);
        var current = await RequirePublicRunAsync(run.Id);
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (current.ArtifactSiteId == hostedSiteId && current.ArtifactRevisionId == hostedVersionId)
            {
                await MarkSynchronizedAsync(run.Id, "done");
                return;
            }
            if (!string.IsNullOrWhiteSpace(current.ArtifactSiteId)
                || !string.IsNullOrWhiteSpace(current.ArtifactRevisionId))
                throw Conflict();
            try
            {
                current = await _lifecycle.BindPublishedArtifactAsync(
                    new BindPublishedDesignArtifactRequest(
                        current.Id,
                        current.UserId,
                        Expected(current),
                        hostedSiteId,
                        hostedVersionId,
                        BuildPublishOperationId(run.Id, hostedSiteId, hostedVersionId, publishedHash),
                        publishedHash),
                    CancellationToken.None);
            }
            catch (DesignArtifactLifecycleException ex)
                when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict && attempt < 2)
            {
                current = await RequirePublicRunAsync(run.Id);
                continue;
            }
            await MarkSynchronizedAsync(run.Id, "done");
            return;
        }
        throw Conflict();
    }

    public async Task<int> RecoverPendingAsync(int limit = 100, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var deploymentScope = DeploymentScope.Current;
        var candidates = await _db.MdToPptRuns
            .Aggregate()
            .Match(run => run.ArtifactContractVersion == DesignArtifactContractVersions.Current
                         && run.ArtifactContractSynchronizedAt == null
                         && run.ArtifactRecoveryDeadLetteredAt == null
                         && (run.ArtifactRecoveryNextAttemptAt == null
                             || run.ArtifactRecoveryNextAttemptAt <= now)
                         && (run.Status == "done"
                             || run.Status == "error"
                             || run.UpdatedAt <= now.Subtract(StaleRunTtl)))
            // 在分页前关联已冻结的公共账本，避免旧部署或无归属任务占满候选窗口。
            .AppendStage<BsonDocument>(new BsonDocument("$lookup", new BsonDocument
            {
                { "from", _db.DesignArtifactRuns.CollectionNamespace.CollectionName },
                { "localField", "_id" },
                { "foreignField", "_id" },
                { "as", "_deploymentLedger" }
            }))
            .Match(new BsonDocument("_deploymentLedger", new BsonDocument("$elemMatch",
                new BsonDocument(nameof(DesignArtifactRun.DeploymentSlug),
                    deploymentScope == null ? BsonNull.Value : new BsonString(deploymentScope)))))
            .Sort(new BsonDocument(nameof(MdToPptRun.UpdatedAt), 1))
            .Limit(Math.Clamp(limit, 1, 500))
            .Project<MdToPptRun>(new BsonDocument("_deploymentLedger", 0))
            .ToListAsync(CancellationToken.None);

        var recovered = 0;
        foreach (var run in candidates)
        {
            // PPT 专用集合没有部署字段，只有已冻结的公共账本能证明本部署的恢复资格。
            // 先跳过旧/异部署账本及无账本孤儿；不得先改源任务状态，再在 Begin 失败后重试记账。
            // 无账本孤儿的归属仍待明确，不能按 UpdatedAt 推测并抢建。
            if (await FindPublicRunAsync(run.Id) == null) continue;
            try
            {
                var staleRecycled = false;
                if (run.Status == "running" && run.UpdatedAt <= now.Subtract(StaleRunTtl))
                {
                    var staleWrite = await _db.MdToPptRuns.UpdateOneAsync(
                        item => item.Id == run.Id
                                && item.Status == "running"
                                && item.UpdatedAt == run.UpdatedAt,
                        Builders<MdToPptRun>.Update
                            .Set(item => item.Status, "error")
                            .Set(item => item.Error, null)
                            .Set(item => item.ArtifactContractSynchronizedAt, null)
                            .Set(item => item.UpdatedAt, DateTime.UtcNow),
                        cancellationToken: CancellationToken.None);
                    if (staleWrite.ModifiedCount == 0) continue;
                    run.Status = "error";
                    run.Error = null;
                    run.UpdatedAt = DateTime.UtcNow;
                    staleRecycled = true;
                }
                await BeginAsync(run, CancellationToken.None);
                if (run.Status == "done")
                {
                    if (run.Op == "outline") await CompletePlanAsync(run, CancellationToken.None);
                    else await CommitAndCompleteAsync(run, CancellationToken.None);
                    if (!string.IsNullOrWhiteSpace(run.PublishedSiteId)
                        && !string.IsNullOrWhiteSpace(run.PublishedVersionId))
                    {
                        await BindPublishedAsync(
                            run,
                            run.PublishedSiteId,
                            run.PublishedVersionId,
                            CancellationToken.None);
                    }
                    recovered++;
                }
                else if (run.Status == "error")
                {
                    await FailAsync(
                        run,
                        staleRecycled ? StaleRunningFailureCode : RecoveryFailureCode,
                        CancellationToken.None);
                    recovered++;
                }
                await ClearRecoveryFailureAsync(run.Id);
            }
            catch (Exception ex)
            {
                await RecordRecoveryFailureAsync(run);
                _logger.LogWarning(ex, "HTML PPT 公共生命周期恢复未完成 runId={RunId}", run.Id);
            }
        }
        return recovered;
    }

    private async Task ClearRecoveryFailureAsync(string runId)
    {
        await _db.MdToPptRuns.UpdateOneAsync(
            run => run.Id == runId,
            Builders<MdToPptRun>.Update
                .Set(run => run.ArtifactRecoveryAttemptCount, 0)
                .Set(run => run.ArtifactRecoveryNextAttemptAt, null)
                .Set(run => run.ArtifactRecoveryLastFailureCode, null)
                .Set(run => run.ArtifactRecoveryDeadLetteredAt, null),
            cancellationToken: CancellationToken.None);
    }

    private async Task RecordRecoveryFailureAsync(MdToPptRun run)
    {
        var attemptedAt = DateTime.UtcNow;
        var attempt = run.ArtifactRecoveryAttemptCount + 1;
        var deadLettered = attempt >= MaxRecoveryAttempts;
        await _db.MdToPptRuns.UpdateOneAsync(
            item => item.Id == run.Id
                    && item.ArtifactRecoveryAttemptCount == run.ArtifactRecoveryAttemptCount,
            Builders<MdToPptRun>.Update
                .Set(item => item.ArtifactRecoveryAttemptCount, attempt)
                .Set(item => item.ArtifactRecoveryLastFailureCode,
                    deadLettered ? RecoveryDeadLetterCode : RecoveryFailureCode)
                .Set(item => item.ArtifactRecoveryNextAttemptAt,
                    deadLettered ? (DateTime?)null : attemptedAt.Add(RecoveryBackoff(attempt)))
                .Set(item => item.ArtifactRecoveryDeadLetteredAt,
                    deadLettered ? attemptedAt : (DateTime?)null),
            cancellationToken: CancellationToken.None);
    }

    internal static TimeSpan RecoveryBackoff(int attempt)
    {
        var exponent = Math.Clamp(attempt - 1, 0, 6);
        return TimeSpan.FromSeconds(Math.Min(300, 5 * (1 << exponent)));
    }

    private async Task<DesignArtifactRun> EnsureSessionAsync(MdToPptRun run)
    {
        await BeginAsync(run, CancellationToken.None);
        return await RequirePublicRunAsync(run.Id);
    }

    private CreateDesignArtifactSessionRequest BuildSession(MdToPptRun run)
    {
        var operation = run.Op switch
        {
            "outline" => DesignArtifactOperations.Plan,
            "convert" => DesignArtifactOperations.Generate,
            "patch" or "manual-edit" or "normalize" => DesignArtifactOperations.Edit,
            _ => throw Invalid("不支持的 HTML PPT 操作"),
        };
        return new CreateDesignArtifactSessionRequest(
            run.Id,
            run.UserId,
            DesignArtifactTypes.HtmlPpt,
            operation,
            run.SourceSurface,
            DesignArtifactRuntimes.HtmlPptPipeline,
            new DesignArtifactWorkspaceRef
            {
                WorkspaceId = $"html-ppt-{run.Id}",
                Kind = DesignArtifactWorkspaceKinds.AdapterOwned,
                BaseRevision = run.ParentHtmlHash,
                Adapter = AdapterId,
            },
            new DesignArtifactVersionBoundary
            {
                BaseArtifactId = run.ParentRunId,
                BaseVersion = run.ParentRunId,
                BaseContentHash = NormalizeOptionalHash(run.ParentHtmlHash),
            },
            new DesignArtifactCapabilitySnapshot
            {
                CapabilityId = "html-ppt-pipeline.adapter.v1",
                ArtifactType = DesignArtifactTypes.HtmlPpt,
                Runtime = DesignArtifactRuntimes.HtmlPptPipeline,
                Adapter = AdapterId,
                WorkspaceKind = DesignArtifactWorkspaceKinds.AdapterOwned,
                SecurityProfile = DesignArtifactSecurityProfiles.HtmlPptInteractive,
                Operations =
                [
                    DesignArtifactOperations.Plan,
                    DesignArtifactOperations.Generate,
                    DesignArtifactOperations.Edit,
                ],
                SourceSurfaces =
                [
                    DesignArtifactSourceSurfaces.HtmlPpt,
                    DesignArtifactSourceSurfaces.KnowledgeBase,
                ],
            },
            run.Title,
            run.ParentOutlineRunId,
            run.ParentPlanContentHash);
    }

    private static DesignArtifactContractManifest BuildManifest(string hash, long byteLength) => new()
    {
        SchemaVersion = DesignArtifactContractVersions.ManifestV1,
        ArtifactType = DesignArtifactTypes.HtmlPpt,
        EntryFile = "index.html",
        SecurityProfile = DesignArtifactSecurityProfiles.HtmlPptInteractive,
        Files =
        [
            new DesignArtifactContractManifestFile
            {
                Path = "index.html",
                ByteLength = byteLength,
                Sha256 = hash,
                MediaType = "text/html",
            },
        ],
    };

    private static DesignArtifactManifestValidationReceipt BuildValidationReceipt(
        DesignArtifactRun run,
        string hash,
        long byteLength)
    {
        var packageHash = DesignArtifactPublicRevision.Compute(
        [
            new DesignArtifactPublicRevisionFile("index.html", hash, byteLength, "text/html"),
        ]);
        var manifestCanonical = new StringBuilder();
        AppendCanonical(
            manifestCanonical,
            DesignArtifactContractVersions.ManifestV1,
            DesignArtifactTypes.HtmlPpt,
            "index.html",
            DesignArtifactSecurityProfiles.HtmlPptInteractive,
            packageHash);
        return new DesignArtifactManifestValidationReceipt
        {
            Validator = AdapterId,
            WorkspaceId = run.WorkspaceRef?.WorkspaceId ?? throw Invalid("HTML PPT 工作区引用不存在"),
            SecurityPolicyVersion = "html-ppt-interactive.v1",
            EntryContentHash = hash,
            CanonicalManifestHash = Sha256Hex(manifestCanonical.ToString()),
            PackageHash = packageHash,
            TotalBytes = byteLength,
            ValidatedAt = DateTime.UtcNow,
        };
    }

    private static DesignArtifactPlanReceipt BuildPlanReceipt(MdToPptRun run) => new()
    {
        StorageReference = $"md-to-ppt-run:{run.Id}:outline",
        ContentHash = NormalizeHash(run.OutlineHash ?? string.Empty),
        InputHash = NormalizeHash(run.UserSuppliedContentHash ?? string.Empty),
    };

    private static DesignArtifactLifecycleExpectation Expected(DesignArtifactRun run) => new(
        run.LifecycleVersion,
        run.WorkspaceRef?.BaseRevision,
        run.VersionBoundary?.BaseContentHash);

    private async Task MarkSynchronizedAsync(string runId, string expectedStatus)
    {
        await _db.MdToPptRuns.UpdateOneAsync(
            run => run.Id == runId
                   && run.Status == expectedStatus
                   && run.ArtifactContractVersion == DesignArtifactContractVersions.Current,
            Builders<MdToPptRun>.Update.Set(
                run => run.ArtifactContractSynchronizedAt,
                DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
    }

    private async Task MarkSynchronizedIfNoPendingPublicationAsync(string runId)
    {
        await _db.MdToPptRuns.UpdateOneAsync(
            run => run.Id == runId
                   && run.Status == "done"
                   && run.ArtifactContractVersion == DesignArtifactContractVersions.Current
                   && run.PublishedSiteId == null
                   && run.PublishedVersionId == null,
            Builders<MdToPptRun>.Update.Set(
                run => run.ArtifactContractSynchronizedAt,
                DateTime.UtcNow),
            cancellationToken: CancellationToken.None);
    }

    private async Task<DesignArtifactRun?> FindPublicRunAsync(string runId)
    {
        var run = await _db.DesignArtifactRuns.Find(item => item.DeploymentSlug == DeploymentScope.Current && (item.Id == runId))
            .FirstOrDefaultAsync(CancellationToken.None);
        return run;
    }

    private async Task<DesignArtifactRun> RequirePublicRunAsync(string runId) =>
        await FindPublicRunAsync(runId)
        ?? throw new DesignArtifactLifecycleException(
            DesignArtifactLifecycleErrorCodes.NotFound,
            "HTML PPT 公共生命周期不存在");

    private static void EnsureAdapterOwnedRun(MdToPptRun run)
    {
        if (run == null
            || run.ArtifactContractVersion != DesignArtifactContractVersions.Current
            || string.IsNullOrWhiteSpace(run.Id)
            || string.IsNullOrWhiteSpace(run.UserId))
            throw Invalid("HTML PPT 专用 Run 缺少 v2 合同标记");
    }

    private static void EnsureMatchingSession(MdToPptRun source, DesignArtifactRun current)
    {
        var expectedOperation = source.Op switch
        {
            "outline" => DesignArtifactOperations.Plan,
            "convert" => DesignArtifactOperations.Generate,
            "patch" or "manual-edit" or "normalize" => DesignArtifactOperations.Edit,
            _ => string.Empty,
        };
        if (current.ContractVersion != DesignArtifactContractVersions.Current
            || current.UserId != source.UserId
            || current.ArtifactType != DesignArtifactTypes.HtmlPpt
            || current.Operation != expectedOperation
            || current.Runtime != DesignArtifactRuntimes.HtmlPptPipeline
            || current.WorkspaceRef?.Kind != DesignArtifactWorkspaceKinds.AdapterOwned
            || current.WorkspaceRef.Adapter != AdapterId)
            throw Conflict();
    }

    private static void EnsureManifestMatches(DesignArtifactRun run, string hash, long byteLength)
    {
        var entry = run.Manifest?.Files.SingleOrDefault(file => file.Path == "index.html");
        if (run.Manifest?.ArtifactType != DesignArtifactTypes.HtmlPpt
            || run.Manifest.EntryFile != "index.html"
            || run.Manifest.SecurityProfile != DesignArtifactSecurityProfiles.HtmlPptInteractive
            || run.Manifest.Files.Count != 1
            || entry == null
            || entry.ByteLength != byteLength
            || !FixedHashEquals(entry.Sha256, hash)
            || !FixedHashEquals(run.VersionBoundary?.EntryContentHash, hash))
            throw Conflict();
    }

    private static string BuildPublishOperationId(
        string runId,
        string siteId,
        string versionId,
        string artifactHash) => Sha256Hex($"{runId}\n{siteId}\n{versionId}\n{artifactHash}");

    private static void AppendCanonical(StringBuilder builder, params string[] values)
    {
        foreach (var value in values)
            builder.Append(value.Length).Append(':').Append(value).Append(';');
        builder.Append('\n');
    }

    private static string Sha256Hex(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static string? NormalizeOptionalHash(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : NormalizeHash(value);

    private static string NormalizeHash(string value)
    {
        var normalized = value.Trim().ToLowerInvariant();
        if (normalized.Length != 64 || normalized.Any(ch => !Uri.IsHexDigit(ch)))
            throw Invalid("HTML PPT 内容哈希无效");
        return normalized;
    }

    private static bool FixedHashEquals(string? left, string? right)
    {
        if (string.IsNullOrWhiteSpace(left) || string.IsNullOrWhiteSpace(right)) return false;
        var normalizedLeft = NormalizeHash(left);
        var normalizedRight = NormalizeHash(right);
        return CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(normalizedLeft),
            Encoding.ASCII.GetBytes(normalizedRight));
    }

    private static DesignArtifactLifecycleException Invalid(string message) => new(
        DesignArtifactLifecycleErrorCodes.InvalidContract,
        message);

    private static DesignArtifactLifecycleException Conflict() => new(
        DesignArtifactLifecycleErrorCodes.Conflict,
        "HTML PPT 公共生命周期状态冲突");
}

/// <summary>周期收敛专用 Run 与公共生命周期的进程中断窗口。</summary>
public sealed class HtmlPptDesignArtifactRecoveryWorker : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly ILogger<HtmlPptDesignArtifactRecoveryWorker> _logger;

    public HtmlPptDesignArtifactRecoveryWorker(
        IServiceScopeFactory scopeFactory,
        ILogger<HtmlPptDesignArtifactRecoveryWorker> logger)
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
                var adapter = scope.ServiceProvider.GetRequiredService<IHtmlPptDesignArtifactAdapter>();
                await adapter.RecoverPendingAsync(100, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "HTML PPT 公共生命周期恢复轮询失败");
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
