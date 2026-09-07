using System.Text;
using System.Text.Json;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 跨设计 adapter 的公共生命周期账本。它不解析模型输出，也不接收 LLMGW 地址、模型或凭证。
/// </summary>
public sealed class DesignArtifactLifecycleService : IDesignArtifactLifecycleService
{
    private static readonly TimeSpan EventTtl = TimeSpan.FromHours(24);
    private const int MaxManifestFiles = 256;
    private const long MaxManifestFileBytes = 100 * 1024 * 1024;
    private const int MaxEventPayloadBytes = 64 * 1024;

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
        var artifactType = Required(request.ArtifactType, "artifactType", 64);
        if (artifactType is not (DesignArtifactTypes.WebPage or DesignArtifactTypes.HtmlPpt))
            throw Invalid("不支持的产物类型");
        var operation = Required(request.Operation, "operation", 64);
        if (operation is not (DesignArtifactOperations.Plan
            or DesignArtifactOperations.Generate
            or DesignArtifactOperations.Edit))
            throw Invalid("不支持的设计操作");
        var sourceSurface = Required(request.SourceSurface, "sourceSurface", 64);
        var runtime = Required(request.Runtime, "runtime", 64);
        var workspace = NormalizeWorkspace(request.WorkspaceRef, artifactType);
        var boundary = NormalizeBoundary(request.VersionBoundary);
        var now = DateTime.UtcNow;
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
            WorkspaceRef = workspace,
            VersionBoundary = boundary,
            Progress = 0,
            Phase = "设计任务已开始",
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
            },
            EventTtl,
            CancellationToken.None);
        return run;
    }

    public async Task<DesignArtifactEventEnvelope> AppendEventAsync(
        AppendDesignArtifactEventRequest request,
        CancellationToken ct = default)
    {
        var run = await GetOwnedV2Async(request.RunId, request.UserId);
        var type = SafeToken(request.Type, "type", 64);
        var phase = Optional(request.Phase, 200);
        if (request.Progress is < 0 or > 100)
            throw Invalid("事件进度必须介于 0 到 100");

        Dictionary<string, object?>? payload = null;
        if (request.Payload is { Count: > 0 })
        {
            payload = request.Payload.ToDictionary(item => item.Key, item => item.Value, StringComparer.Ordinal);
            var payloadBytes = Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(payload));
            if (payloadBytes > MaxEventPayloadBytes)
                throw Invalid("事件 payload 超过 64KB 限制");
        }

        var occurredAt = DateTime.UtcNow;
        var storedEnvelope = new DesignArtifactEventEnvelope
        {
            RunId = run.Id,
            ArtifactType = run.ArtifactType,
            Type = type,
            Phase = phase,
            Progress = request.Progress,
            Payload = payload,
            OccurredAt = occurredAt,
        };
        var sequence = await _events.AppendEventAsync(
            RunKinds.DesignArtifact,
            run.Id,
            type,
            storedEnvelope,
            EventTtl,
            CancellationToken.None);
        storedEnvelope.Sequence = sequence;
        return storedEnvelope;
    }

    public async Task<DesignArtifactRun> CommitManifestAsync(
        CommitDesignArtifactManifestRequest request,
        CancellationToken ct = default)
    {
        var current = await GetExpectedAsync(request.RunId, request.UserId, request.Expected);
        if (current.Status != RunStatuses.Running)
            throw Conflict();
        if (current.Operation == DesignArtifactOperations.Plan)
            throw Invalid("规划任务不提交产物 manifest");

        var manifest = NormalizeManifest(request.Manifest, current.ArtifactType);
        var entry = manifest.Files.Single(item => item.Path == manifest.EntryFile);
        var boundary = NormalizeBoundary(current.VersionBoundary
            ?? throw Invalid("设计任务缺少版本边界"));
        if (boundary.OutputContentHash != null
            && !string.Equals(boundary.OutputContentHash, entry.Sha256, StringComparison.Ordinal))
            throw Conflict();
        boundary.OutputContentHash = entry.Sha256;

        var now = DateTime.UtcNow;
        var updated = await _db.DesignArtifactRuns.FindOneAndUpdateAsync(
            CasFilter(current, request.Expected, RunStatuses.Running),
            Builders<DesignArtifactRun>.Update
                .Set(item => item.Manifest, manifest)
                .Set(item => item.VersionBoundary, boundary)
                .Set(item => item.Status, RunStatuses.Committing)
                .Set(item => item.Phase, "产物清单已提交")
                .Set(item => item.UpdatedAt, now)
                .Inc(item => item.LifecycleVersion, 1),
            new FindOneAndUpdateOptions<DesignArtifactRun, DesignArtifactRun>
            {
                ReturnDocument = ReturnDocument.After,
            },
            CancellationToken.None);
        if (updated == null) throw Conflict();
        await UpdateRunMetaAsync(updated);
        return updated;
    }

    public async Task<DesignArtifactRun> CompleteAsync(
        DesignArtifactLifecycleMutationRequest request,
        CancellationToken ct = default)
    {
        var current = await GetExpectedAsync(request.RunId, request.UserId, request.Expected);
        var isPlanning = current.Operation == DesignArtifactOperations.Plan;
        var expectedStatus = isPlanning ? RunStatuses.Running : RunStatuses.Committing;
        if (current.Status != expectedStatus || (!isPlanning && current.Manifest == null))
            throw Conflict();

        var now = DateTime.UtcNow;
        var updated = await _db.DesignArtifactRuns.FindOneAndUpdateAsync(
            CasFilter(current, request.Expected, expectedStatus),
            Builders<DesignArtifactRun>.Update
                .Set(item => item.Status, RunStatuses.Done)
                .Set(item => item.Progress, 100)
                .Set(item => item.Phase, isPlanning ? "设计规划已完成" : "设计产物已完成")
                .Set(item => item.CompletedAt, now)
                .Set(item => item.UpdatedAt, now)
                .Inc(item => item.LifecycleVersion, 1),
            new FindOneAndUpdateOptions<DesignArtifactRun, DesignArtifactRun>
            {
                ReturnDocument = ReturnDocument.After,
            },
            CancellationToken.None);
        if (updated == null) throw Conflict();
        await UpdateRunMetaAsync(updated);
        return updated;
    }

    public async Task<DesignArtifactRun> FailAsync(
        FailDesignArtifactSessionRequest request,
        CancellationToken ct = default)
    {
        var current = await GetExpectedAsync(request.RunId, request.UserId, request.Expected);
        if (current.Status is not (RunStatuses.Running or RunStatuses.Committing))
            throw Conflict();
        var failureCode = SafeFailureCode(request.FailureCode);

        var now = DateTime.UtcNow;
        var updated = await _db.DesignArtifactRuns.FindOneAndUpdateAsync(
            CasFilter(current, request.Expected, current.Status),
            Builders<DesignArtifactRun>.Update
                .Set(item => item.Status, RunStatuses.Error)
                .Set(item => item.LifecycleFailureCode, failureCode)
                .Set(item => item.Phase, "设计任务未完成")
                .Set(item => item.CompletedAt, now)
                .Set(item => item.UpdatedAt, now)
                .Inc(item => item.LifecycleVersion, 1),
            new FindOneAndUpdateOptions<DesignArtifactRun, DesignArtifactRun>
            {
                ReturnDocument = ReturnDocument.After,
            },
            CancellationToken.None);
        if (updated == null) throw Conflict();
        await UpdateRunMetaAsync(updated);
        return updated;
    }

    public async Task<DesignArtifactRun> BindPublishedArtifactAsync(
        BindPublishedDesignArtifactRequest request,
        CancellationToken ct = default)
    {
        var current = await GetExpectedAsync(request.RunId, request.UserId, request.Expected);
        if (current.Status != RunStatuses.Done || current.Operation == DesignArtifactOperations.Plan)
            throw Conflict();
        var artifactId = Required(request.ArtifactId, "artifactId", 128);
        var versionId = Required(request.VersionId, "versionId", 128);
        if (!string.IsNullOrWhiteSpace(current.ArtifactSiteId)
            || !string.IsNullOrWhiteSpace(current.ArtifactRevisionId))
        {
            if (current.ArtifactSiteId == artifactId && current.ArtifactRevisionId == versionId)
                return current;
            throw Conflict();
        }

        var updated = await _db.DesignArtifactRuns.FindOneAndUpdateAsync(
            Builders<DesignArtifactRun>.Filter.And(
                CasFilter(current, request.Expected, RunStatuses.Done),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.ArtifactSiteId, null),
                Builders<DesignArtifactRun>.Filter.Eq(item => item.ArtifactRevisionId, null)),
            Builders<DesignArtifactRun>.Update
                .Set(item => item.ArtifactSiteId, artifactId)
                .Set(item => item.ArtifactRevisionId, versionId)
                .Set(item => item.UpdatedAt, DateTime.UtcNow)
                .Inc(item => item.LifecycleVersion, 1),
            new FindOneAndUpdateOptions<DesignArtifactRun, DesignArtifactRun>
            {
                ReturnDocument = ReturnDocument.After,
            },
            CancellationToken.None);
        if (updated == null) throw Conflict();
        return updated;
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
            throw Conflict();
        return run;
    }

    private async Task<DesignArtifactRun> GetExpectedAsync(
        string runId,
        string userId,
        DesignArtifactLifecycleExpectation expected)
    {
        if (expected == null || expected.LifecycleVersion < 1)
            throw Invalid("缺少有效的生命周期版本");
        var current = await GetOwnedV2Async(runId, userId);
        if (current.LifecycleVersion != expected.LifecycleVersion
            || !string.Equals(current.WorkspaceRef?.BaseRevision, Optional(expected.BaseRevision, 200), StringComparison.Ordinal)
            || !string.Equals(current.VersionBoundary?.BaseContentHash, OptionalHash(expected.BaseContentHash), StringComparison.Ordinal))
            throw Conflict();
        return current;
    }

    private static FilterDefinition<DesignArtifactRun> CasFilter(
        DesignArtifactRun current,
        DesignArtifactLifecycleExpectation expected,
        string status)
    {
        var filter = Builders<DesignArtifactRun>.Filter;
        return filter.And(
            filter.Eq(item => item.Id, current.Id),
            filter.Eq(item => item.UserId, current.UserId),
            filter.Eq(item => item.ContractVersion, DesignArtifactContractVersions.Current),
            filter.Eq(item => item.LifecycleVersion, expected.LifecycleVersion),
            filter.Eq(item => item.Status, status),
            filter.Eq(item => item.WorkspaceRef!.BaseRevision, Optional(expected.BaseRevision, 200)),
            filter.Eq(item => item.VersionBoundary!.BaseContentHash, OptionalHash(expected.BaseContentHash)));
    }

    private async Task UpdateRunMetaAsync(DesignArtifactRun run)
    {
        var meta = await _events.GetRunAsync(RunKinds.DesignArtifact, run.Id, CancellationToken.None)
                   ?? new RunMeta
                   {
                       RunId = run.Id,
                       Kind = RunKinds.DesignArtifact,
                       CreatedByUserId = run.UserId,
                       CreatedAt = run.CreatedAt,
                   };
        meta.Status = run.Status;
        meta.StartedAt ??= run.CreatedAt;
        meta.EndedAt = run.CompletedAt;
        meta.ErrorCode = run.LifecycleFailureCode;
        await _events.SetRunAsync(RunKinds.DesignArtifact, meta, EventTtl, CancellationToken.None);
    }

    private static DesignArtifactWorkspaceRef NormalizeWorkspace(
        DesignArtifactWorkspaceRef? value,
        string artifactType)
    {
        if (value == null) throw Invalid("缺少工作区引用");
        var kind = Required(value.Kind, "workspace.kind", 64);
        if (kind is not (DesignArtifactWorkspaceKinds.RemotePackage or DesignArtifactWorkspaceKinds.AdapterOwned))
            throw Invalid("不支持的工作区类型");
        if (artifactType == DesignArtifactTypes.HtmlPpt && kind != DesignArtifactWorkspaceKinds.AdapterOwned)
            throw Invalid("HTML PPT 必须使用 adapter-owned 工作区");
        return new DesignArtifactWorkspaceRef
        {
            WorkspaceId = SafeToken(value.WorkspaceId, "workspace.workspaceId", 128),
            Kind = kind,
            BaseRevision = Optional(value.BaseRevision, 200),
            Adapter = SafeToken(value.Adapter, "workspace.adapter", 64),
        };
    }

    private static DesignArtifactVersionBoundary NormalizeBoundary(DesignArtifactVersionBoundary? value)
    {
        if (value == null) throw Invalid("缺少版本边界");
        return new DesignArtifactVersionBoundary
        {
            BaseArtifactId = Optional(value.BaseArtifactId, 128),
            BaseVersion = Optional(value.BaseVersion, 200),
            BaseContentHash = OptionalHash(value.BaseContentHash),
            OutputContentHash = OptionalHash(value.OutputContentHash),
        };
    }

    private static DesignArtifactContractManifest NormalizeManifest(DesignArtifactContractManifest? value, string artifactType)
    {
        if (value == null) throw Invalid("缺少产物清单");
        if (value.SchemaVersion != DesignArtifactContractVersions.ManifestV1)
            throw Invalid("不支持的 manifest 版本");
        if (!string.Equals(value.ArtifactType, artifactType, StringComparison.Ordinal))
            throw Invalid("manifest 产物类型与任务不一致");
        if (value.Files is not { Count: > 0 } || value.Files.Count > MaxManifestFiles)
            throw Invalid($"manifest 文件数必须介于 1 到 {MaxManifestFiles}");

        var securityProfile = Required(value.SecurityProfile, "manifest.securityProfile", 64);
        var expectedProfile = artifactType switch
        {
            DesignArtifactTypes.WebPage => DesignArtifactSecurityProfiles.WebPageRestricted,
            DesignArtifactTypes.HtmlPpt => DesignArtifactSecurityProfiles.HtmlPptInteractive,
            _ => throw Invalid("不支持的产物类型"),
        };
        if (securityProfile != expectedProfile)
            throw Invalid("manifest 安全配置与产物类型不一致");

        var entryFile = NormalizeRelativePath(value.EntryFile);
        var paths = new HashSet<string>(StringComparer.Ordinal);
        var files = new List<DesignArtifactContractManifestFile>(value.Files.Count);
        foreach (var item in value.Files)
        {
            if (item == null) throw Invalid("manifest 文件不能为空");
            var path = NormalizeRelativePath(item.Path);
            if (!paths.Add(path)) throw Invalid("manifest 不能包含重复文件路径");
            if (item.ByteLength < 0 || item.ByteLength > MaxManifestFileBytes)
                throw Invalid("manifest 文件大小超出限制");
            files.Add(new DesignArtifactContractManifestFile
            {
                Path = path,
                ByteLength = item.ByteLength,
                Sha256 = RequiredHash(item.Sha256),
            });
        }
        if (!paths.Contains(entryFile))
            throw Invalid("manifest 入口文件不存在");

        return new DesignArtifactContractManifest
        {
            SchemaVersion = value.SchemaVersion,
            ArtifactType = artifactType,
            EntryFile = entryFile,
            SecurityProfile = securityProfile,
            Files = files,
        };
    }

    private static string NormalizeRelativePath(string? value)
    {
        var path = Required(value, "manifest.path", 240);
        if (path.StartsWith("/", StringComparison.Ordinal)
            || path.Contains('\\')
            || path.Split('/').Any(segment => segment is "" or "." or ".."))
            throw Invalid("manifest 只允许规范化相对路径");
        return path;
    }

    private static string SafeFailureCode(string? value)
    {
        return SafeToken(value, "failureCode", 64);
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

    private static DesignArtifactLifecycleException Invalid(string message)
        => new(DesignArtifactLifecycleErrorCodes.InvalidContract, message);

    private static DesignArtifactLifecycleException Conflict()
        => new(DesignArtifactLifecycleErrorCodes.Conflict, "设计任务已变化，请刷新后重试");
}
