using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>知识驱动设计任务的统一入口。首版开放网页生成，HTML PPT 通过既有专用链路关联。</summary>
[ApiController]
[Route("api/design-artifacts")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public sealed class DesignArtifactsController : ControllerBase
{
    private static readonly TimeSpan RunTtl = TimeSpan.FromHours(24);
    private static readonly HashSet<string> ExportableRuntimeFailureCodes = new(StringComparer.Ordinal)
    {
        "design_output_invalid",
        "design_output_missing",
        "design_output_quality_rejected",
        "design_output_too_large",
        "open_design_contract_mismatch",
        "open_design_execution_failed",
        "open_design_not_ready",
        "open_design_run_failed",
        "open_design_run_cancelled",
        "open_design_run_timeout",
        "workspace_commit_invalid_response",
        "workspace_container_start_failed",
        "workspace_egress_unavailable",
        "workspace_output_validation_failed",
        "workspace_package_hash_mismatch",
        "workspace_package_invalid",
        "workspace_runtime_unavailable",
        "workspace_session_not_found",
        "workspace_transfer_invalid",
    };
    private static readonly HashSet<string> PublicGenerationStreamEvents = new(StringComparer.Ordinal)
    {
        "phase",
        "thinking",
        "delta",
        "done",
        "error",
        "cancelled",
    };
    private readonly MongoDbContext _db;
    private readonly IRunEventStore _events;
    private readonly IRunQueue _queue;
    private readonly IDesignArtifactProviderCatalog _providers;
    private readonly IDesignKnowledgeSnapshotResolver _knowledgeSnapshots;
    private readonly IDesignArtifactCancellationCoordinator _cancellation;
    private readonly LlmGatewayDataContext _gatewayDb;
    private readonly IConfiguration _configuration;
    private readonly ILogger<DesignArtifactsController>? _logger;

    public DesignArtifactsController(
        MongoDbContext db,
        IRunEventStore events,
        IRunQueue queue,
        IDesignArtifactProviderCatalog providers,
        IDesignKnowledgeSnapshotResolver knowledgeSnapshots,
        LlmGatewayDataContext gatewayDb,
        IDesignArtifactCancellationCoordinator cancellation,
        IConfiguration configuration,
        ILogger<DesignArtifactsController>? logger = null)
    {
        _db = db;
        _events = events;
        _queue = queue;
        _providers = providers;
        _knowledgeSnapshots = knowledgeSnapshots;
        _gatewayDb = gatewayDb;
        _cancellation = cancellation;
        _configuration = configuration;
        _logger = logger;
    }

    [HttpGet("runtime-capabilities")]
    public async Task<IActionResult> RuntimeCapabilities()
    {
        var runtimes = (await _providers.ListAsync(this.GetRequiredUserId(), CancellationToken.None))
            .Where(item => item.ArtifactTypes.Contains(DesignArtifactTypes.WebPage, StringComparer.Ordinal))
            .ToList();
        return Ok(ApiResponse<object>.Ok(new
        {
            defaultRuntime = DesignArtifactRuntimes.MapGateway,
            runtimes = runtimes.Select(ToPublicCapability).ToList(),
        }));
    }

    /// <summary>
    /// 在创建设计任务前读取知识来源的当前权威哈希。响应不返回正文；创建 Run 时仍会二次读取并校验。
    /// </summary>
    [HttpPost("knowledge-references/resolve")]
    public async Task<IActionResult> ResolveKnowledgeReferences(
        [FromBody] ResolveDesignKnowledgeReferencesRequest request)
    {
        IReadOnlyList<DesignKnowledgeSnapshot> snapshots;
        try
        {
            snapshots = await _knowledgeSnapshots.ResolveAsync(
                this.GetRequiredUserId(),
                (request.KnowledgeReferences ?? new List<DesignKnowledgeReferenceRequest>())
                    .Select(reference => new DesignKnowledgeReferenceIdentity(
                        reference.EntryId ?? string.Empty,
                        reference.StoreId ?? string.Empty))
                    .ToList(),
                CancellationToken.None);
        }
        catch (DesignKnowledgeSnapshotException ex)
        {
            return ex.Code == ErrorCodes.NOT_FOUND
                ? NotFound(ApiResponse<object>.Fail(ex.Code, ex.Message))
                : BadRequest(ApiResponse<object>.Fail(ex.Code, ex.Message));
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            items = snapshots.Select(snapshot => new
            {
                snapshot.EntryId,
                snapshot.StoreId,
                snapshot.StoreName,
                snapshot.Title,
                snapshot.ContentHash,
            }),
        }));
    }

    [HttpPost("runs")]
    public async Task<IActionResult> CreateRun([FromBody] CreateDesignArtifactRunRequest request)
    {
        var userId = this.GetRequiredUserId();
        var protectedOverrides = DesignArtifactRequestAuthorityGuard.FindProtectedOverrides(
            request.AdditionalProperties?.Keys);
        if (protectedOverrides.Count > 0)
        {
            _logger?.LogWarning(
                "Rejected design-artifact runtime authority override. userId={UserId} fields={Fields}",
                userId,
                string.Join(',', protectedOverrides));
            return BadRequest(ApiResponse<object>.Fail(
                DesignArtifactRequestAuthorityGuard.ErrorCode,
                "运行时模型、网关地址和审计归属由 MAP 统一配置，请移除覆盖字段后重试"));
        }
        var instruction = (request.Instruction ?? string.Empty).Trim();
        if (instruction.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请用两句话说明网页用途和期望效果"));
        if (instruction.Length > 4000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "设计要求不能超过 4000 个字符"));
        if (!string.Equals(request.ArtifactType, DesignArtifactTypes.WebPage, StringComparison.OrdinalIgnoreCase))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "当前统一入口只支持生成网页，HTML PPT 请从对应工作台生成"));

        var runtime = string.IsNullOrWhiteSpace(request.Runtime)
            ? DesignArtifactRuntimes.MapGateway
            : request.Runtime.Trim().ToLowerInvariant();
        var capability = await _providers.FindAsync(userId, runtime, CancellationToken.None);
        if (capability == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的设计执行器"));
        if (!capability.ArtifactTypes.Contains(DesignArtifactTypes.WebPage, StringComparer.Ordinal)
            || !capability.Operations.Contains(DesignArtifactOperations.Generate, StringComparer.Ordinal))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "所选执行器不支持生成网页"));
        if (!capability.Enabled)
            return Conflict(ApiResponse<object>.Fail(
                "RUNTIME_NOT_READY",
                capability.Reason ?? "所选执行器尚未部署并通过健康检查，请先使用可用执行器"));

        var references = request.KnowledgeReferences ?? new List<DesignKnowledgeReferenceRequest>();
        if (references.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请至少选择一篇知识作为网页内容来源"));
        if (references.Count > 3)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "首版一次最多引用 3 篇知识"));
        IReadOnlyList<DesignKnowledgeSnapshot> snapshots;
        DesignKnowledgeOriginalSnapshot? originals = null;
        try
        {
            var identities = references.Select(reference => new DesignKnowledgeReferenceIdentity(
                    reference.EntryId ?? string.Empty,
                    reference.StoreId ?? string.Empty,
                    reference.ContentHash)).ToList();
            if (runtime == DesignArtifactRuntimes.OpenDesign)
            {
                var workspace = await _knowledgeSnapshots.ResolveWorkspaceForRunAsync(userId, identities, CancellationToken.None);
                snapshots = workspace.KnowledgeReferences;
                originals = workspace.Originals;
            }
            else snapshots = await _knowledgeSnapshots.ResolveForRunAsync(userId, identities, CancellationToken.None);
        }
        catch (DesignKnowledgeSnapshotException ex)
        {
            return KnowledgeReferenceFailure(ex);
        }

        var sourceSurface = string.Equals(request.SourceSurface, DesignArtifactSourceSurfaces.KnowledgeBase, StringComparison.OrdinalIgnoreCase)
            ? DesignArtifactSourceSurfaces.KnowledgeBase
            : DesignArtifactSourceSurfaces.WebHosting;
        var runId = Guid.NewGuid().ToString("N");
        DesignArtifactLlmRequestPolicy requestPolicy;
        try { requestPolicy = DesignArtifactModelSelection.CaptureForNewRun(_configuration); }
        catch (InvalidOperationException ex)
        {
            return Conflict(ApiResponse<object>.Fail("DESIGN_MODEL_POLICY_INVALID", ex.Message));
        }
        var run = new DesignArtifactRun
        {
            Id = runId,
            DeploymentSlug = DeploymentScope.Current,
            UserId = userId,
            Status = RunStatuses.Queued,
            ArtifactType = DesignArtifactTypes.WebPage,
            Operation = DesignArtifactOperations.Generate,
            SourceSurface = sourceSurface,
            Runtime = runtime,
            LlmRequestPolicy = requestPolicy,
            RuntimeConnectionId = capability.ConnectionId,
            Instruction = instruction,
            Title = TrimOptional(request.Title, 200) ?? snapshots[0].Title,
            KnowledgeReferences = snapshots.ToList(),
            KnowledgeOriginals = originals,
            InputAuthority = snapshots.Count > 0
                ? DesignArtifactInputAuthorities.MixedUserAndServerKnowledge
                : DesignArtifactInputAuthorities.UserSupplied,
            UserSuppliedContentHash = System.Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(instruction))).ToLowerInvariant(),
            Progress = 2,
            Phase = "网页生成任务已进入队列",
        };
        WebPageDesignArtifactLifecycleAdapter.InitializeNewRun(run, capability, currentHtml: null);
        await _db.DesignArtifactRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);

        var meta = new RunMeta
        {
            RunId = runId,
            Kind = RunKinds.DesignArtifact,
            Status = RunStatuses.Queued,
            CreatedByUserId = userId,
            CreatedAt = DateTime.UtcNow,
            InputJson = JsonSerializer.Serialize(new { sourceSurface }),
        };
        try
        {
            await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
            await _events.AppendEventAsync(
                RunKinds.DesignArtifact,
                runId,
                "phase",
                new { progress = 2, message = run.Phase },
                RunTtl,
                CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "设计任务 Redis 兼容投影暂不可用 runId={RunId}", runId);
        }
        try
        {
            await _queue.EnqueueAsync(RunKinds.DesignArtifact, runId, CancellationToken.None);
        }
        catch (Exception ex)
        {
            // Mongo queued 记录是权威入队意图，恢复器会重试；客户端仍拿到唯一 runId，避免未知副作用后重建任务。
            _logger?.LogWarning(ex, "设计任务即时入队失败，等待 Mongo 恢复器重试 runId={RunId}", runId);
        }
        return Accepted(ApiResponse<object>.Ok(ToDto(run)));
    }

    [HttpGet("runs/{runId}")]
    public async Task<IActionResult> GetRun(string runId)
    {
        var run = await _db.FindDesignArtifactRunHistoryAsync(
            x => x.Id == runId && x.UserId == this.GetRequiredUserId(), CancellationToken.None);
        return run == null
            ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "设计任务不存在"))
            : Ok(ApiResponse<object>.Ok(ToDto(run)));
    }

    [HttpPost("runs/{runId}/cancel")]
    public async Task<IActionResult> CancelRun(string runId)
    {
        var userId = this.GetRequiredUserId();
        var generationRun = await _db.DesignArtifactRuns
            .Find(run => run.DeploymentSlug == DeploymentScope.Current && (run.Id == runId
                         && run.UserId == userId
                         && run.ArtifactType == DesignArtifactTypes.WebPage
                         && run.Operation == DesignArtifactOperations.Generate))
            .FirstOrDefaultAsync(CancellationToken.None);
        if (generationRun == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "设计任务不存在"));

        DesignArtifactCancellationResult? cancellation;
        try
        {
            cancellation = await _cancellation.RequestAsync(runId, userId, CancellationToken.None);
        }
        catch (DesignArtifactLifecycleException ex)
            when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict)
        {
            return Conflict(ApiResponse<object>.Fail(
                "DESIGN_ARTIFACT_CANCEL_CONFLICT",
                "任务已经进入保存或终态，不能再取消；请刷新任务状态确认结果"));
        }
        catch (DesignArtifactCancellationConflictException)
        {
            return Conflict(ApiResponse<object>.Fail(
                "DESIGN_ARTIFACT_CANCEL_CONFLICT",
                "任务已经进入保存或终态，不能再取消；请刷新任务状态确认结果"));
        }

        if (cancellation == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "设计任务不存在"));
        await ProjectCancellationBestEffortAsync(cancellation.Run);
        return Ok(ApiResponse<object>.Ok(new
        {
            runId = cancellation.Run.Id,
            cancellation.Run.Status,
            cancelRequested = cancellation.Run.CancelRequestedAt.HasValue,
            cancellation.Changed,
        }));
    }

    /// <summary>
    /// 读取跨 adapter 的公共生命周期合同。响应只含逻辑引用、版本边界和文件元数据，
    /// 不返回指令、知识正文、事件 payload、对象存储 key 或模型配置。
    /// </summary>
    [HttpGet("runs/{runId}/contract")]
    public async Task<IActionResult> GetContract(string runId)
    {
        var run = await _db.FindDesignArtifactRunHistoryAsync(
            item => item.Id == runId && item.UserId == this.GetRequiredUserId(), CancellationToken.None);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "设计任务不存在"));

        var contractVersion = run.ContractVersion ?? DesignArtifactContractVersions.Legacy;
        if (contractVersion is not (DesignArtifactContractVersions.Legacy or DesignArtifactContractVersions.Current))
            return Conflict(ApiResponse<object>.Fail(
                DesignArtifactLifecycleErrorCodes.UnsupportedVersion,
                "不支持该设计任务合同版本"));
        var isCurrentContract = contractVersion == DesignArtifactContractVersions.Current;
        object? manifest = isCurrentContract && run.Manifest != null
            ? new
            {
                run.Manifest.SchemaVersion,
                run.Manifest.ArtifactType,
                run.Manifest.EntryFile,
                run.Manifest.SecurityProfile,
                files = run.Manifest.Files.Select(file => new
                {
                    file.Path,
                    file.ByteLength,
                    file.Sha256,
                    file.MediaType,
                }),
            }
            : null;

        return Ok(ApiResponse<object>.Ok(new
        {
            runId = run.Id,
            contractVersion,
            lifecycleVersion = isCurrentContract ? run.LifecycleVersion : 0,
            run.Status,
            run.ArtifactType,
            run.Operation,
            workspace = isCurrentContract && run.WorkspaceRef != null
                ? new
                {
                    run.WorkspaceRef.WorkspaceId,
                    run.WorkspaceRef.Kind,
                    run.WorkspaceRef.BaseRevision,
                    run.WorkspaceRef.Adapter,
                }
                : null,
            versionBoundary = isCurrentContract && run.VersionBoundary != null
                ? new
                {
                    run.VersionBoundary.BaseArtifactId,
                    run.VersionBoundary.BaseVersion,
                    run.VersionBoundary.BaseContentHash,
                    run.VersionBoundary.EntryContentHash,
                    run.VersionBoundary.CanonicalManifestHash,
                    run.VersionBoundary.PackageHash,
                    run.VersionBoundary.OutputContentHash,
                }
                : null,
            capability = isCurrentContract ? run.Capability : null,
            manifest,
            manifestPresent = isCurrentContract && manifest != null,
            manifestValidated = isCurrentContract && run.ManifestValidation != null,
            artifactReady = isCurrentContract
                            && run.Status == RunStatuses.Done
                            && run.Operation != DesignArtifactOperations.Plan
                            && manifest != null
                            && run.ManifestValidation != null,
            planReceipt = isCurrentContract && run.Operation == DesignArtifactOperations.Plan
                ? run.PlanReceipt
                : null,
            run.ParentPlanRunId,
            run.ParentPlanContentHash,
            run.ArtifactSiteId,
            run.ArtifactRevisionId,
            producedArtifactSiteId = isCurrentContract ? run.ProducedArtifactSiteId : null,
            producedArtifactRevisionId = isCurrentContract ? run.ProducedArtifactRevisionId : null,
            failureCode = isCurrentContract ? run.LifecycleFailureCode : null,
            run.CreatedAt,
            run.UpdatedAt,
            run.CompletedAt,
        }));
    }

    /// <summary>读取公共事件信封元数据；内部 payload 不通过该 API 导出。</summary>
    [HttpGet("runs/{runId}/contract/events")]
    public async Task<IActionResult> GetContractEvents(
        string runId,
        [FromQuery] long afterSeq = 0,
        [FromQuery] int limit = 100)
    {
        var run = await _db.FindDesignArtifactRunHistoryAsync(
            item => item.Id == runId && item.UserId == this.GetRequiredUserId(), CancellationToken.None);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "设计任务不存在"));
        if (run.ContractVersion != DesignArtifactContractVersions.Current)
            return Conflict(ApiResponse<object>.Fail(
                DesignArtifactLifecycleErrorCodes.UnsupportedVersion,
                "公共事件接口只支持 v2 合同"));

        var safeAfter = Math.Max(0, afterSeq);
        var records = run.LifecycleEvents
            .Where(item => item.Sequence > safeAfter)
            .OrderBy(item => item.Sequence)
            .Take(Math.Clamp(limit, 1, 100))
            .ToList();
        return Ok(ApiResponse<object>.Ok(new
        {
            items = records.Select(ToPublicContractEvent),
            nextSeq = records.LastOrDefault()?.Sequence ?? safeAfter,
            retentionPolicy = "lifecycle",
            truncated = false,
            firstAvailableSeq = run.LifecycleEvents.OrderBy(item => item.Sequence).FirstOrDefault()?.Sequence,
            lastAvailableSeq = run.LifecycleEventSequence,
        }));
    }

    /// <summary>
    /// 导出一条只含稳定关联标识与脱敏状态的 E4 审计证据。
    /// 任何原始错误、Provider 地址、请求正文和凭证均不得进入此响应。
    /// </summary>
    [HttpGet("runs/{runId}/evidence")]
    public async Task<IActionResult> GetEvidence(string runId)
    {
        var userId = this.GetRequiredUserId();
        var run = await _db.FindDesignArtifactRunHistoryAsync(
            item => item.Id == runId && item.UserId == userId, CancellationToken.None);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "设计任务不存在"));

        var session = await _db.InfraAgentSessions
            .Find(item => item.TraceId == run.Id && item.UserId == userId)
            .SortByDescending(item => item.CreatedAt)
            .FirstOrDefaultAsync(CancellationToken.None);
        var revision = string.IsNullOrWhiteSpace(run.ArtifactRevisionId)
            ? null
            : await _db.HostedSiteRevisions
                .Find(item => item.Id == run.ArtifactRevisionId
                              && item.CreatedByUserId == userId
                              && (run.ArtifactSiteId == null || item.SiteId == run.ArtifactSiteId))
                .FirstOrDefaultAsync(CancellationToken.None);
        var relatedRollback = revision == null
            ? null
            : await _db.HostedSiteRevisions
                .Find(item => item.CreatedByUserId == userId
                              && item.SiteId == revision.SiteId
                              && item.Source == HostedSiteRevisionSources.Rollback
                              && item.RollbackTargetRevisionId == revision.Id)
                .SortByDescending(item => item.CreatedAt)
                .FirstOrDefaultAsync(CancellationToken.None);

        var llmgwAudits = await _gatewayDb.LlmRequestLogs
            .Find(item => item.RunId == run.Id
                          && item.UserId == userId
                          && item.SourceSystem == "map")
            .SortBy(item => item.StartedAt)
            .Project(item => new DesignArtifactLlmAuditEvidence(
                item.Id,
                item.RequestId,
                item.Status,
                item.StatusCode,
                item.AppCallerCode,
                item.SourceSystem,
                item.LogicalModelPublicId,
                item.StartedAt,
                item.EndedAt))
            .ToListAsync(CancellationToken.None);

        var runtimeFailure = session == null
            ? null
            : await FindSafeRuntimeFailureAsync(session.Id);
        var commitState = !string.IsNullOrWhiteSpace(run.WorkspaceResultAssetKey)
            ? "committed"
            : !string.IsNullOrWhiteSpace(run.WorkspacePendingResultAssetKey)
                ? run.WorkspacePendingResultWriteState ?? "pending"
                : "none";

        var evidence = new DesignArtifactE4Evidence(
            "map-design-artifact-evidence-v1",
            run.Id,
            session?.Id,
            session?.CdsSessionId,
            run.WorkspaceManifestSha256,
            run.ArtifactRevisionId,
            llmgwAudits.LastOrDefault()?.AuditId,
            new DesignArtifactAuthorityEvidence(
                "map",
                NormalizePublicBaseUrl(session?.ModelBaseUrl),
                session?.Model,
                llmgwAudits.Select(item => item.AppCallerCode)
                    .Where(item => !string.IsNullOrWhiteSpace(item))
                    .Distinct(StringComparer.Ordinal)
                    .ToArray()!),
            new DesignArtifactCommitEvidence(
                commitState,
                run.WorkspaceResultSha256,
                run.WorkspacePendingResultAttemptId,
                run.WorkspaceRejectedResultCleanupError != null),
            new DesignArtifactVersionEvidence(
                revision?.Id,
                revision?.Status,
                revision?.Source,
                revision?.ParentRevisionId,
                revision?.LastPublishFailureCode,
                revision?.LastPublishFailedAt,
                revision?.PublishedAt,
                relatedRollback == null
                    ? null
                    : new DesignArtifactRollbackEvidence(
                        relatedRollback.Id,
                        relatedRollback.Status,
                        relatedRollback.ParentRevisionId,
                        relatedRollback.RollbackTargetRevisionId,
                        relatedRollback.LastPublishFailureCode,
                        relatedRollback.LastPublishFailedAt,
                        relatedRollback.PublishedAt)),
            new DesignArtifactRuntimeFailureEvidence(runtimeFailure, run.Status == RunStatuses.Error),
            llmgwAudits,
            run.CreatedAt,
            DateTime.UtcNow);
        return Ok(ApiResponse<DesignArtifactE4Evidence>.Ok(evidence));
    }

    private async Task<string?> FindSafeRuntimeFailureAsync(string sessionId)
    {
        var events = await _db.InfraAgentEvents
            .Find(item => item.SessionId == sessionId && item.Type == InfraAgentEventTypes.Error)
            .SortByDescending(item => item.Seq)
            .Limit(20)
            .ToListAsync(CancellationToken.None);
        foreach (var item in events)
        {
            try
            {
                using var payload = JsonDocument.Parse(item.PayloadJson);
                if (!payload.RootElement.TryGetProperty("code", out var codeElement)
                    || codeElement.ValueKind != JsonValueKind.String)
                    continue;
                var code = codeElement.GetString()?.Trim().ToLowerInvariant();
                if (IsSafeFailureCode(code)) return code;
            }
            catch (JsonException)
            {
                // 历史坏事件只忽略，不把原文或解析错误带入审计响应。
            }
        }
        return null;
    }

    private static bool IsSafeFailureCode(string? value)
        => value != null && ExportableRuntimeFailureCodes.Contains(value);

    private static string? NormalizePublicBaseUrl(string? value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)
            || uri == null
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
            || !string.IsNullOrEmpty(uri.UserInfo))
            return null;
        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
    }

    [HttpGet("runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamRun(string runId, [FromQuery] long afterSeq = 0, CancellationToken ct = default)
    {
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers["X-Accel-Buffering"] = "no";

        var userId = this.GetRequiredUserId();
        var initial = await _db.FindDesignArtifactRunHistoryAsync(
            item => item.Id == runId && item.UserId == userId, CancellationToken.None);
        if (initial == null)
        {
            await WriteEventAsync(null, "error", JsonSerializer.Serialize(new
            {
                code = ErrorCodes.NOT_FOUND,
                message = "设计任务不存在",
            }), ct);
            return;
        }
        var cursor = Math.Max(0, afterSeq);
        var idleRounds = 0;
        var redisProjectionAvailable = true;
        var lastMongoProgress = -1;
        string? lastMongoPhase = null;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                IReadOnlyList<RunEventRecord> batch = Array.Empty<RunEventRecord>();
                if (redisProjectionAvailable)
                {
                    try
                    {
                        batch = await _events.GetEventsAsync(
                            RunKinds.DesignArtifact,
                            runId,
                            cursor,
                            100,
                            ct);
                    }
                    catch (Exception ex)
                    {
                        redisProjectionAvailable = false;
                        _logger?.LogWarning(
                            ex,
                            "网页生成任务 Redis 事件流不可用，切换 Mongo 权威状态 runId={RunId}",
                            runId);
                    }
                }
                var terminalEventEmitted = false;
                foreach (var item in batch)
                {
                    cursor = item.Seq;
                    if (!PublicGenerationStreamEvents.Contains(item.EventName)) continue;
                    await WriteEventAsync(item.Seq, item.EventName, item.PayloadJson, ct);
                    terminalEventEmitted |= item.EventName is "done" or "error" or "cancelled";
                }
                if (terminalEventEmitted) return;
                if (batch.Count > 0)
                {
                    idleRounds = 0;
                    continue;
                }

                var snapshot = await _db.FindDesignArtifactRunHistoryAsync(
                    item => item.Id == runId && item.UserId == userId, CancellationToken.None);
                if (snapshot == null) return;
                if (snapshot.Progress != lastMongoProgress
                    || !string.Equals(snapshot.Phase, lastMongoPhase, StringComparison.Ordinal))
                {
                    await WriteEventAsync(null, "phase", JsonSerializer.Serialize(new
                    {
                        progress = snapshot.Progress,
                        message = snapshot.Phase,
                    }), ct);
                    lastMongoProgress = snapshot.Progress;
                    lastMongoPhase = snapshot.Phase;
                }
                if (snapshot.Status == RunStatuses.Done)
                {
                    var siteId = snapshot.ArtifactSiteId ?? snapshot.ProducedArtifactSiteId;
                    var revisionId = snapshot.ArtifactRevisionId ?? snapshot.ProducedArtifactRevisionId;
                    if (!string.IsNullOrWhiteSpace(siteId))
                    {
                        await WriteEventAsync(null, "done", JsonSerializer.Serialize(new
                        {
                            siteId,
                            revisionId,
                            status = HostedSiteRevisionStatuses.Draft,
                        }), ct);
                    }
                    else
                    {
                        await WriteEventAsync(null, "error", JsonSerializer.Serialize(new
                        {
                            code = "DESIGN_ARTIFACT_RESULT_MISSING",
                            message = "网页任务已结束，但未找到可打开的产物，请重新生成",
                        }), ct);
                    }
                    return;
                }
                if (snapshot.Status is RunStatuses.Error or RunStatuses.Cancelled)
                {
                    await WriteEventAsync(null, snapshot.Status == RunStatuses.Cancelled ? "cancelled" : "error", JsonSerializer.Serialize(new
                    {
                        code = snapshot.Status == RunStatuses.Cancelled
                            ? "DESIGN_ARTIFACT_CANCELLED"
                            : "DESIGN_ARTIFACT_FAILED",
                        message = snapshot.Status == RunStatuses.Cancelled
                            ? "网页生成已取消，未保存或发布新页面"
                            : string.IsNullOrWhiteSpace(snapshot.Error)
                                ? "网页生成未完成，请重新发起"
                                : snapshot.Error,
                    }), ct);
                    return;
                }

                idleRounds++;
                if (idleRounds % 20 == 0)
                {
                    await Response.WriteAsync(": keepalive\n\n", ct);
                    await Response.Body.FlushAsync(ct);
                }
                await Task.Delay(500, ct);
            }
        }
        catch (OperationCanceledException)
        {
            // 浏览器断开只结束观察，不取消后台任务。
        }
        catch (ObjectDisposedException)
        {
            // 响应已关闭，后台任务仍继续。
        }
    }

    private static object ToDto(DesignArtifactRun run) => new
    {
        runId = run.Id,
        run.Status,
        run.ArtifactType,
        run.Operation,
        run.SourceSurface,
        run.Runtime,
        run.LlmRequestPolicy,
        llmRequestPolicyState = run.LlmRequestPolicy == null ? "legacy-unfrozen" : "frozen",
        run.Title,
        run.Progress,
        run.Phase,
        run.ArtifactSiteId,
        run.ArtifactRevisionId,
        run.ProducedArtifactSiteId,
        run.ProducedArtifactRevisionId,
        run.LinkedRunId,
        run.Error,
        cancelRequested = run.CancelRequestedAt.HasValue,
        run.CancelRequestedAt,
        run.CancelledAt,
        run.RuntimeModelCallCount,
        run.WorkspaceInputSha256,
        run.WorkspaceBaseRevision,
        run.WorkspaceResultSha256,
        knowledgeReferences = run.KnowledgeReferences.Select(x => new
        {
            x.EntryId,
            x.StoreId,
            x.StoreName,
            x.Title,
            x.ContentHash,
        }),
        run.CreatedAt,
        run.UpdatedAt,
        run.CompletedAt,
    };

    private async Task ProjectCancellationBestEffortAsync(DesignArtifactRun run)
    {
        try
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
            if (run.Status == RunStatuses.Cancelled)
                meta.EndedAt = run.CancelledAt ?? run.CompletedAt ?? DateTime.UtcNow;
            await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
            await _events.AppendEventAsync(
                RunKinds.DesignArtifact,
                run.Id,
                run.Status == RunStatuses.Cancelled ? "cancelled" : "phase",
                run.Status == RunStatuses.Cancelled
                    ? new { code = "DESIGN_ARTIFACT_CANCELLED", message = "设计任务已取消，未生成或发布新版本" }
                    : new { progress = run.Progress, message = "正在停止设计任务" },
                RunTtl,
                CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "设计任务取消的 Redis 投影暂不可用 runId={RunId}", run.Id);
        }
    }

    private static DesignArtifactPublicEvent ToPublicContractEvent(DesignArtifactEventEnvelope record) => new(
        record.RunId,
        record.ArtifactType,
        record.Sequence,
        record.Type,
        record.Phase,
        record.Progress,
        record.OccurredAt,
        record.Authoritative);

    private static string? TrimOptional(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }

    private IActionResult KnowledgeReferenceFailure(DesignKnowledgeSnapshotException ex) =>
        ex.Code == ErrorCodes.NOT_FOUND
            ? NotFound(ApiResponse<object>.Fail(ex.Code, ex.Message))
            : ex.Code == DesignKnowledgeSnapshotResolver.ContentChangedCode
                ? Conflict(ApiResponse<object>.Fail(ex.Code, ex.Message))
                : BadRequest(ApiResponse<object>.Fail(ex.Code, ex.Message));

    private static object ToPublicCapability(DesignArtifactProviderCapability item) => new
    {
        item.Id,
        item.Label,
        item.AdapterKind,
        item.ExecutionOwner,
        item.IsolationMode,
        item.ArtifactTypes,
        item.Operations,
        item.SourceSurfaces,
        item.Configured,
        item.Healthy,
        item.Enabled,
        item.Reason,
    };

    private async Task WriteEventAsync(long? id, string eventName, string json, CancellationToken ct)
    {
        if (id.HasValue) await Response.WriteAsync($"id: {id.Value}\n", ct);
        await Response.WriteAsync($"event: {eventName}\n", ct);
        foreach (var line in json.Replace("\r", string.Empty).Split('\n'))
            await Response.WriteAsync($"data: {line}\n", ct);
        await Response.WriteAsync("\n", ct);
        await Response.Body.FlushAsync(ct);
    }
}

public sealed class CreateDesignArtifactRunRequest
{
    public string? ArtifactType { get; set; }
    public string? SourceSurface { get; set; }
    public string? Runtime { get; set; }
    public string? Instruction { get; set; }
    public string? Title { get; set; }
    public List<DesignKnowledgeReferenceRequest>? KnowledgeReferences { get; set; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalProperties { get; set; }
}

public sealed class DesignKnowledgeReferenceRequest
{
    public string? EntryId { get; set; }
    public string? StoreId { get; set; }
    public string? ContentHash { get; set; }
}

public sealed class ResolveDesignKnowledgeReferencesRequest
{
    public List<DesignKnowledgeReferenceRequest>? KnowledgeReferences { get; set; }
}

public sealed record DesignArtifactE4Evidence(
    string SchemaVersion,
    string RunId,
    string? SessionId,
    string? WorkspaceId,
    string? ManifestSha256,
    string? VersionId,
    string? LlmgwAuditId,
    DesignArtifactAuthorityEvidence Authority,
    DesignArtifactCommitEvidence ManifestCommit,
    DesignArtifactVersionEvidence Version,
    DesignArtifactRuntimeFailureEvidence RuntimeFailure,
    IReadOnlyList<DesignArtifactLlmAuditEvidence> LlmgwAudits,
    DateTime CreatedAt,
    DateTime ExportedAt);

public sealed record DesignArtifactAuthorityEvidence(
    string Owner,
    string? BaseUrl,
    string? Model,
    IReadOnlyList<string> AppCallerCodes);

public sealed record DesignArtifactCommitEvidence(
    string State,
    string? ResultSha256,
    string? PendingAttemptId,
    bool CleanupFailed);

public sealed record DesignArtifactVersionEvidence(
    string? VersionId,
    string? Status,
    string? Source,
    string? ParentVersionId,
    string? PublishFailureCode,
    DateTime? PublishFailedAt,
    DateTime? PublishedAt,
    DesignArtifactRollbackEvidence? LatestRollback);

public sealed record DesignArtifactRollbackEvidence(
    string VersionId,
    string Status,
    string? ParentVersionId,
    string? TargetVersionId,
    string? PublishFailureCode,
    DateTime? PublishFailedAt,
    DateTime? PublishedAt);

public sealed record DesignArtifactRuntimeFailureEvidence(string? Code, bool RunFailed);

public sealed record DesignArtifactLlmAuditEvidence(
    string AuditId,
    string RequestId,
    string Status,
    int? StatusCode,
    string? AppCallerCode,
    string? SourceSystem,
    string? LogicalModel,
    DateTime StartedAt,
    DateTime? EndedAt);

public sealed record DesignArtifactPublicEvent(
    string RunId,
    string ArtifactType,
    long Sequence,
    string Type,
    string? Phase,
    int? Progress,
    DateTime OccurredAt,
    bool Authoritative);
