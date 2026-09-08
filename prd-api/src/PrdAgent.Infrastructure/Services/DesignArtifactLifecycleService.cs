using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 跨设计 adapter 的公共生命周期账本。Mongo 单文档同时保存状态和脱敏事件，
/// Redis 只保留旧消费者需要的尽力投影。
/// </summary>
public sealed class DesignArtifactLifecycleService : IDesignArtifactLifecycleService
{
    private static readonly TimeSpan RedisProjectionTtl = TimeSpan.FromHours(24);
    private static readonly HashSet<string> AdapterEventTypes = new(StringComparer.Ordinal)
    {
        DesignArtifactLifecycleEventTypes.Phase,
    };
    private const int MaxManifestFiles = 256;
    private const int MaxAdapterEvents = 1000;
    private const long MaxManifestFileBytes = 100L * 1024 * 1024;
    private const long MaxManifestTotalBytes = 100L * 1024 * 1024;

    private readonly MongoDbContext _db;
    private readonly IRunEventStore _events;

    public DesignArtifactLifecycleService(MongoDbContext db, IRunEventStore events)
    {
        _db = db;
        _events = events;
    }

    public async Task<DesignArtifactRun> CreateSessionAsync(
        CreateDesignArtifactSessionRequest request,
        CancellationToken ct = default)
    {
        var runId = Required(request.RunId, "runId", 128);
        var userId = Required(request.UserId, "userId", 128);
        var artifactType = SafeToken(request.ArtifactType, "artifactType", 64);
        var operation = SafeToken(request.Operation, "operation", 64);
        var sourceSurface = SafeToken(request.SourceSurface, "sourceSurface", 64);
        var runtime = SafeToken(request.Runtime, "runtime", 64);
        var capability = NormalizeCapability(request.Capability);
        var workspace = NormalizeWorkspace(request.WorkspaceRef);
        ValidateCapability(capability, artifactType, operation, sourceSurface, runtime, workspace);
        var boundary = NormalizeBoundary(request.VersionBoundary);
        var parentPlanRunId = Optional(request.ParentPlanRunId, 128);
        var parentPlanContentHash = OptionalHash(request.ParentPlanContentHash);
        if ((parentPlanRunId == null) != (parentPlanContentHash == null))
            throw Invalid("父规划任务标识与内容哈希必须同时提供");
        if (operation == DesignArtifactOperations.Generate && parentPlanRunId != null)
            await ValidateParentPlanAsync(parentPlanRunId, parentPlanContentHash!, userId);
        else if (parentPlanRunId != null)
            throw Invalid("只有生成任务可以绑定父规划结果");

        var now = DateTime.UtcNow;
        var runEvent = new DesignArtifactEventEnvelope
        {
            RunId = runId,
            ArtifactType = artifactType,
            Sequence = 1,
            Type = DesignArtifactLifecycleEventTypes.Run,
            Phase = "设计任务已开始",
            Progress = 0,
            OccurredAt = now,
            Authoritative = true,
        };
        var run = new DesignArtifactRun
        {
            Id = runId,
            UserId = userId,
            Status = RunStatuses.Running,
            ArtifactType = artifactType,
            Operation = operation,
            SourceSurface = sourceSurface,
            Runtime = runtime,
            Title = Optional(request.Title, 200),
            ContractVersion = DesignArtifactContractVersions.Current,
            LifecycleVersion = 1,
            LifecycleEventSequence = 1,
            LifecycleEvents = [runEvent],
            WorkspaceRef = workspace,
            Capability = capability,
            VersionBoundary = boundary,
            ParentPlanRunId = parentPlanRunId,
            ParentPlanContentHash = parentPlanContentHash,
            Progress = 0,
            Phase = runEvent.Phase!,
            CreatedAt = now,
            UpdatedAt = now,
        };

        try
        {
            await _db.DesignArtifactRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            throw Conflict();
        }

        await ProjectRunMetaBestEffortAsync(run);
        return run;
    }

    public async Task<DesignArtifactEventEnvelope> AppendEventAsync(
        AppendDesignArtifactEventRequest request,
        CancellationToken ct = default)
    {
        var type = SafeToken(request.Type, "type", 64);
        if (!AdapterEventTypes.Contains(type))
            throw Invalid("adapter 只能追加非权威阶段事件");
        var phase = Required(request.Phase, "phase", 200);
        if (request.Progress is < 0 or > 99)
            throw Invalid("adapter 事件进度必须介于 0 到 99");

        for (var attempt = 0; attempt < 12; attempt++)
        {
            var current = await GetOwnedV2Async(request.RunId, request.UserId);
            if (request.Expected != null)
                ValidateExpectation(current, request.Expected);
            else
                ValidateLeaseAuthority(current, null);
            if (current.Status is not (RunStatuses.Running or RunStatuses.Committing))
                throw Conflict();
            if (current.LifecycleEvents.Count(item => !item.Authoritative) >= MaxAdapterEvents)
                throw Invalid("adapter 阶段事件已达到生命周期保留上限");
            if (request.Progress.HasValue && request.Progress.Value < current.Progress)
                throw Invalid("事件进度不能倒退");

            var now = DateTime.UtcNow;
            var updates = new BsonDocument
            {
                { nameof(DesignArtifactRun.Phase), phase },
                { nameof(DesignArtifactRun.UpdatedAt), now },
            };
            if (request.Progress.HasValue)
                updates[nameof(DesignArtifactRun.Progress)] = request.Progress.Value;
            var eventFilter = Builders<DesignArtifactRun>.Filter.And(
                    OwnedV2Filter(current.Id, current.UserId),
                    Builders<DesignArtifactRun>.Filter.Eq(item => item.LifecycleEventSequence, current.LifecycleEventSequence),
                    Builders<DesignArtifactRun>.Filter.In(item => item.Status, [RunStatuses.Running, RunStatuses.Committing]),
                    LeaseAuthorityFilter(current, request.Expected));
            var updated = await AtomicUpdateWithEventAsync(
                eventFilter,
                current,
                updates,
                type,
                phase,
                request.Progress,
                false,
                incrementLifecycle: false);
            if (updated != null)
                return updated.LifecycleEvents[^1];
        }
        throw Conflict();
    }

    public async Task<DesignArtifactRun> StartAsync(
        StartDesignArtifactSessionRequest request,
        CancellationToken ct = default)
    {
        var current = await GetExpectedAsync(request.RunId, request.UserId, request.Expected);
        if (current.Status != RunStatuses.Queued)
            throw Conflict();
        var leaseOwner = SafeToken(request.LeaseOwnerId, "leaseOwnerId", 256);
        var now = DateTime.UtcNow;
        if (request.LeaseExpiresAt <= now || request.LeaseExpiresAt > now.AddHours(1))
            throw Invalid("执行租约期限无效");

        var updated = await AtomicUpdateWithEventAsync(
            Builders<DesignArtifactRun>.Filter.And(
                CasFilter(current, request.Expected, RunStatuses.Queued),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.CancelRequestedAt, null)),
            current,
            new BsonDocument
            {
                { nameof(DesignArtifactRun.Status), RunStatuses.Running },
                { nameof(DesignArtifactRun.LeaseOwnerId), leaseOwner },
                { nameof(DesignArtifactRun.LeaseExpiresAt), request.LeaseExpiresAt },
                { nameof(DesignArtifactRun.HeartbeatAt), now },
                { nameof(DesignArtifactRun.Phase), "设计任务执行中" },
                { nameof(DesignArtifactRun.UpdatedAt), now },
            },
            DesignArtifactLifecycleEventTypes.Phase,
            "设计任务执行中",
            current.Progress,
            true);
        if (updated == null) throw Conflict();
        await ProjectRunMetaBestEffortAsync(updated);
        return updated;
    }

    public async Task<DesignArtifactRun> CommitManifestAsync(
        CommitDesignArtifactManifestRequest request,
        CancellationToken ct = default)
    {
        var current = await GetExpectedAsync(request.RunId, request.UserId, request.Expected);
        if (current.Status != RunStatuses.Running
            || current.Operation == DesignArtifactOperations.Plan
            || current.CancelRequestedAt.HasValue)
            throw Conflict();
        var manifest = NormalizeManifest(request.Manifest, current);
        var hashes = ComputeManifestHashes(manifest);
        var receipt = NormalizeValidationReceipt(request.ValidationReceipt, current, hashes);
        await ValidateTrustedManifestReceiptAsync(current, receipt, hashes);
        var boundary = NormalizeBoundary(current.VersionBoundary);
        if (boundary.EntryContentHash != null && !FixedHashEquals(boundary.EntryContentHash, hashes.EntryContentHash))
            throw Conflict();
        if (boundary.CanonicalManifestHash != null && !FixedHashEquals(boundary.CanonicalManifestHash, hashes.CanonicalManifestHash))
            throw Conflict();
        if (boundary.PackageHash != null && !FixedHashEquals(boundary.PackageHash, hashes.PackageHash))
            throw Conflict();
        if (boundary.OutputContentHash != null && !FixedHashEquals(boundary.OutputContentHash, hashes.PackageHash))
            throw Conflict();
        boundary.EntryContentHash = hashes.EntryContentHash;
        boundary.CanonicalManifestHash = hashes.CanonicalManifestHash;
        boundary.PackageHash = hashes.PackageHash;
        boundary.OutputContentHash = hashes.PackageHash;

        var now = DateTime.UtcNow;
        var updated = await AtomicUpdateWithEventAsync(
            Builders<DesignArtifactRun>.Filter.And(
                CasFilter(current, request.Expected, RunStatuses.Running),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.CancelRequestedAt, null)),
            current,
            new BsonDocument
            {
                { nameof(DesignArtifactRun.Manifest), manifest.ToBsonDocument() },
                { nameof(DesignArtifactRun.ManifestValidation), receipt.ToBsonDocument() },
                { nameof(DesignArtifactRun.VersionBoundary), boundary.ToBsonDocument() },
                { nameof(DesignArtifactRun.Status), RunStatuses.Committing },
                { nameof(DesignArtifactRun.Phase), "产物清单已提交" },
                { nameof(DesignArtifactRun.Progress), Math.Max(current.Progress, 95) },
                { nameof(DesignArtifactRun.UpdatedAt), now },
            },
            DesignArtifactLifecycleEventTypes.Manifest,
            "产物清单已提交",
            Math.Max(current.Progress, 95),
            true);
        if (updated == null) throw Conflict();
        await ProjectRunMetaBestEffortAsync(updated);
        return updated;
    }

    public async Task<DesignArtifactRun> CompleteAsync(
        DesignArtifactLifecycleMutationRequest request,
        CancellationToken ct = default)
    {
        var current = await GetExpectedAsync(request.RunId, request.UserId, request.Expected);
        var isPlanning = current.Operation == DesignArtifactOperations.Plan;
        var expectedStatus = isPlanning ? RunStatuses.Running : RunStatuses.Committing;
        if (current.Status != expectedStatus)
            throw Conflict();
        DesignArtifactPlanReceipt? planReceipt = null;
        if (isPlanning)
        {
            planReceipt = NormalizePlanReceipt(request.PlanReceipt);
            await ValidateTrustedPlanReceiptAsync(current, planReceipt);
        }
        else if (request.PlanReceipt != null || current.Manifest == null || current.ManifestValidation == null)
            throw Conflict();

        var now = DateTime.UtcNow;
        var updates = new BsonDocument
        {
            { nameof(DesignArtifactRun.Status), RunStatuses.Done },
            { nameof(DesignArtifactRun.Progress), 100 },
            { nameof(DesignArtifactRun.Phase), isPlanning ? "设计规划已完成" : "设计产物已完成" },
            { nameof(DesignArtifactRun.CompletedAt), now },
            { nameof(DesignArtifactRun.UpdatedAt), now },
        };
        if (planReceipt != null)
            updates[nameof(DesignArtifactRun.PlanReceipt)] = planReceipt.ToBsonDocument();
        var updated = await AtomicUpdateWithEventAsync(
            CasFilter(current, request.Expected, expectedStatus),
            current,
            updates,
            DesignArtifactLifecycleEventTypes.Done,
            isPlanning ? "设计规划已完成" : "设计产物已完成",
            100,
            true);
        if (updated == null) throw Conflict();
        await ProjectRunMetaBestEffortAsync(updated);
        return updated;
    }

    public async Task<DesignArtifactRun> FailAsync(
        FailDesignArtifactSessionRequest request,
        CancellationToken ct = default)
    {
        var current = await GetExpectedAsync(request.RunId, request.UserId, request.Expected);
        if (current.Status is not (RunStatuses.Running or RunStatuses.Committing))
            throw Conflict();
        var failureCode = SafeToken(request.FailureCode, "failureCode", 64);
        var now = DateTime.UtcNow;
        var updated = await AtomicUpdateWithEventAsync(
            CasFilter(current, request.Expected, current.Status),
            current,
            new BsonDocument
            {
                { nameof(DesignArtifactRun.Status), RunStatuses.Error },
                { nameof(DesignArtifactRun.LifecycleFailureCode), failureCode },
                { nameof(DesignArtifactRun.Phase), "设计任务未完成" },
                { nameof(DesignArtifactRun.CompletedAt), now },
                { nameof(DesignArtifactRun.UpdatedAt), now },
            },
            DesignArtifactLifecycleEventTypes.Error,
            "设计任务未完成",
            current.Progress,
            true);
        if (updated == null) throw Conflict();
        await ProjectRunMetaBestEffortAsync(updated);
        return updated;
    }

    public async Task<DesignArtifactRun> RequestCancellationAsync(
        RequestDesignArtifactCancellationRequest request,
        CancellationToken ct = default)
    {
        var current = await GetOwnedV2Async(request.RunId, request.UserId);
        if (current.Status == RunStatuses.Cancelled)
            return current;
        if (current.Status == RunStatuses.Running && current.CancelRequestedAt.HasValue)
            return current;
        ValidateClientExpectation(
            current,
            request.ExpectedLifecycleVersion,
            request.ExpectedBaseRevision,
            request.ExpectedBaseContentHash);
        if (current.Status is not (RunStatuses.Queued or RunStatuses.Running))
            throw Conflict();

        var now = DateTime.UtcNow;
        var terminal = current.Status == RunStatuses.Queued;
        var filter = Builders<DesignArtifactRun>.Filter.And(
            ClientCasFilter(
                current,
                request.ExpectedLifecycleVersion,
                request.ExpectedBaseRevision,
                request.ExpectedBaseContentHash),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.Status, current.Status),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.CancelRequestedAt, null),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.LeaseOwnerId, current.LeaseOwnerId),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.LeaseExpiresAt, current.LeaseExpiresAt));
        var updates = new BsonDocument
        {
            { nameof(DesignArtifactRun.CancelRequestedAt), now },
            { nameof(DesignArtifactRun.CancelRequestedByUserId), current.UserId },
            { nameof(DesignArtifactRun.Phase), terminal ? "设计任务已取消" : "正在停止设计任务" },
            { nameof(DesignArtifactRun.UpdatedAt), now },
        };
        if (terminal)
        {
            updates[nameof(DesignArtifactRun.Status)] = RunStatuses.Cancelled;
            updates[nameof(DesignArtifactRun.CancelledAt)] = now;
            updates[nameof(DesignArtifactRun.CompletedAt)] = now;
            updates[nameof(DesignArtifactRun.LeaseOwnerId)] = BsonNull.Value;
            updates[nameof(DesignArtifactRun.LeaseExpiresAt)] = BsonNull.Value;
        }
        var updated = await AtomicUpdateWithEventAsync(
            filter,
            current,
            updates,
            terminal ? DesignArtifactLifecycleEventTypes.Cancelled : DesignArtifactLifecycleEventTypes.CancelRequested,
            terminal ? "设计任务已取消" : "正在停止设计任务",
            current.Progress,
            true);
        if (updated == null) throw Conflict();
        await ProjectRunMetaBestEffortAsync(updated);
        return updated;
    }

    public async Task<DesignArtifactRun> CancelAsync(
        CancelDesignArtifactSessionRequest request,
        CancellationToken ct = default)
    {
        var current = await GetOwnedV2Async(request.RunId, request.UserId);
        if (current.Status == RunStatuses.Cancelled)
            return current;
        ValidateExpectation(current, request.Expected);
        if (current.Status != RunStatuses.Running
            || !current.CancelRequestedAt.HasValue
            || !string.Equals(current.CancelRequestedByUserId, current.UserId, StringComparison.Ordinal))
            throw Conflict();

        var now = DateTime.UtcNow;
        var updated = await AtomicUpdateWithEventAsync(
            Builders<DesignArtifactRun>.Filter.And(
                CasFilter(current, request.Expected, RunStatuses.Running),
                Builders<DesignArtifactRun>.Filter.Ne(item => item.CancelRequestedAt, null),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.CancelRequestedByUserId, current.UserId),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.ProducedArtifactSiteId, null),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.ProducedArtifactRevisionId, null)),
            current,
            new BsonDocument
            {
                { nameof(DesignArtifactRun.Status), RunStatuses.Cancelled },
                { nameof(DesignArtifactRun.Phase), "设计任务已取消" },
                { nameof(DesignArtifactRun.Error), BsonNull.Value },
                { nameof(DesignArtifactRun.LifecycleFailureCode), BsonNull.Value },
                { nameof(DesignArtifactRun.CancelledAt), now },
                { nameof(DesignArtifactRun.CompletedAt), now },
                { nameof(DesignArtifactRun.LeaseExpiresAt), BsonNull.Value },
                { nameof(DesignArtifactRun.UpdatedAt), now },
            },
            DesignArtifactLifecycleEventTypes.Cancelled,
            "设计任务已取消",
            current.Progress,
            true);
        if (updated == null) throw Conflict();
        await ProjectRunMetaBestEffortAsync(updated);
        return updated;
    }

    public async Task<DesignArtifactRun> ResumeResultReadyAsync(
        ResumeResultReadyDesignArtifactSessionRequest request,
        CancellationToken ct = default)
    {
        var current = await GetExpectedAsync(request.RunId, request.UserId, request.Expected);
        if (current.Status is not (RunStatuses.Running or RunStatuses.Committing)
            || current.Runtime != DesignArtifactRuntimes.OpenDesign
            || string.IsNullOrWhiteSpace(current.WorkspaceResultAssetKey)
            || !string.IsNullOrWhiteSpace(current.ProducedArtifactSiteId)
            || !string.IsNullOrWhiteSpace(current.ProducedArtifactRevisionId)
            || current.CancelRequestedAt.HasValue
            || !request.Expected.Recovery)
            throw Conflict();

        var now = DateTime.UtcNow;
        var updated = await AtomicUpdateWithEventAsync(
            Builders<DesignArtifactRun>.Filter.And(
                CasFilter(current, request.Expected, current.Status),
                Builders<DesignArtifactRun>.Filter.Eq(
                    item => item.WorkspaceResultAssetKey,
                    current.WorkspaceResultAssetKey),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.ProducedArtifactSiteId, null),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.ProducedArtifactRevisionId, null),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.CancelRequestedAt, null)),
            current,
            new BsonDocument
            {
                { nameof(DesignArtifactRun.Status), RunStatuses.Queued },
                { nameof(DesignArtifactRun.Phase), "已恢复提交结果，等待继续保存" },
                { nameof(DesignArtifactRun.LeaseOwnerId), BsonNull.Value },
                { nameof(DesignArtifactRun.LeaseExpiresAt), BsonNull.Value },
                { nameof(DesignArtifactRun.HeartbeatAt), BsonNull.Value },
                { nameof(DesignArtifactRun.RecoveryEnqueuedAt), BsonNull.Value },
                { nameof(DesignArtifactRun.CompletedAt), BsonNull.Value },
                { nameof(DesignArtifactRun.Error), BsonNull.Value },
                { nameof(DesignArtifactRun.UpdatedAt), now },
            },
            DesignArtifactLifecycleEventTypes.Recovered,
            "已恢复提交结果，等待继续保存",
            current.Progress,
            true);
        if (updated == null) throw Conflict();
        await ProjectRunMetaBestEffortAsync(updated);
        return updated;
    }

    public async Task<DesignArtifactRun> BindPublishedArtifactAsync(
        BindPublishedDesignArtifactRequest request,
        CancellationToken ct = default)
    {
        var runId = Required(request.RunId, "runId", 128);
        var userId = Required(request.UserId, "userId", 128);
        var operationId = SafeToken(request.OperationId, "operationId", 128);
        var artifactId = Required(request.ArtifactId, "artifactId", 128);
        var versionId = Required(request.VersionId, "versionId", 128);
        var artifactHash = RequiredHash(request.ArtifactHash);
        var fingerprint = Sha256Hex($"{artifactId}\n{versionId}\n{artifactHash}");

        var current = await GetOwnedV2Async(runId, userId);
        await ValidatePublishedReceiptAsync(current, artifactId, versionId, artifactHash);
        if (current.PublishBindingOperationId != null)
        {
            if (current.PublishBindingOperationId == operationId
                && FixedHashEquals(current.PublishBindingFingerprint, fingerprint))
                return current;
            throw Conflict();
        }
        if (current.Status != RunStatuses.Done || current.Operation == DesignArtifactOperations.Plan)
            throw Conflict();
        ValidateExpectation(current, request.Expected);

        var now = DateTime.UtcNow;
        var filter = Builders<DesignArtifactRun>.Filter.And(
            CasFilter(current, request.Expected, RunStatuses.Done),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.PublishBindingOperationId, null),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.ArtifactSiteId, null),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.ArtifactRevisionId, null));
        var updated = await AtomicUpdateWithEventAsync(
            filter,
            current,
            new BsonDocument
            {
                { nameof(DesignArtifactRun.ArtifactSiteId), artifactId },
                { nameof(DesignArtifactRun.ArtifactRevisionId), versionId },
                { nameof(DesignArtifactRun.PublishBindingOperationId), operationId },
                { nameof(DesignArtifactRun.PublishBindingFingerprint), fingerprint },
                { nameof(DesignArtifactRun.UpdatedAt), now },
            },
            DesignArtifactLifecycleEventTypes.Published,
            "设计产物已绑定发布版本",
            100,
            true);
        if (updated != null) return updated;

        var winner = await GetOwnedV2Async(runId, userId);
        if (winner.PublishBindingOperationId == operationId
            && FixedHashEquals(winner.PublishBindingFingerprint, fingerprint))
            return winner;
        throw Conflict();
    }

    internal static DesignArtifactManifestHashes ComputeManifestHashes(DesignArtifactContractManifest manifest)
    {
        var packageHash = DesignArtifactPublicRevision.Compute(manifest.Files.Select(file =>
            new DesignArtifactPublicRevisionFile(file.Path, file.Sha256, file.ByteLength, file.MediaType)));
        var manifestCanonical = new StringBuilder();
        AppendCanonical(
            manifestCanonical,
            manifest.SchemaVersion,
            manifest.ArtifactType,
            manifest.EntryFile,
            manifest.SecurityProfile,
            packageHash);
        var entryHash = manifest.Files.Single(file => file.Path == manifest.EntryFile).Sha256;
        return new DesignArtifactManifestHashes(
            entryHash,
            Sha256Hex(manifestCanonical.ToString()),
            packageHash,
            manifest.Files.Sum(file => file.ByteLength));
    }

    private async Task<DesignArtifactRun?> AtomicUpdateWithEventAsync(
        FilterDefinition<DesignArtifactRun> filter,
        DesignArtifactRun current,
        BsonDocument updates,
        string eventType,
        string? phase,
        int? progress,
        bool authoritative,
        bool incrementLifecycle = true)
    {
        var nextSequence = new BsonDocument("$add", new BsonArray
        {
            new BsonDocument("$ifNull", new BsonArray { $"${nameof(DesignArtifactRun.LifecycleEventSequence)}", 0 }),
            1,
        });
        var eventDocument = new BsonDocument
        {
            { nameof(DesignArtifactEventEnvelope.RunId), current.Id },
            { nameof(DesignArtifactEventEnvelope.ArtifactType), current.ArtifactType },
            { nameof(DesignArtifactEventEnvelope.Sequence), nextSequence },
            { nameof(DesignArtifactEventEnvelope.Type), eventType },
            { nameof(DesignArtifactEventEnvelope.Phase), phase == null ? BsonNull.Value : phase },
            { nameof(DesignArtifactEventEnvelope.Progress), progress.HasValue ? progress.Value : BsonNull.Value },
            { nameof(DesignArtifactEventEnvelope.OccurredAt), DateTime.UtcNow },
            { nameof(DesignArtifactEventEnvelope.Authoritative), authoritative },
        };
        updates[nameof(DesignArtifactRun.LifecycleEventSequence)] = nextSequence;
        updates[nameof(DesignArtifactRun.LifecycleEvents)] = new BsonDocument("$concatArrays", new BsonArray
        {
            new BsonDocument("$ifNull", new BsonArray { $"${nameof(DesignArtifactRun.LifecycleEvents)}", new BsonArray() }),
            new BsonArray { eventDocument },
        });
        if (incrementLifecycle)
        {
            updates[nameof(DesignArtifactRun.LifecycleVersion)] = new BsonDocument("$add", new BsonArray
            {
                $"${nameof(DesignArtifactRun.LifecycleVersion)}",
                1,
            });
        }
        return await _db.DesignArtifactRuns.FindOneAndUpdateAsync(
            filter,
            Builders<DesignArtifactRun>.Update.Pipeline(
                new BsonDocument[] { new("$set", updates) }),
            new FindOneAndUpdateOptions<DesignArtifactRun, DesignArtifactRun>
            {
                ReturnDocument = ReturnDocument.After,
            },
            CancellationToken.None);
    }

    private async Task ValidateParentPlanAsync(string planRunId, string planHash, string userId)
    {
        var plan = await _db.DesignArtifactRuns.Find(item => item.Id == planRunId && item.UserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (plan == null
            || plan.ContractVersion != DesignArtifactContractVersions.Current
            || plan.Operation != DesignArtifactOperations.Plan
            || plan.Status != RunStatuses.Done
            || plan.PlanReceipt == null
            || !FixedHashEquals(plan.PlanReceipt.ContentHash, planHash))
            throw Invalid("父规划结果不存在、未完成或哈希不一致");
    }

    private async Task ValidateTrustedManifestReceiptAsync(
        DesignArtifactRun run,
        DesignArtifactManifestValidationReceipt receipt,
        DesignArtifactManifestHashes hashes)
    {
        if (receipt.Validator != run.Capability?.Adapter)
            throw Invalid("manifest 校验器与执行能力不一致");
        if (run.WorkspaceRef?.Kind == DesignArtifactWorkspaceKinds.RemotePackage)
        {
            if (string.IsNullOrWhiteSpace(run.WorkspaceResultAssetKey)
                || !FixedHashEquals(run.WorkspaceResultSha256, receipt.SourcePackageHash)
                || !FixedHashEquals(run.WorkspaceManifestSha256, receipt.SourceManifestHash))
                throw Invalid("远程工作区尚无受信提交事实或回执不一致");
            return;
        }

        if (run.ArtifactType == DesignArtifactTypes.HtmlPpt
            && run.WorkspaceRef?.Kind == DesignArtifactWorkspaceKinds.AdapterOwned)
        {
            var source = await _db.MdToPptRuns.Find(item => item.Id == run.Id
                                                            && item.UserId == run.UserId
                                                            && item.Status == "done"
                                                            && item.ArtifactContractVersion == DesignArtifactContractVersions.Current)
                .FirstOrDefaultAsync(CancellationToken.None);
            var bytes = Encoding.UTF8.GetBytes(source?.Html ?? string.Empty);
            if (source == null
                || bytes.LongLength != hashes.TotalBytes
                || !FixedHashEquals(source.HtmlHash, hashes.EntryContentHash)
                || !FixedHashEquals(Sha256Hex(bytes), hashes.EntryContentHash))
                throw Invalid("HTML PPT manifest 与权威完成态字节不一致");
            return;
        }
        throw Invalid("当前工作区类型没有受信 manifest 校验来源");
    }

    private async Task ValidateTrustedPlanReceiptAsync(
        DesignArtifactRun run,
        DesignArtifactPlanReceipt receipt)
    {
        if (run.ArtifactType != DesignArtifactTypes.HtmlPpt
            || run.WorkspaceRef?.Kind != DesignArtifactWorkspaceKinds.AdapterOwned)
            return;
        var source = await _db.MdToPptRuns.Find(item => item.Id == run.Id
                                                        && item.UserId == run.UserId
                                                        && item.Status == "done"
                                                        && item.Op == "outline"
                                                        && item.ArtifactContractVersion == DesignArtifactContractVersions.Current)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (source == null
            || !FixedHashEquals(source.OutlineHash, receipt.ContentHash)
            || !FixedHashEquals(source.UserSuppliedContentHash, receipt.InputHash))
            throw Invalid("规划回执与权威 HTML PPT 大纲不一致");
    }

    private async Task ValidatePublishedReceiptAsync(
        DesignArtifactRun run,
        string siteId,
        string versionId,
        string artifactHash)
    {
        var site = await _db.HostedSites.Find(item => item.Id == siteId && item.OwnerUserId == run.UserId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (site == null) throw Invalid("发布站点不存在或不属于当前用户");

        if (run.ArtifactType == DesignArtifactTypes.WebPage)
        {
            if (!string.Equals(run.ProducedArtifactSiteId, siteId, StringComparison.Ordinal)
                || !string.Equals(run.ProducedArtifactRevisionId, versionId, StringComparison.Ordinal))
                throw Invalid("发布版本与任务形成的产物不一致");
            var revision = await _db.HostedSiteRevisions
                .Find(item => item.Id == versionId
                              && item.SiteId == siteId
                              && item.SourceRunId == run.Id
                              && item.CreatedByUserId == run.UserId
                              && item.Runtime == run.Runtime
                              && item.Status == HostedSiteRevisionStatuses.Published)
                .FirstOrDefaultAsync(CancellationToken.None)
                ?? throw Invalid("发布版本不存在、归属不一致或不是当前任务的产物");
            if (revision.VerifiedFiles is not { Count: > 0 } || run.Manifest == null)
                throw Invalid("发布版本缺少受信产物字节");

            var actualFiles = new List<DesignArtifactPublicRevisionFile>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var file in revision.VerifiedFiles)
            {
                var path = StrictRelativePath(file.Path);
                if (!seen.Add(path)) throw Invalid("发布版本包含重复文件路径");
                if (string.Equals(path, DesignArtifactPublicRevision.InternalManifestPath, StringComparison.Ordinal))
                    continue;
                if (file.Content == null) throw Invalid("发布版本文件正文不存在");
                actualFiles.Add(new DesignArtifactPublicRevisionFile(
                    path,
                    Sha256Hex(file.Content),
                    file.Content.LongLength,
                    StrictMediaType(file.MimeType)));
            }
            if (actualFiles.Count != run.Manifest.Files.Count)
                throw Invalid("发布版本文件数量与设计产物不一致");
            var manifestByPath = run.Manifest.Files.ToDictionary(file => file.Path, StringComparer.Ordinal);
            foreach (var file in actualFiles)
            {
                if (!manifestByPath.TryGetValue(file.Path, out var expected)
                    || expected.ByteLength != file.Size
                    || !FixedHashEquals(expected.Sha256, file.Sha256)
                    || !string.Equals(expected.MediaType, file.MediaType, StringComparison.OrdinalIgnoreCase))
                    throw Invalid("发布版本字节与设计产物清单不一致");
            }
            var packageHash = DesignArtifactPublicRevision.Compute(actualFiles);
            if (!FixedHashEquals(packageHash, artifactHash)
                || !FixedHashEquals(run.VersionBoundary?.PackageHash, artifactHash))
                throw Invalid("发布版本整包哈希与设计产物不一致");
            return;
        }

        var source = await _db.MdToPptRuns.Find(item => item.Id == run.Id
                                                        && item.UserId == run.UserId
                                                        && item.PublishedSiteId == siteId
                                                        && item.PublishedVersionId == versionId
                                                        && item.Status == "done")
            .FirstOrDefaultAsync(CancellationToken.None);
        var htmlPptRevision = await _db.HostedSiteRevisions.Find(item => item.Id == versionId
                                                                  && item.SiteId == siteId
                                                                  && item.CreatedByUserId == run.UserId
                                                                  && item.SourceRunId == run.Id
                                                                  && item.Runtime == DesignArtifactRuntimes.HtmlPptPipeline
                                                                  && item.Status == HostedSiteRevisionStatuses.Published)
            .FirstOrDefaultAsync(CancellationToken.None);
        var revisionHash = htmlPptRevision == null
            ? null
            : Sha256Hex(Encoding.UTF8.GetBytes(htmlPptRevision.Html ?? string.Empty));
        if (source == null
            || htmlPptRevision == null
            || !string.Equals(site.PublishedRevisionId, versionId, StringComparison.Ordinal)
            || htmlPptRevision.PublishedContentVersion != site.ContentVersion
            || !FixedHashEquals(source.PublishedHtmlHash, artifactHash)
            || !FixedHashEquals(source.HtmlHash, artifactHash)
            || !FixedHashEquals(run.VersionBoundary?.EntryContentHash, artifactHash)
            || !FixedHashEquals(
                run.Manifest?.Files.SingleOrDefault(file => file.Path == run.Manifest.EntryFile)?.Sha256,
                artifactHash)
            || !FixedHashEquals(revisionHash, artifactHash))
            throw Invalid("HTML PPT 发布回执与设计产物不一致");
    }

    private async Task<DesignArtifactRun> GetOwnedV2Async(string runId, string userId)
    {
        var normalizedRunId = Required(runId, "runId", 128);
        var normalizedUserId = Required(userId, "userId", 128);
        var run = await _db.DesignArtifactRuns
            .Find(item => item.Id == normalizedRunId && item.UserId == normalizedUserId)
            .FirstOrDefaultAsync(CancellationToken.None);
        if (run == null)
            throw new DesignArtifactLifecycleException(
                DesignArtifactLifecycleErrorCodes.NotFound,
                "设计任务不存在");
        if (run.ContractVersion != DesignArtifactContractVersions.Current)
            throw new DesignArtifactLifecycleException(
                DesignArtifactLifecycleErrorCodes.UnsupportedVersion,
                "不支持该设计任务合同版本");
        return run;
    }

    private async Task<DesignArtifactRun> GetExpectedAsync(
        string runId,
        string userId,
        DesignArtifactLifecycleExpectation expected)
    {
        var current = await GetOwnedV2Async(runId, userId);
        ValidateExpectation(current, expected);
        return current;
    }

    private static void ValidateExpectation(
        DesignArtifactRun current,
        DesignArtifactLifecycleExpectation expected)
    {
        if (expected == null || expected.LifecycleVersion < 1)
            throw Invalid("缺少有效的生命周期版本");
        if (current.LifecycleVersion != expected.LifecycleVersion
            || !string.Equals(current.WorkspaceRef?.BaseRevision, Optional(expected.BaseRevision, 200), StringComparison.Ordinal)
            || !string.Equals(current.VersionBoundary?.BaseContentHash, OptionalHash(expected.BaseContentHash), StringComparison.Ordinal))
            throw Conflict();
        ValidateLeaseAuthority(current, expected);
    }

    private static FilterDefinition<DesignArtifactRun> OwnedV2Filter(string runId, string userId)
    {
        var filter = Builders<DesignArtifactRun>.Filter;
        return filter.And(
            filter.Eq(item => item.Id, runId),
            filter.Eq(item => item.UserId, userId),
            filter.Eq(item => item.ContractVersion, DesignArtifactContractVersions.Current));
    }

    private static FilterDefinition<DesignArtifactRun> CasFilter(
        DesignArtifactRun current,
        DesignArtifactLifecycleExpectation expected,
        string status)
    {
        var filter = Builders<DesignArtifactRun>.Filter;
        return filter.And(
            OwnedV2Filter(current.Id, current.UserId),
            filter.Eq(item => item.LifecycleVersion, expected.LifecycleVersion),
            filter.Eq(item => item.Status, status),
            filter.Eq(item => item.WorkspaceRef!.BaseRevision, Optional(expected.BaseRevision, 200)),
            filter.Eq(item => item.VersionBoundary!.BaseContentHash, OptionalHash(expected.BaseContentHash)),
            LeaseAuthorityFilter(current, expected));
    }

    private static void ValidateClientExpectation(
        DesignArtifactRun current,
        int expectedLifecycleVersion,
        string? expectedBaseRevision,
        string? expectedBaseContentHash)
    {
        if (expectedLifecycleVersion < 1)
            throw Invalid("缺少有效的生命周期版本");
        if (current.LifecycleVersion != expectedLifecycleVersion
            || !string.Equals(
                current.WorkspaceRef?.BaseRevision,
                Optional(expectedBaseRevision, 200),
                StringComparison.Ordinal)
            || !string.Equals(
                current.VersionBoundary?.BaseContentHash,
                OptionalHash(expectedBaseContentHash),
                StringComparison.Ordinal))
            throw Conflict();
    }

    private static FilterDefinition<DesignArtifactRun> ClientCasFilter(
        DesignArtifactRun current,
        int expectedLifecycleVersion,
        string? expectedBaseRevision,
        string? expectedBaseContentHash)
    {
        var filter = Builders<DesignArtifactRun>.Filter;
        return filter.And(
            OwnedV2Filter(current.Id, current.UserId),
            filter.Eq(item => item.LifecycleVersion, expectedLifecycleVersion),
            filter.Eq(item => item.WorkspaceRef!.BaseRevision, Optional(expectedBaseRevision, 200)),
            filter.Eq(item => item.VersionBoundary!.BaseContentHash, OptionalHash(expectedBaseContentHash)));
    }

    private static void ValidateLeaseAuthority(
        DesignArtifactRun current,
        DesignArtifactLifecycleExpectation? expected)
    {
        var hasPersistedLease = current.Status is RunStatuses.Running or RunStatuses.Committing
                                && (!string.IsNullOrWhiteSpace(current.LeaseOwnerId)
                                    || current.LeaseExpiresAt.HasValue);
        if (string.IsNullOrWhiteSpace(expected?.LeaseOwnerId))
        {
            if (hasPersistedLease) throw Conflict();
            return;
        }
        var owner = SafeToken(expected.LeaseOwnerId, "leaseOwnerId", 256);
        if (!string.Equals(current.LeaseOwnerId, owner, StringComparison.Ordinal))
            throw Conflict();
        if (expected.Recovery)
        {
            if (!expected.ObservedLeaseExpiresAt.HasValue
                || current.LeaseExpiresAt != expected.ObservedLeaseExpiresAt
                || current.LeaseExpiresAt > DateTime.UtcNow)
                throw Conflict();
            return;
        }
        if (current.LeaseExpiresAt <= DateTime.UtcNow)
            throw Conflict();
    }

    private static FilterDefinition<DesignArtifactRun> LeaseAuthorityFilter(
        DesignArtifactRun current,
        DesignArtifactLifecycleExpectation? expected)
    {
        var filter = Builders<DesignArtifactRun>.Filter;
        if (string.IsNullOrWhiteSpace(expected?.LeaseOwnerId))
        {
            if (current.Status is RunStatuses.Running or RunStatuses.Committing
                && (!string.IsNullOrWhiteSpace(current.LeaseOwnerId) || current.LeaseExpiresAt.HasValue))
                throw Conflict();
            return filter.And(
                filter.Eq(item => item.LeaseOwnerId, current.LeaseOwnerId),
                filter.Eq(item => item.LeaseExpiresAt, current.LeaseExpiresAt));
        }
        var owner = SafeToken(expected.LeaseOwnerId, "leaseOwnerId", 256);
        return expected.Recovery
            ? filter.And(
                filter.Eq(item => item.LeaseOwnerId, owner),
                filter.Eq(item => item.LeaseExpiresAt, expected.ObservedLeaseExpiresAt),
                filter.Lte(item => item.LeaseExpiresAt, DateTime.UtcNow))
            : filter.And(
                filter.Eq(item => item.LeaseOwnerId, owner),
                filter.Gt(item => item.LeaseExpiresAt, DateTime.UtcNow));
    }

    private async Task ProjectRunMetaBestEffortAsync(DesignArtifactRun run)
    {
        try
        {
            await _events.SetRunAsync(
                RunKinds.DesignArtifact,
                new RunMeta
                {
                    RunId = run.Id,
                    Kind = RunKinds.DesignArtifact,
                    Status = run.Status,
                    CreatedByUserId = run.UserId,
                    CreatedAt = run.CreatedAt,
                    StartedAt = run.CreatedAt,
                    EndedAt = run.CompletedAt,
                    ErrorCode = run.LifecycleFailureCode,
                },
                RedisProjectionTtl,
                CancellationToken.None);
        }
        catch
        {
            // Mongo 已经是权威事实源；兼容投影失败不得回滚或阻断重试。
        }
    }

    private static DesignArtifactWorkspaceRef NormalizeWorkspace(DesignArtifactWorkspaceRef? value)
    {
        if (value == null) throw Invalid("缺少工作区引用");
        var kind = SafeToken(value.Kind, "workspace.kind", 64);
        if (kind is not (DesignArtifactWorkspaceKinds.RemotePackage or DesignArtifactWorkspaceKinds.AdapterOwned))
            throw Invalid("不支持的工作区类型");
        return new DesignArtifactWorkspaceRef
        {
            WorkspaceId = SafeToken(value.WorkspaceId, "workspace.workspaceId", 128),
            Kind = kind,
            BaseRevision = Optional(value.BaseRevision, 200),
            Adapter = SafeToken(value.Adapter, "workspace.adapter", 64),
        };
    }

    private static DesignArtifactCapabilitySnapshot NormalizeCapability(DesignArtifactCapabilitySnapshot? value)
    {
        if (value == null) throw Invalid("缺少执行能力快照");
        return new DesignArtifactCapabilitySnapshot
        {
            CapabilityId = SafeToken(value.CapabilityId, "capability.id", 128),
            ArtifactType = SafeToken(value.ArtifactType, "capability.artifactType", 64),
            Runtime = SafeToken(value.Runtime, "capability.runtime", 64),
            Adapter = SafeToken(value.Adapter, "capability.adapter", 64),
            WorkspaceKind = SafeToken(value.WorkspaceKind, "capability.workspaceKind", 64),
            SecurityProfile = SafeToken(value.SecurityProfile, "capability.securityProfile", 64),
            Operations = NormalizeTokens(value.Operations, "capability.operations"),
            SourceSurfaces = NormalizeTokens(value.SourceSurfaces, "capability.sourceSurfaces"),
        };
    }

    private static List<string> NormalizeTokens(IEnumerable<string>? values, string name)
    {
        if (values == null) throw Invalid($"缺少 {name}");
        var normalized = values.Select(value => SafeToken(value, name, 64))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToList();
        if (normalized.Count == 0 || normalized.Count > 32)
            throw Invalid($"{name} 数量无效");
        return normalized;
    }

    private static void ValidateCapability(
        DesignArtifactCapabilitySnapshot capability,
        string artifactType,
        string operation,
        string sourceSurface,
        string runtime,
        DesignArtifactWorkspaceRef workspace)
    {
        if (capability.ArtifactType != artifactType
            || capability.Runtime != runtime
            || capability.Adapter != workspace.Adapter
            || capability.WorkspaceKind != workspace.Kind
            || !capability.Operations.Contains(operation, StringComparer.Ordinal)
            || !capability.SourceSurfaces.Contains(sourceSurface, StringComparer.Ordinal))
            throw Invalid("执行能力与任务组合不一致");
    }

    private static DesignArtifactVersionBoundary NormalizeBoundary(DesignArtifactVersionBoundary? value)
    {
        if (value == null) throw Invalid("缺少版本边界");
        return new DesignArtifactVersionBoundary
        {
            BaseArtifactId = Optional(value.BaseArtifactId, 128),
            BaseVersion = Optional(value.BaseVersion, 200),
            BaseContentHash = OptionalHash(value.BaseContentHash),
            EntryContentHash = OptionalHash(value.EntryContentHash),
            CanonicalManifestHash = OptionalHash(value.CanonicalManifestHash),
            PackageHash = OptionalHash(value.PackageHash),
            OutputContentHash = OptionalHash(value.OutputContentHash),
        };
    }

    private static DesignArtifactContractManifest NormalizeManifest(
        DesignArtifactContractManifest? value,
        DesignArtifactRun run)
    {
        if (value == null) throw Invalid("缺少产物清单");
        if (value.SchemaVersion != DesignArtifactContractVersions.ManifestV1)
            throw Invalid("不支持的 manifest 版本");
        if (!string.Equals(value.ArtifactType, run.ArtifactType, StringComparison.Ordinal))
            throw Invalid("manifest 产物类型与任务不一致");
        if (value.Files is not { Count: > 0 } || value.Files.Count > MaxManifestFiles)
            throw Invalid($"manifest 文件数必须介于 1 到 {MaxManifestFiles}");
        var securityProfile = SafeToken(value.SecurityProfile, "manifest.securityProfile", 64);
        if (run.Capability == null || securityProfile != run.Capability.SecurityProfile)
            throw Invalid("manifest 安全配置与执行能力不一致");

        var entryFile = StrictRelativePath(value.EntryFile);
        if (run.ArtifactType == DesignArtifactTypes.WebPage
            && run.WorkspaceRef?.Kind == DesignArtifactWorkspaceKinds.RemotePackage
            && !DesignArtifactPublicPath.IsWebPageWorkspaceOutput(entryFile, includeInternalManifest: false))
            throw Invalid("manifest 入口路径不属于远程网页工作区");
        var paths = new HashSet<string>(StringComparer.Ordinal);
        var files = new List<DesignArtifactContractManifestFile>(value.Files.Count);
        long totalBytes = 0;
        foreach (var item in value.Files)
        {
            if (item == null) throw Invalid("manifest 文件不能为空");
            var path = StrictRelativePath(item.Path);
            if (run.ArtifactType == DesignArtifactTypes.WebPage
                && run.WorkspaceRef?.Kind == DesignArtifactWorkspaceKinds.RemotePackage
                && !DesignArtifactPublicPath.IsWebPageWorkspaceOutput(path, includeInternalManifest: false))
                throw Invalid("manifest 文件路径不属于远程网页工作区");
            if (!paths.Add(path)) throw Invalid("manifest 不能包含重复文件路径");
            if (item.ByteLength < 0 || item.ByteLength > MaxManifestFileBytes)
                throw Invalid("manifest 文件大小超出限制");
            if (long.MaxValue - totalBytes < item.ByteLength)
                throw Invalid("manifest 总大小溢出");
            totalBytes += item.ByteLength;
            if (totalBytes > MaxManifestTotalBytes)
                throw Invalid("manifest 总大小超出限制");
            files.Add(new DesignArtifactContractManifestFile
            {
                Path = path,
                ByteLength = item.ByteLength,
                Sha256 = RequiredHash(item.Sha256),
                MediaType = StrictMediaType(item.MediaType),
            });
        }
        var entry = files.SingleOrDefault(file => file.Path == entryFile);
        if (entry == null) throw Invalid("manifest 入口文件不存在");
        if (entry.ByteLength == 0) throw Invalid("manifest 入口文件不能为空");
        return new DesignArtifactContractManifest
        {
            SchemaVersion = value.SchemaVersion,
            ArtifactType = run.ArtifactType,
            EntryFile = entryFile,
            SecurityProfile = securityProfile,
            Files = files,
        };
    }

    private static DesignArtifactManifestValidationReceipt NormalizeValidationReceipt(
        DesignArtifactManifestValidationReceipt? value,
        DesignArtifactRun run,
        DesignArtifactManifestHashes hashes)
    {
        if (value == null) throw Invalid("缺少受信 manifest 校验回执");
        var receipt = new DesignArtifactManifestValidationReceipt
        {
            Validator = SafeToken(value.Validator, "validation.validator", 128),
            WorkspaceId = SafeToken(value.WorkspaceId, "validation.workspaceId", 128),
            SecurityPolicyVersion = SafeToken(value.SecurityPolicyVersion, "validation.securityPolicyVersion", 128),
            EntryContentHash = RequiredHash(value.EntryContentHash),
            CanonicalManifestHash = RequiredHash(value.CanonicalManifestHash),
            PackageHash = RequiredHash(value.PackageHash),
            SourcePackageHash = OptionalHash(value.SourcePackageHash),
            SourceManifestHash = OptionalHash(value.SourceManifestHash),
            TotalBytes = value.TotalBytes,
            ValidatedAt = value.ValidatedAt.ToUniversalTime(),
        };
        if (receipt.WorkspaceId != run.WorkspaceRef?.WorkspaceId
            || receipt.TotalBytes != hashes.TotalBytes
            || receipt.ValidatedAt == default
            || receipt.ValidatedAt > DateTime.UtcNow.AddMinutes(5)
            || !FixedHashEquals(receipt.EntryContentHash, hashes.EntryContentHash)
            || !FixedHashEquals(receipt.CanonicalManifestHash, hashes.CanonicalManifestHash)
            || !FixedHashEquals(receipt.PackageHash, hashes.PackageHash))
            throw Invalid("manifest 校验回执与工作区事实不一致");
        return receipt;
    }

    private static DesignArtifactPlanReceipt NormalizePlanReceipt(DesignArtifactPlanReceipt? value)
    {
        if (value == null) throw Invalid("规划任务缺少持久输出摘要");
        return new DesignArtifactPlanReceipt
        {
            StorageReference = SafeToken(value.StorageReference, "plan.storageReference", 256),
            ContentHash = RequiredHash(value.ContentHash),
            InputHash = RequiredHash(value.InputHash),
        };
    }

    private static string StrictRelativePath(string? value)
    {
        if (!DesignArtifactPublicPath.TryNormalize(value, out var normalized))
            throw Invalid("manifest 路径必须是安全、精确的规范化相对路径");
        return normalized;
    }

    private static string StrictMediaType(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 128 || value != value.Trim()
            || value.Any(char.IsControl) || !value.Contains('/'))
            throw Invalid("manifest mediaType 无效");
        return value.ToLowerInvariant();
    }

    private static void AppendCanonical(StringBuilder builder, params string[] values)
    {
        foreach (var value in values)
            builder.Append(value.Length).Append(':').Append(value).Append(';');
        builder.Append('\n');
    }

    private static string SafeToken(string? value, string name, int maxLength)
    {
        var token = Required(value, name, maxLength);
        if (token.Any(character => !(char.IsAsciiLetterOrDigit(character) || character is '_' or '-' or '.' or ':')))
            throw Invalid($"{name} 格式无效");
        return token;
    }

    private static string RequiredHash(string? value)
        => OptionalHash(value) ?? throw Invalid("缺少 SHA-256");

    private static string? OptionalHash(string? value)
    {
        var normalized = Optional(value, 64);
        if (normalized == null) return null;
        if (normalized.Length != 64 || normalized.Any(character => !Uri.IsHexDigit(character)))
            throw Invalid("SHA-256 格式无效");
        return normalized.ToLowerInvariant();
    }

    private static string Required(string? value, string name, int maxLength)
        => Optional(value, maxLength) ?? throw Invalid($"缺少 {name}");

    private static string? Optional(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var normalized = value.Trim();
        if (normalized.Length > maxLength) throw Invalid("字段长度超出限制");
        return normalized;
    }

    private static bool FixedHashEquals(string? left, string? right)
    {
        var normalizedLeft = OptionalHash(left);
        var normalizedRight = OptionalHash(right);
        if (normalizedLeft == null || normalizedRight == null) return false;
        return CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(normalizedLeft),
            Encoding.ASCII.GetBytes(normalizedRight));
    }

    private static string Sha256Hex(string value) => Sha256Hex(Encoding.UTF8.GetBytes(value));

    private static string Sha256Hex(byte[] value) =>
        Convert.ToHexString(SHA256.HashData(value)).ToLowerInvariant();

    private static DesignArtifactLifecycleException Invalid(string message)
        => new(DesignArtifactLifecycleErrorCodes.InvalidContract, message);

    private static DesignArtifactLifecycleException Conflict()
        => new(DesignArtifactLifecycleErrorCodes.Conflict, "设计任务已变化，请刷新后重试");
}

internal sealed record DesignArtifactManifestHashes(
    string EntryContentHash,
    string CanonicalManifestHash,
    string PackageHash,
    long TotalBytes);
