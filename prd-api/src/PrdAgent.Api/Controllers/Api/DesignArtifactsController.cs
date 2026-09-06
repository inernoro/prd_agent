using System.Text.Json;
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
        "open_design_run_cancelled",
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
    private readonly IRunEventStore _events;
    private readonly IRunQueue _queue;
    private readonly IDesignArtifactProviderCatalog _providers;
    private readonly IDesignKnowledgeSnapshotResolver _knowledgeSnapshots;
    private readonly LlmGatewayDataContext _gatewayDb;

    public DesignArtifactsController(
        MongoDbContext db,
        IRunEventStore events,
        IRunQueue queue,
        IDesignArtifactProviderCatalog providers,
        IDesignKnowledgeSnapshotResolver knowledgeSnapshots,
        LlmGatewayDataContext gatewayDb)
    {
        _db = db;
        _events = events;
        _queue = queue;
        _providers = providers;
        _knowledgeSnapshots = knowledgeSnapshots;
        _gatewayDb = gatewayDb;
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

    [HttpPost("runs")]
    public async Task<IActionResult> CreateRun([FromBody] CreateDesignArtifactRunRequest request)
    {
        var userId = this.GetRequiredUserId();
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
        try
        {
            snapshots = await _knowledgeSnapshots.ResolveAsync(
                userId,
                references.Select(reference => new DesignKnowledgeReferenceIdentity(
                    reference.EntryId ?? string.Empty,
                    reference.StoreId ?? string.Empty)).ToList(),
                CancellationToken.None);
        }
        catch (DesignKnowledgeSnapshotException ex)
        {
            return ex.Code == ErrorCodes.NOT_FOUND
                ? NotFound(ApiResponse<object>.Fail(ex.Code, ex.Message))
                : BadRequest(ApiResponse<object>.Fail(ex.Code, ex.Message));
        }

        var sourceSurface = string.Equals(request.SourceSurface, DesignArtifactSourceSurfaces.KnowledgeBase, StringComparison.OrdinalIgnoreCase)
            ? DesignArtifactSourceSurfaces.KnowledgeBase
            : DesignArtifactSourceSurfaces.WebHosting;
        var runId = Guid.NewGuid().ToString("N");
        var run = new DesignArtifactRun
        {
            Id = runId,
            UserId = userId,
            Status = RunStatuses.Queued,
            ArtifactType = DesignArtifactTypes.WebPage,
            Operation = DesignArtifactOperations.Generate,
            SourceSurface = sourceSurface,
            Runtime = runtime,
            RuntimeConnectionId = capability.ConnectionId,
            Instruction = instruction,
            Title = TrimOptional(request.Title, 200) ?? snapshots[0].Title,
            KnowledgeReferences = snapshots.ToList(),
            Progress = 2,
            Phase = "网页生成任务已进入队列",
        };
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
        await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
        await _events.AppendEventAsync(
            RunKinds.DesignArtifact,
            runId,
            "phase",
            new { progress = 2, message = run.Phase },
            RunTtl,
            CancellationToken.None);
        await _queue.EnqueueAsync(RunKinds.DesignArtifact, runId, CancellationToken.None);
        return Accepted(ApiResponse<object>.Ok(ToDto(run)));
    }

    [HttpGet("runs/{runId}")]
    public async Task<IActionResult> GetRun(string runId)
    {
        var run = await _db.DesignArtifactRuns
            .Find(x => x.Id == runId && x.UserId == this.GetRequiredUserId())
            .FirstOrDefaultAsync(CancellationToken.None);
        return run == null
            ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "设计任务不存在"))
            : Ok(ApiResponse<object>.Ok(ToDto(run)));
    }

    /// <summary>
    /// 导出一条只含稳定关联标识与脱敏状态的 E4 审计证据。
    /// 任何原始错误、Provider 地址、请求正文和凭证均不得进入此响应。
    /// </summary>
    [HttpGet("runs/{runId}/evidence")]
    public async Task<IActionResult> GetEvidence(string runId)
    {
        var userId = this.GetRequiredUserId();
        var run = await _db.DesignArtifactRuns
            .Find(item => item.Id == runId && item.UserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);
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

        var meta = await _events.GetRunAsync(RunKinds.DesignArtifact, runId, ct);
        if (meta == null || meta.CreatedByUserId != this.GetRequiredUserId())
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
        try
        {
            while (!ct.IsCancellationRequested)
            {
                var batch = await _events.GetEventsAsync(RunKinds.DesignArtifact, runId, cursor, 100, ct);
                foreach (var item in batch)
                {
                    await WriteEventAsync(item.Seq, item.EventName, item.PayloadJson, ct);
                    cursor = item.Seq;
                }
                if (batch.Count > 0)
                {
                    idleRounds = 0;
                    continue;
                }

                meta = await _events.GetRunAsync(RunKinds.DesignArtifact, runId, ct);
                if (meta == null || meta.Status is RunStatuses.Done or RunStatuses.Error or RunStatuses.Cancelled)
                    return;

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
        run.Title,
        run.Progress,
        run.Phase,
        run.ArtifactSiteId,
        run.ArtifactRevisionId,
        run.LinkedRunId,
        run.Error,
        run.RuntimeModelCallCount,
        run.RuntimeModelCallLimit,
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

    private static string? TrimOptional(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim();
        return trimmed.Length <= maxLength ? trimmed : trimmed[..maxLength];
    }

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
}

public sealed class DesignKnowledgeReferenceRequest
{
    public string? EntryId { get; set; }
    public string? StoreId { get; set; }
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
