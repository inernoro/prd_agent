using System.Security.Cryptography;
using System.Text;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Services;

public interface IWebPageDesignArtifactLifecycleAdapter
{
    Task AppendPhaseAsync(
        string runId,
        DesignArtifactLifecycleLeaseAuthority lease,
        int progress,
        string phase,
        CancellationToken ct = default);

    Task CommitManifestAsync(
        string runId,
        IReadOnlyList<DesignWorkspaceFile> verifiedFiles,
        DesignArtifactLifecycleLeaseAuthority lease,
        CancellationToken ct = default);

    Task CompleteAsync(
        string runId,
        DesignArtifactLifecycleLeaseAuthority lease,
        CancellationToken ct = default);

    Task FailAsync(
        string runId,
        string failureCode,
        DesignArtifactLifecycleLeaseAuthority lease,
        CancellationToken ct = default);

    Task BindPublishedAsync(
        string runId,
        string siteId,
        string revisionId,
        CancellationToken ct = default);

    Task<int> RecoverPendingAsync(int limit = 100, CancellationToken ct = default);
}

public sealed record DesignArtifactLifecycleLeaseAuthority(
    string LeaseOwnerId,
    DateTime? ObservedLeaseExpiresAt = null,
    bool Recovery = false);

/// <summary>
/// 把网页托管专用 Run 投影到 DesignArtifact v2 生命周期。
/// OpenDesign 只提交 CDS 工作区结果；MAP 使用 Broker 已验真的字节事实生成公共 manifest 和回执。
/// </summary>
public sealed class WebPageDesignArtifactLifecycleAdapter : IWebPageDesignArtifactLifecycleAdapter
{
    public const string AdapterId = "open-design-remote-package";
    public const string SecurityPolicyVersion = "web-page-restricted.v1";
    public const string ExecutionFailureCode = "open_design_execution_failed";
    public const string InterruptedFailureCode = "design_artifact_interrupted";

    private static readonly HashSet<string> AllowedFailureCodes = new(StringComparer.Ordinal)
    {
        ExecutionFailureCode,
        InterruptedFailureCode,
        "design_output_invalid",
        "design_output_missing",
        "design_output_quality_rejected",
        "design_output_too_large",
        "open_design_contract_mismatch",
        "open_design_not_ready",
        "open_design_run_cancelled",
        "open_design_run_failed",
        "open_design_run_timeout",
        "workspace_commit_invalid_response",
        "workspace_container_start_failed",
        "workspace_egress_unavailable",
        "workspace_package_hash_mismatch",
        "workspace_package_invalid",
        "workspace_runtime_unavailable",
        "workspace_session_not_found",
        "workspace_transfer_invalid",
    };

    private readonly MongoDbContext _db;
    private readonly IDesignArtifactLifecycleService _lifecycle;
    private readonly IDesignArtifactWorkspaceBroker _workspaceBroker;
    private readonly ILogger<WebPageDesignArtifactLifecycleAdapter> _logger;

    public WebPageDesignArtifactLifecycleAdapter(
        MongoDbContext db,
        IDesignArtifactLifecycleService lifecycle,
        IDesignArtifactWorkspaceBroker workspaceBroker,
        ILogger<WebPageDesignArtifactLifecycleAdapter> logger)
    {
        _db = db;
        _lifecycle = lifecycle;
        _workspaceBroker = workspaceBroker;
        _logger = logger;
    }

    /// <summary>
    /// 在首次 Insert 前把 v2 创建事实写入同一个 Run 文档；队列状态仍由网页 Worker 认领。
    /// </summary>
    public static void InitializeNewRun(
        DesignArtifactRun run,
        DesignArtifactProviderCapability capability,
        string? currentHtml)
    {
        if (run.Runtime != DesignArtifactRuntimes.OpenDesign) return;
        if (run.Status != RunStatuses.Queued
            || run.ArtifactType != DesignArtifactTypes.WebPage
            || run.Operation is not (DesignArtifactOperations.Generate or DesignArtifactOperations.Edit))
            throw Invalid("OpenDesign 网页任务创建状态无效");

        var inputPackage = DesignArtifactWorkspaceContract.BuildInputPackage(run, currentHtml);
        var baseContentHash = string.IsNullOrWhiteSpace(currentHtml)
            ? null
            : Sha256Hex(Encoding.UTF8.GetBytes(
                DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(currentHtml)));
        var now = DateTime.UtcNow;
        run.ContractVersion = DesignArtifactContractVersions.Current;
        run.LifecycleVersion = 1;
        run.LifecycleEventSequence = 1;
        run.WorkspaceRef = new DesignArtifactWorkspaceRef
        {
            WorkspaceId = $"web-page-{run.Id}",
            Kind = DesignArtifactWorkspaceKinds.RemotePackage,
            BaseRevision = inputPackage.BaseRevision,
            Adapter = AdapterId,
        };
        run.VersionBoundary = new DesignArtifactVersionBoundary
        {
            BaseArtifactId = run.TargetSiteId,
            BaseVersion = run.Operation == DesignArtifactOperations.Edit ? inputPackage.BaseRevision : null,
            BaseContentHash = baseContentHash,
        };
        run.Capability = new DesignArtifactCapabilitySnapshot
        {
            CapabilityId = $"{capability.Id}.remote-package.v1",
            ArtifactType = DesignArtifactTypes.WebPage,
            Runtime = run.Runtime,
            Adapter = AdapterId,
            WorkspaceKind = DesignArtifactWorkspaceKinds.RemotePackage,
            SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
            Operations = capability.Operations.Distinct(StringComparer.Ordinal).ToList(),
            SourceSurfaces = capability.SourceSurfaces.Distinct(StringComparer.Ordinal).ToList(),
        };
        run.LifecycleEvents =
        [
            new DesignArtifactEventEnvelope
            {
                RunId = run.Id,
                ArtifactType = run.ArtifactType,
                Sequence = 1,
                Type = DesignArtifactLifecycleEventTypes.Run,
                Phase = run.Phase,
                Progress = run.Progress,
                OccurredAt = now,
                Authoritative = true,
            },
        ];
        run.CreatedAt = now;
        run.UpdatedAt = now;
    }

    public async Task AppendPhaseAsync(
        string runId,
        DesignArtifactLifecycleLeaseAuthority lease,
        int progress,
        string phase,
        CancellationToken ct = default)
    {
        var current = await RequireCurrentAsync(runId);
        if (!IsManaged(current)) return;
        await _lifecycle.AppendEventAsync(
            new AppendDesignArtifactEventRequest(
                current.Id,
                current.UserId,
                DesignArtifactLifecycleEventTypes.Phase,
                phase,
                progress,
                Expected(current, lease)),
            CancellationToken.None);
    }

    public async Task CommitManifestAsync(
        string runId,
        IReadOnlyList<DesignWorkspaceFile> verifiedFiles,
        DesignArtifactLifecycleLeaseAuthority lease,
        CancellationToken ct = default)
    {
        var current = await RequireManagedAsync(runId);
        var trusted = BuildTrustedManifest(current, verifiedFiles);
        for (var attempt = 0; attempt < 4; attempt++)
        {
            if (current.Status is RunStatuses.Committing or RunStatuses.Done)
            {
                EnsureManifestMatches(current, trusted.Manifest, trusted.Receipt);
                return;
            }
            if (current.Status != RunStatuses.Running) throw Conflict();
            try
            {
                await _lifecycle.CommitManifestAsync(
                    new CommitDesignArtifactManifestRequest(
                        current.Id,
                        current.UserId,
                        Expected(current, lease),
                        trusted.Manifest,
                        trusted.Receipt),
                    CancellationToken.None);
                return;
            }
            catch (DesignArtifactLifecycleException ex)
                when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict && attempt < 3)
            {
                current = await RequireManagedAsync(runId);
            }
        }
        throw Conflict();
    }

    public async Task CompleteAsync(
        string runId,
        DesignArtifactLifecycleLeaseAuthority lease,
        CancellationToken ct = default)
    {
        var current = await RequireManagedAsync(runId);
        for (var attempt = 0; attempt < 4; attempt++)
        {
            if (current.Status == RunStatuses.Done) return;
            if (current.Status != RunStatuses.Committing
                || current.Manifest == null
                || current.ManifestValidation == null)
                throw Conflict();
            try
            {
                await _lifecycle.CompleteAsync(
                    new DesignArtifactLifecycleMutationRequest(
                        current.Id,
                        current.UserId,
                        Expected(current, lease)),
                    CancellationToken.None);
                return;
            }
            catch (DesignArtifactLifecycleException ex)
                when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict && attempt < 3)
            {
                current = await RequireManagedAsync(runId);
            }
        }
        throw Conflict();
    }

    public async Task FailAsync(
        string runId,
        string failureCode,
        DesignArtifactLifecycleLeaseAuthority lease,
        CancellationToken ct = default)
    {
        var current = await RequireCurrentAsync(runId);
        if (!IsManaged(current)) return;
        if (!AllowedFailureCodes.Contains(failureCode)) failureCode = ExecutionFailureCode;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (current.Status == RunStatuses.Error) return;
            if (current.Status == RunStatuses.Done) throw Conflict();
            if (current.Status is not (RunStatuses.Running or RunStatuses.Committing)) return;
            try
            {
                await _lifecycle.FailAsync(
                    new FailDesignArtifactSessionRequest(
                        current.Id,
                        current.UserId,
                        Expected(current, lease),
                        failureCode),
                    CancellationToken.None);
                return;
            }
            catch (DesignArtifactLifecycleException ex)
                when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict && attempt < 2)
            {
                current = await RequireManagedAsync(runId);
            }
        }
        throw Conflict();
    }

    public async Task BindPublishedAsync(
        string runId,
        string siteId,
        string revisionId,
        CancellationToken ct = default)
    {
        var current = await RequireManagedAsync(runId);
        for (var attempt = 0; attempt < 4; attempt++)
        {
            if (current.ArtifactSiteId == siteId && current.ArtifactRevisionId == revisionId) return;
            if (current.Status != RunStatuses.Done
                || current.Operation == DesignArtifactOperations.Plan
                || string.IsNullOrWhiteSpace(current.VersionBoundary?.PackageHash))
                throw Conflict();
            if (!string.IsNullOrWhiteSpace(current.ArtifactSiteId)
                || !string.IsNullOrWhiteSpace(current.ArtifactRevisionId))
                throw Conflict();
            var artifactHash = current.VersionBoundary.PackageHash;
            try
            {
                await _lifecycle.BindPublishedArtifactAsync(
                    new BindPublishedDesignArtifactRequest(
                        current.Id,
                        current.UserId,
                        Expected(current),
                        siteId,
                        revisionId,
                        BuildPublishOperationId(current.Id, siteId, revisionId, artifactHash),
                        artifactHash),
                    CancellationToken.None);
                return;
            }
            catch (DesignArtifactLifecycleException ex)
                when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict && attempt < 3)
            {
                current = await RequireManagedAsync(runId);
            }
        }
        throw Conflict();
    }

    /// <summary>
    /// 收敛三个可恢复窗口：Broker 已提交但 manifest 未记账、托管版本已写入但生命周期未完成、
    /// 生命周期完成但发布绑定未落账。仍在有效租约内的运行任务不会被接管。
    /// </summary>
    public async Task<int> RecoverPendingAsync(int limit = 100, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var candidates = await _db.DesignArtifactRuns.Find(run =>
                run.ContractVersion == DesignArtifactContractVersions.Current
                && run.Runtime == DesignArtifactRuntimes.OpenDesign
                && run.ArtifactType == DesignArtifactTypes.WebPage
                && (run.Status == RunStatuses.Running || run.Status == RunStatuses.Committing)
                && (run.LeaseExpiresAt == null || run.LeaseExpiresAt <= now))
            .SortBy(run => run.UpdatedAt)
            .Limit(Math.Clamp(limit, 1, 500))
            .ToListAsync(CancellationToken.None);

        var recovered = 0;
        foreach (var candidate in candidates)
        {
            try
            {
                var current = candidate;
                if (current.Status == RunStatuses.Running
                    && !string.IsNullOrWhiteSpace(current.WorkspaceResultAssetKey))
                {
                    var files = await ReadVerifiedFilesAsync(current);
                    var recoveryLease = RecoveryLease(current);
                    await CommitManifestAsync(current.Id, files, recoveryLease, CancellationToken.None);
                    current = await RequireManagedAsync(current.Id);
                }

                var revision = await FindProducedRevisionAsync(current);
                if (current.Status == RunStatuses.Committing && revision != null)
                {
                    await CompleteAsync(current.Id, RecoveryLease(current), CancellationToken.None);
                    current = await RequireManagedAsync(current.Id);
                }

                if (current.Status == RunStatuses.Done
                    && revision?.Status == HostedSiteRevisionStatuses.Published)
                {
                    await BindPublishedAsync(
                        current.Id,
                        revision.SiteId,
                        revision.Id,
                        CancellationToken.None);
                    recovered++;
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "OpenDesign 网页公共生命周期恢复未完成 runId={RunId}", candidate.Id);
            }
        }

        var pendingBindings = await _db.DesignArtifactRuns.Find(run =>
                run.ContractVersion == DesignArtifactContractVersions.Current
                && run.Runtime == DesignArtifactRuntimes.OpenDesign
                && run.ArtifactType == DesignArtifactTypes.WebPage
                && run.WorkspaceRef != null
                && run.WorkspaceRef.Kind == DesignArtifactWorkspaceKinds.RemotePackage
                && run.WorkspaceRef.Adapter == AdapterId
                && run.Status == RunStatuses.Done
                && run.ArtifactSiteId == null
                && run.ArtifactRevisionId == null)
            .SortBy(run => run.UpdatedAt)
            .Limit(Math.Clamp(limit, 1, 500))
            .ToListAsync(CancellationToken.None);
        foreach (var run in pendingBindings)
        {
            try
            {
                var revision = await FindProducedRevisionAsync(run);
                if (revision?.Status != HostedSiteRevisionStatuses.Published)
                    continue;
                await BindPublishedAsync(run.Id, revision.SiteId, revision.Id, CancellationToken.None);
                recovered++;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "OpenDesign 网页发布绑定恢复未完成 runId={RunId} revisionId={RevisionId}",
                    run.Id,
                    run.ProducedArtifactRevisionId);
            }
        }
        return recovered;
    }

    private async Task<IReadOnlyList<DesignWorkspaceFile>> ReadVerifiedFilesAsync(DesignArtifactRun run)
    {
        if (string.IsNullOrWhiteSpace(run.WorkspaceResultAssetKey)) throw Conflict();
        return (await _workspaceBroker.ReadResultAsync(run.Id, CancellationToken.None)).Files;
    }

    private async Task<HostedSiteRevision?> FindProducedRevisionAsync(DesignArtifactRun run)
    {
        var filter = Builders<HostedSiteRevision>.Filter.Eq(revision => revision.SourceRunId, run.Id)
                     & Builders<HostedSiteRevision>.Filter.Eq(revision => revision.CreatedByUserId, run.UserId);
        if (!string.IsNullOrWhiteSpace(run.ProducedArtifactRevisionId))
            filter &= Builders<HostedSiteRevision>.Filter.Eq(
                revision => revision.Id,
                run.ProducedArtifactRevisionId);
        if (!string.IsNullOrWhiteSpace(run.ProducedArtifactSiteId))
            filter &= Builders<HostedSiteRevision>.Filter.Eq(
                revision => revision.SiteId,
                run.ProducedArtifactSiteId);
        else if (!string.IsNullOrWhiteSpace(run.TargetSiteId))
            filter &= Builders<HostedSiteRevision>.Filter.Eq(revision => revision.SiteId, run.TargetSiteId);
        return await _db.HostedSiteRevisions.Find(filter)
            .SortByDescending(revision => revision.CreatedAt)
            .FirstOrDefaultAsync(CancellationToken.None);
    }

    private async Task<DesignArtifactRun> RequireCurrentAsync(string runId) =>
        await _db.DesignArtifactRuns.Find(run => run.Id == runId)
            .FirstOrDefaultAsync(CancellationToken.None)
        ?? throw new DesignArtifactLifecycleException(
            DesignArtifactLifecycleErrorCodes.NotFound,
            "网页设计任务不存在");

    private async Task<DesignArtifactRun> RequireManagedAsync(string runId)
    {
        var run = await RequireCurrentAsync(runId);
        if (!IsManaged(run)) throw Invalid("网页设计任务不属于 OpenDesign v2 合同");
        return run;
    }

    private static bool IsManaged(DesignArtifactRun run) =>
        run.ContractVersion == DesignArtifactContractVersions.Current
        && run.Runtime == DesignArtifactRuntimes.OpenDesign
        && run.ArtifactType == DesignArtifactTypes.WebPage
        && run.WorkspaceRef?.Kind == DesignArtifactWorkspaceKinds.RemotePackage
        && run.WorkspaceRef.Adapter == AdapterId;

    private static TrustedWebPageManifest BuildTrustedManifest(
        DesignArtifactRun run,
        IReadOnlyList<DesignWorkspaceFile> verifiedFiles)
    {
        if (string.IsNullOrWhiteSpace(run.WorkspaceResultAssetKey)
            || string.IsNullOrWhiteSpace(run.WorkspaceResultSha256)
            || string.IsNullOrWhiteSpace(run.WorkspaceManifestSha256))
            throw Invalid("远程工作区尚未形成受信提交事实");

        var publicFiles = verifiedFiles
            .Where(file => !string.Equals(
                file.Path,
                DesignArtifactPublicRevision.InternalManifestPath,
                StringComparison.Ordinal))
            .OrderBy(file => file.Path, StringComparer.Ordinal)
            .Select(file => new DesignArtifactContractManifestFile
            {
                Path = file.Path,
                ByteLength = file.Size,
                Sha256 = NormalizeHash(file.Sha256),
                MediaType = file.MediaType,
            })
            .ToList();
        if (publicFiles.Count == 0 || publicFiles.All(file => file.Path != "index.html"))
            throw Invalid("远程工作区缺少公开入口文件");

        var packageHash = DesignArtifactPublicRevision.Compute(
            publicFiles.Select(file => new DesignArtifactPublicRevisionFile(
                file.Path,
                file.Sha256,
                file.ByteLength,
                file.MediaType)));
        var manifest = new DesignArtifactContractManifest
        {
            SchemaVersion = DesignArtifactContractVersions.ManifestV1,
            ArtifactType = DesignArtifactTypes.WebPage,
            EntryFile = "index.html",
            SecurityProfile = DesignArtifactSecurityProfiles.WebPageRestricted,
            Files = publicFiles,
        };
        var canonical = new StringBuilder();
        AppendCanonical(
            canonical,
            manifest.SchemaVersion,
            manifest.ArtifactType,
            manifest.EntryFile,
            manifest.SecurityProfile,
            packageHash);
        var receipt = new DesignArtifactManifestValidationReceipt
        {
            Validator = AdapterId,
            WorkspaceId = run.WorkspaceRef?.WorkspaceId ?? throw Invalid("远程工作区引用不存在"),
            SecurityPolicyVersion = SecurityPolicyVersion,
            EntryContentHash = publicFiles.Single(file => file.Path == "index.html").Sha256,
            CanonicalManifestHash = Sha256Hex(Encoding.UTF8.GetBytes(canonical.ToString())),
            PackageHash = packageHash,
            SourcePackageHash = NormalizeHash(run.WorkspaceResultSha256),
            SourceManifestHash = NormalizeHash(run.WorkspaceManifestSha256),
            TotalBytes = publicFiles.Sum(file => file.ByteLength),
            ValidatedAt = DateTime.UtcNow,
        };
        return new TrustedWebPageManifest(manifest, receipt);
    }

    private static void EnsureManifestMatches(
        DesignArtifactRun run,
        DesignArtifactContractManifest expected,
        DesignArtifactManifestValidationReceipt expectedReceipt)
    {
        if (run.Manifest == null
            || run.ManifestValidation == null
            || run.Manifest.SchemaVersion != expected.SchemaVersion
            || run.Manifest.ArtifactType != expected.ArtifactType
            || run.Manifest.EntryFile != expected.EntryFile
            || run.Manifest.SecurityProfile != expected.SecurityProfile
            || run.Manifest.Files.Count != expected.Files.Count
            || !FixedHashEquals(run.ManifestValidation.SourcePackageHash, expectedReceipt.SourcePackageHash)
            || !FixedHashEquals(run.ManifestValidation.SourceManifestHash, expectedReceipt.SourceManifestHash)
            || !FixedHashEquals(run.VersionBoundary?.PackageHash, expectedReceipt.PackageHash))
            throw Conflict();

        var actualFiles = run.Manifest.Files.OrderBy(file => file.Path, StringComparer.Ordinal).ToArray();
        var expectedFiles = expected.Files.OrderBy(file => file.Path, StringComparer.Ordinal).ToArray();
        for (var index = 0; index < actualFiles.Length; index++)
        {
            if (actualFiles[index].Path != expectedFiles[index].Path
                || actualFiles[index].ByteLength != expectedFiles[index].ByteLength
                || !FixedHashEquals(actualFiles[index].Sha256, expectedFiles[index].Sha256)
                || !string.Equals(actualFiles[index].MediaType, expectedFiles[index].MediaType, StringComparison.OrdinalIgnoreCase))
                throw Conflict();
        }
    }

    private static DesignArtifactLifecycleExpectation Expected(
        DesignArtifactRun run,
        DesignArtifactLifecycleLeaseAuthority? lease = null) => new(
        run.LifecycleVersion,
        run.WorkspaceRef?.BaseRevision,
        run.VersionBoundary?.BaseContentHash,
        lease?.LeaseOwnerId,
        lease?.ObservedLeaseExpiresAt,
        lease?.Recovery ?? false);

    private static DesignArtifactLifecycleLeaseAuthority RecoveryLease(DesignArtifactRun run)
    {
        if (string.IsNullOrWhiteSpace(run.LeaseOwnerId) || !run.LeaseExpiresAt.HasValue)
            throw Conflict();
        return new DesignArtifactLifecycleLeaseAuthority(
            run.LeaseOwnerId,
            run.LeaseExpiresAt,
            Recovery: true);
    }

    private static string BuildPublishOperationId(
        string runId,
        string siteId,
        string revisionId,
        string artifactHash) => Sha256Hex(Encoding.UTF8.GetBytes(
        $"{runId}\n{siteId}\n{revisionId}\n{artifactHash}"));

    private static void AppendCanonical(StringBuilder builder, params string[] values)
    {
        foreach (var value in values)
            builder.Append(value.Length).Append(':').Append(value).Append(';');
        builder.Append('\n');
    }

    private static string NormalizeHash(string value)
    {
        var normalized = value.Trim().ToLowerInvariant();
        if (normalized.Length != 64 || normalized.Any(character => !Uri.IsHexDigit(character)))
            throw Invalid("远程工作区哈希无效");
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

    private static string Sha256Hex(byte[] bytes) =>
        Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static DesignArtifactLifecycleException Invalid(string message) => new(
        DesignArtifactLifecycleErrorCodes.InvalidContract,
        message);

    private static DesignArtifactLifecycleException Conflict() => new(
        DesignArtifactLifecycleErrorCodes.Conflict,
        "OpenDesign 网页公共生命周期状态冲突");

    private sealed record TrustedWebPageManifest(
        DesignArtifactContractManifest Manifest,
        DesignArtifactManifestValidationReceipt Receipt);
}
