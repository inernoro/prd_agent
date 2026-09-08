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

/// <summary>网页托管入口 HTML 的微调、草稿、发布与回退。</summary>
[ApiController]
[Route("api/web-pages/{siteId}/edits")]
[Authorize]
[AdminController("web-pages", AdminPermissionCatalog.WebPagesRead, WritePermission = AdminPermissionCatalog.WebPagesWrite)]
public sealed class HostedSiteEditsController : ControllerBase
{
    private static readonly TimeSpan RunTtl = TimeSpan.FromHours(24);
    private readonly IHostedSiteService _sites;
    private readonly IHostedSiteRevisionService _revisions;
    private readonly IRunEventStore _events;
    private readonly IRunQueue _queue;
    private readonly MongoDbContext _db;
    private readonly ILogger<HostedSiteEditsController> _logger;
    private readonly IDesignArtifactProviderCatalog _providers;
    private readonly IDesignKnowledgeSnapshotResolver _knowledgeSnapshots;
    private readonly IWebPageDesignArtifactLifecycleAdapter _publicLifecycle;
    private readonly IDesignArtifactLifecycleService _lifecycle;

    public HostedSiteEditsController(
        IHostedSiteService sites,
        IHostedSiteRevisionService revisions,
        IRunEventStore events,
        IRunQueue queue,
        MongoDbContext db,
        ILogger<HostedSiteEditsController> logger,
        IDesignArtifactProviderCatalog providers,
        IDesignKnowledgeSnapshotResolver knowledgeSnapshots,
        IWebPageDesignArtifactLifecycleAdapter publicLifecycle,
        IDesignArtifactLifecycleService lifecycle)
    {
        _sites = sites;
        _revisions = revisions;
        _events = events;
        _queue = queue;
        _db = db;
        _logger = logger;
        _providers = providers;
        _knowledgeSnapshots = knowledgeSnapshots;
        _publicLifecycle = publicLifecycle;
        _lifecycle = lifecycle;
    }

    [HttpGet("runtime-capabilities")]
    public async Task<IActionResult> RuntimeCapabilities()
    {
        var runtimes = (await _providers.ListAsync(this.GetRequiredUserId(), CancellationToken.None))
            .Where(item => item.ArtifactTypes.Contains(DesignArtifactTypes.WebPage, StringComparer.Ordinal)
                           && item.Operations.Contains(DesignArtifactOperations.Edit, StringComparer.Ordinal))
            .ToList();
        return Ok(ApiResponse<object>.Ok(new
        {
            defaultRuntime = HostedSiteEditRuntimes.MapGateway,
            runtimes = runtimes.Select(ToPublicCapability).ToList(),
        }));
    }

    [HttpPost("runs")]
    public async Task<IActionResult> CreateRun(string siteId, [FromBody] CreateHostedSiteEditRunRequest request)
    {
        var userId = this.GetRequiredUserId();
        var protectedOverrides = DesignArtifactRequestAuthorityGuard.FindProtectedOverrides(
            request.AdditionalProperties?.Keys);
        if (protectedOverrides.Count > 0)
        {
            _logger.LogWarning(
                "Rejected hosted-site edit runtime authority override. userId={UserId} siteId={SiteId} fields={Fields}",
                userId,
                siteId,
                string.Join(',', protectedOverrides));
            return BadRequest(ApiResponse<object>.Fail(
                DesignArtifactRequestAuthorityGuard.ErrorCode,
                "运行时模型、网关地址和审计归属由 MAP 统一配置，请移除覆盖字段后重试"));
        }
        var instruction = (request.Instruction ?? string.Empty).Trim();
        if (instruction.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请描述想修改什么"));
        if (instruction.Length > 4000)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "修改要求不能超过 4000 个字符"));

        var knowledgeReferences = request.KnowledgeReferences ?? new List<HostedSiteKnowledgeReference>();
        if (knowledgeReferences.Count > 3)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "首版一次最多引用 3 篇知识"));
        var runtime = string.IsNullOrWhiteSpace(request.Runtime)
            ? HostedSiteEditRuntimes.MapGateway
            : request.Runtime.Trim().ToLowerInvariant();
        var capability = await _providers.FindAsync(userId, runtime, CancellationToken.None);
        if (capability == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的页面修改运行时"));
        if (!capability.ArtifactTypes.Contains(DesignArtifactTypes.WebPage, StringComparer.Ordinal)
            || !capability.Operations.Contains(DesignArtifactOperations.Edit, StringComparer.Ordinal))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "所选执行器不支持修改网页"));
        if (!capability.Enabled)
            return Conflict(ApiResponse<object>.Fail(
                "RUNTIME_NOT_READY",
                capability.Reason ?? "所选页面修改执行器尚未部署并通过健康检查"));

        HostedSiteEditableEntry editable;
        try
        {
            editable = await _sites.GetEditableEntryHtmlAsync(siteId, userId, CancellationToken.None);
            ValidateEditInputCompatibility(editable);
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }

        IReadOnlyList<DesignKnowledgeSnapshot> snapshots;
        try
        {
            snapshots = await _knowledgeSnapshots.ResolveForRunAsync(
                userId,
                knowledgeReferences.Select(reference => new DesignKnowledgeReferenceIdentity(
                    reference.EntryId ?? string.Empty,
                    reference.StoreId ?? string.Empty,
                    reference.ContentHash)).ToList(),
                CancellationToken.None);
        }
        catch (DesignKnowledgeSnapshotException ex)
        {
            return ex.Code == ErrorCodes.NOT_FOUND
                ? NotFound(ApiResponse<object>.Fail(ex.Code, ex.Message))
                : ex.Code == DesignKnowledgeSnapshotResolver.ContentChangedCode
                    ? Conflict(ApiResponse<object>.Fail(ex.Code, ex.Message))
                    : BadRequest(ApiResponse<object>.Fail(ex.Code, ex.Message));
        }

        var runId = Guid.NewGuid().ToString("N");
        var run = new DesignArtifactRun
        {
            Id = runId,
            UserId = userId,
            Status = RunStatuses.Queued,
            ArtifactType = DesignArtifactTypes.WebPage,
            Operation = DesignArtifactOperations.Edit,
            SourceSurface = DesignArtifactSourceSurfaces.WebHosting,
            Runtime = runtime,
            RuntimeConnectionId = capability.ConnectionId,
            Instruction = instruction,
            Title = string.IsNullOrWhiteSpace(editable.Site.Title)
                ? "网页修改"
                : editable.Site.Title.Trim(),
            TargetSiteId = siteId,
            KnowledgeReferences = snapshots.ToList(),
            InputAuthority = snapshots.Count > 0
                ? DesignArtifactInputAuthorities.MixedUserAndServerKnowledge
                : DesignArtifactInputAuthorities.UserSupplied,
            UserSuppliedContentHash = System.Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(instruction))).ToLowerInvariant(),
            Progress = 2,
            Phase = "修改任务已进入队列",
        };
        if (runtime is DesignArtifactRuntimes.OpenDesign or DesignArtifactRuntimes.Codex)
        {
            try
            {
                var package = DesignArtifactWorkspaceContract.BuildInputPackage(run, editable.Html);
                DesignArtifactWorkspaceContract.ValidateInputPackageSize(
                    package,
                    DesignArtifactWorkspaceBroker.MaxInputBytes);
            }
            catch (InvalidOperationException ex)
            {
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
            }
        }
        WebPageDesignArtifactLifecycleAdapter.InitializeNewRun(run, capability, editable.Html);
        await _db.DesignArtifactRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);
        var input = JsonSerializer.Serialize(new { SiteId = siteId });
        var meta = new RunMeta
        {
            RunId = runId,
            Kind = RunKinds.DesignArtifact,
            Status = RunStatuses.Queued,
            CreatedByUserId = userId,
            CreatedAt = DateTime.UtcNow,
            InputJson = input,
        };
        try
        {
            await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
            await _events.AppendEventAsync(
                RunKinds.DesignArtifact,
                runId,
                "phase",
                new { progress = 2, message = "修改任务已进入队列" },
                RunTtl,
                CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "网页修改任务 Redis 兼容投影暂不可用 runId={RunId}", runId);
        }
        try
        {
            await _queue.EnqueueAsync(RunKinds.DesignArtifact, runId, CancellationToken.None);
        }
        catch (Exception ex)
        {
            // Mongo queued 记录是权威入队意图，恢复器会重试；客户端仍拿到唯一 runId，避免未知副作用后重建任务。
            _logger.LogWarning(ex, "网页修改任务即时入队失败，等待 Mongo 恢复器重试 runId={RunId}", runId);
        }
        return Accepted(ApiResponse<object>.Ok(new { runId, status = meta.Status, runtime }));
    }

    internal static string ValidateEditInputCompatibility(HostedSiteEditableEntry editable)
    {
        var isMarkdownWrapper = string.Equals(
            editable.Site.WrappedAssetType,
            "markdown",
            StringComparison.OrdinalIgnoreCase);
        if (!HostedSiteContentShapeRules.IsSelfContainedHtml(editable.Site) && !isMarkdownWrapper)
        {
            throw new InvalidOperationException(
                "当前站点包含 ZIP 或多文件资源；首版 AI 微调只支持单个声明式、自包含 HTML，请先把 CSS、图片等资源内嵌到入口 HTML 后再试");
        }

        var normalized = DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(editable.Html);
        try
        {
            _ = HostedSiteRevisionRules.HardenGeneratedHtml(normalized);
            return normalized;
        }
        catch (InvalidOperationException ex)
        {
            throw new InvalidOperationException(
                $"当前站点无法进入首版 AI 微调：仅支持声明式、自包含 HTML，请先移除脚本、外链、相对资源或嵌入能力后再试。{ex.Message}");
        }
    }

    [HttpGet("runs/{runId}")]
    public async Task<IActionResult> GetRun(string siteId, string runId)
    {
        var run = await _db.DesignArtifactRuns
            .Find(x => x.Id == runId
                       && x.UserId == this.GetRequiredUserId()
                       && x.TargetSiteId == siteId
                       && x.Operation == DesignArtifactOperations.Edit
                       && x.ArtifactType == DesignArtifactTypes.WebPage
                       && x.SourceSurface == DesignArtifactSourceSurfaces.WebHosting)
            .FirstOrDefaultAsync(CancellationToken.None);
        return run == null
            ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "修改任务不存在"))
            : Ok(ApiResponse<object>.Ok(ToRunDto(run)));
    }

    [HttpPost("runs/{runId}/cancel")]
    public async Task<IActionResult> CancelRun(string siteId, string runId)
    {
        var userId = this.GetRequiredUserId();
        var current = await FindOwnedEditRunAsync(siteId, runId, userId);
        if (current == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "修改任务不存在"));

        DesignArtifactRun updated;
        try
        {
            updated = current.ContractVersion == DesignArtifactContractVersions.Current
                ? await _lifecycle.RequestCancellationAsync(
                    new RequestDesignArtifactCancellationRequest(
                        current.Id,
                        current.UserId,
                        current.LifecycleVersion,
                        current.WorkspaceRef?.BaseRevision,
                        current.VersionBoundary?.BaseContentHash),
                    CancellationToken.None)
                : await RequestLegacyCancellationAsync(_db, current, DateTime.UtcNow);
        }
        catch (DesignArtifactLifecycleException ex)
            when (ex.Code == DesignArtifactLifecycleErrorCodes.Conflict)
        {
            return Conflict(ApiResponse<object>.Fail(
                "DESIGN_ARTIFACT_CANCEL_CONFLICT",
                "任务已经进入保存或终态，不能再取消；请刷新任务状态确认结果"));
        }
        catch (DesignArtifactRunCancellationConflictException)
        {
            return Conflict(ApiResponse<object>.Fail(
                "DESIGN_ARTIFACT_CANCEL_CONFLICT",
                "任务已经进入保存或终态，不能再取消；请刷新任务状态确认结果"));
        }

        var changed = current.Status != updated.Status
                      || current.CancelRequestedAt != updated.CancelRequestedAt;
        await ProjectCancellationBestEffortAsync(updated);
        return Ok(ApiResponse<object>.Ok(new
        {
            runId = updated.Id,
            updated.Status,
            cancelRequested = updated.CancelRequestedAt.HasValue,
            changed,
        }));
    }

    [HttpGet("runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamRun(string siteId, string runId, [FromQuery] long afterSeq = 0, CancellationToken ct = default)
    {
        Response.ContentType = "text/event-stream; charset=utf-8";
        Response.Headers.CacheControl = "no-cache, no-transform";
        Response.Headers["X-Accel-Buffering"] = "no";

        var userId = this.GetRequiredUserId();
        var initial = await FindOwnedEditRunAsync(siteId, runId, userId);
        if (initial == null)
        {
            await WriteEventAsync(null, "error", JsonSerializer.Serialize(new
            {
                code = ErrorCodes.NOT_FOUND,
                message = "修改任务不存在",
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
                        batch = await _events.GetEventsAsync(RunKinds.DesignArtifact, runId, cursor, 100, ct);
                    }
                    catch (Exception ex)
                    {
                        redisProjectionAvailable = false;
                        _logger.LogWarning(ex, "网页修改任务 Redis 事件流不可用，切换 Mongo 权威状态 runId={RunId}", runId);
                    }
                }
                var terminalEventEmitted = false;
                foreach (var item in batch)
                {
                    await WriteEventAsync(item.Seq, item.EventName, item.PayloadJson, ct);
                    cursor = item.Seq;
                    terminalEventEmitted = item.EventName is "done" or "error" or "cancelled";
                }
                if (terminalEventEmitted) return;
                if (batch.Count > 0)
                {
                    idleRounds = 0;
                    continue;
                }

                var snapshot = await FindOwnedEditRunAsync(siteId, runId, userId);
                if (snapshot == null) return;
                if (!redisProjectionAvailable
                    && (snapshot.Progress != lastMongoProgress
                        || !string.Equals(snapshot.Phase, lastMongoPhase, StringComparison.Ordinal)))
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
                    var revisionId = snapshot.ArtifactRevisionId ?? snapshot.ProducedArtifactRevisionId;
                    if (!string.IsNullOrWhiteSpace(revisionId))
                    {
                        await WriteEventAsync(null, "done", JsonSerializer.Serialize(new
                        {
                            revisionId,
                            siteId = snapshot.ArtifactSiteId ?? snapshot.ProducedArtifactSiteId ?? siteId,
                            status = HostedSiteRevisionStatuses.Draft,
                        }), ct);
                    }
                    return;
                }
                if (snapshot.Status == RunStatuses.Cancelled)
                {
                    await WriteEventAsync(null, "cancelled", JsonSerializer.Serialize(new
                    {
                        code = "DESIGN_ARTIFACT_CANCELLED",
                        message = "设计任务已取消，未生成或发布新版本",
                    }), ct);
                    return;
                }
                if (snapshot.Status == RunStatuses.Error)
                {
                    await WriteEventAsync(null, "error", JsonSerializer.Serialize(new
                    {
                        code = "DESIGN_ARTIFACT_FAILED",
                        message = string.IsNullOrWhiteSpace(snapshot.Error)
                            ? "页面修改未完成，请重新发起"
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

    private async Task<DesignArtifactRun?> FindOwnedEditRunAsync(string siteId, string runId, string userId) =>
        await _db.DesignArtifactRuns.Find(x => x.Id == runId
                                         && x.UserId == userId
                                         && x.TargetSiteId == siteId
                                         && x.Operation == DesignArtifactOperations.Edit
                                         && x.ArtifactType == DesignArtifactTypes.WebPage
                                         && x.SourceSurface == DesignArtifactSourceSurfaces.WebHosting)
            .FirstOrDefaultAsync(CancellationToken.None);

    internal static async Task<DesignArtifactRun> RequestLegacyCancellationAsync(
        MongoDbContext db,
        DesignArtifactRun current,
        DateTime requestedAt)
    {
        if (current.Status == RunStatuses.Cancelled)
            return current;
        if (current.Status == RunStatuses.Running && current.CancelRequestedAt.HasValue)
            return current;
        if (current.Status is not (RunStatuses.Queued or RunStatuses.Running))
            throw new DesignArtifactRunCancellationConflictException();

        var terminal = current.Status == RunStatuses.Queued;
        var filter = Builders<DesignArtifactRun>.Filter.And(
            Builders<DesignArtifactRun>.Filter.Eq(item => item.Id, current.Id),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.UserId, current.UserId),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.Status, current.Status),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.CancelRequestedAt, null),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.LeaseOwnerId, current.LeaseOwnerId),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.LeaseExpiresAt, current.LeaseExpiresAt),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.ProducedArtifactSiteId, current.ProducedArtifactSiteId),
            Builders<DesignArtifactRun>.Filter.Eq(item => item.ProducedArtifactRevisionId, current.ProducedArtifactRevisionId));
        var update = Builders<DesignArtifactRun>.Update
            .Set(item => item.CancelRequestedAt, requestedAt)
            .Set(item => item.CancelRequestedByUserId, current.UserId)
            .Set(item => item.Phase, terminal ? "设计任务已取消" : "正在停止设计任务")
            .Set(item => item.UpdatedAt, requestedAt);
        if (terminal)
        {
            update = update
                .Set(item => item.Status, RunStatuses.Cancelled)
                .Set(item => item.CancelledAt, requestedAt)
                .Set(item => item.CompletedAt, requestedAt)
                .Set(item => item.LeaseOwnerId, null)
                .Set(item => item.LeaseExpiresAt, null);
        }
        var updated = await db.DesignArtifactRuns.FindOneAndUpdateAsync(
            filter,
            update,
            new FindOneAndUpdateOptions<DesignArtifactRun, DesignArtifactRun>
            {
                ReturnDocument = ReturnDocument.After,
            },
            CancellationToken.None);
        return updated ?? throw new DesignArtifactRunCancellationConflictException();
    }

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
            _logger.LogWarning(ex, "网页修改取消状态 Redis 投影暂不可用 runId={RunId}", run.Id);
        }
    }

    [HttpGet("revisions")]
    public async Task<IActionResult> ListRevisions(string siteId)
    {
        var userId = this.GetRequiredUserId();
        try
        {
            var current = await _sites.GetRevisionEntryHtmlAsync(siteId, userId, CancellationToken.None);
            await _revisions.EnsureCurrentSnapshotAsync(
                siteId,
                userId,
                current,
                CancellationToken.None);
            var items = await _revisions.ListAsync(siteId, userId, CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(items.Select(x => ToDto(x, current.ContentVersion)).ToList()));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpGet("revisions/{revisionId}/preview")]
    public async Task<IActionResult> PreviewRevision(string siteId, string revisionId)
    {
        try
        {
            var item = await _revisions.GetAsync(siteId, revisionId, this.GetRequiredUserId(), CancellationToken.None);
            if (item == null)
                return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本不存在"));
            return Ok(ApiResponse<object>.Ok(new { revision = ToDto(item, null), html = item.Html }));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "站点不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    [HttpPost("revisions/{revisionId}/publish")]
    public async Task<IActionResult> PublishRevision(string siteId, string revisionId)
        => await MutateRevisionAsync(siteId, revisionId, idempotencyKey: null);

    [HttpPost("revisions/{revisionId}/rollback")]
    public async Task<IActionResult> RollbackRevision(
        string siteId,
        string revisionId,
        [FromHeader(Name = "Idempotency-Key")] string? idempotencyKey)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey))
            return BadRequest(ApiResponse<object>.Fail("IDEMPOTENCY_KEY_REQUIRED", "回退请求缺少 Idempotency-Key"));
        var normalized = idempotencyKey.Trim();
        if (normalized.Length is < 8 or > 128
            || normalized.Any(character => character < 0x21 || character > 0x7e))
            return BadRequest(ApiResponse<object>.Fail("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key 格式不正确"));
        return await MutateRevisionAsync(siteId, revisionId, normalized);
    }

    [HttpPost("revisions/{revisionId}/reject")]
    public async Task<IActionResult> RejectRevision(
        string siteId,
        string revisionId,
        [FromBody] RejectHostedSiteRevisionRequest? request)
    {
        string? reason;
        try
        {
            reason = HostedSiteRevisionRules.NormalizeRejectionReason(request?.Reason);
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }

        try
        {
            var result = await _revisions.RejectAsync(
                siteId,
                revisionId,
                this.GetRequiredUserId(),
                reason,
                CancellationToken.None);
            if (!result.Changed)
                PrdAgent.Api.Filters.ActivityLogActionFilter.Suppress(HttpContext);
            return Ok(ApiResponse<object>.Ok(new
            {
                revision = ToDto(result.Revision, null),
                result.Changed,
            }));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本或站点不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return Conflict(ApiResponse<object>.Fail("REVISION_CONFLICT", ex.Message));
        }
    }

    private async Task<IActionResult> MutateRevisionAsync(
        string siteId,
        string revisionId,
        string? idempotencyKey)
    {
        try
        {
            var result = idempotencyKey != null
                ? await _revisions.RollbackAsync(
                    siteId,
                    revisionId,
                    this.GetRequiredUserId(),
                    idempotencyKey,
                    CancellationToken.None)
                : await _revisions.PublishAsync(
                    siteId,
                    revisionId,
                    this.GetRequiredUserId(),
                    CancellationToken.None);
            if (idempotencyKey == null
                && string.Equals(
                    result.Revision.Runtime,
                    DesignArtifactRuntimes.OpenDesign,
                    StringComparison.Ordinal)
                && !string.IsNullOrWhiteSpace(result.Revision.SourceRunId))
            {
                try
                {
                    await _publicLifecycle.BindPublishedAsync(
                        result.Revision.SourceRunId,
                        result.Revision.SiteId,
                        result.Revision.Id,
                        CancellationToken.None);
                }
                catch (Exception ex)
                {
                    // 发布本身已经成功，公共审计绑定由恢复器继续补记，不能把成功响应伪装成失败。
                    _logger.LogWarning(
                        ex,
                        "OpenDesign 草稿发布后公共生命周期绑定待恢复 runId={RunId} revisionId={RevisionId}",
                        result.Revision.SourceRunId,
                        result.Revision.Id);
                }
            }
            if (!result.Changed)
                PrdAgent.Api.Filters.ActivityLogActionFilter.Suppress(HttpContext);
            return Ok(ApiResponse<object>.Ok(new
            {
                revision = ToDto(result.Revision, result.Site.ContentVersion),
                site = result.Site,
                result.Changed,
            }));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "版本或站点不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return Conflict(ApiResponse<object>.Fail("REVISION_CONFLICT", ex.Message));
        }
    }

    private static object ToDto(HostedSiteRevision item, DateTime? currentContentVersion) => new
    {
        item.Id,
        item.SiteId,
        item.Status,
        item.Source,
        item.ParentRevisionId,
        item.RollbackTargetRevisionId,
        item.SourceRunId,
        item.Instruction,
        item.Runtime,
        item.KnowledgeEntryIds,
        item.BasedOnContentVersion,
        item.PublishedContentVersion,
        item.CreatedAt,
        item.PublishedAt,
        item.RejectedAt,
        item.RejectedByUserId,
        item.RejectionReason,
        isCurrent = currentContentVersion.HasValue && item.PublishedContentVersion == currentContentVersion,
    };

    private static object ToRunDto(DesignArtifactRun run) => new
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
        artifactSiteId = run.ArtifactSiteId ?? run.ProducedArtifactSiteId,
        artifactRevisionId = run.ArtifactRevisionId ?? run.ProducedArtifactRevisionId,
        run.LinkedRunId,
        run.Error,
        cancelRequested = run.CancelRequestedAt.HasValue,
        run.CancelRequestedAt,
        run.CancelledAt,
        run.CreatedAt,
        knowledgeReferences = run.KnowledgeReferences.Select(item => new
        {
            item.EntryId,
            item.StoreId,
            item.StoreName,
            item.Title,
            item.ContentHash,
        }),
    };

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

public sealed class CreateHostedSiteEditRunRequest
{
    public string? Instruction { get; set; }
    public string? Runtime { get; set; }
    public List<HostedSiteKnowledgeReference>? KnowledgeReferences { get; set; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalProperties { get; set; }
}

public sealed class HostedSiteKnowledgeReference
{
    public string? EntryId { get; set; }
    public string? StoreId { get; set; }
    public string? ContentHash { get; set; }
}

public sealed class RejectHostedSiteRevisionRequest
{
    public string? Reason { get; set; }
}

internal sealed class DesignArtifactRunCancellationConflictException : InvalidOperationException;
