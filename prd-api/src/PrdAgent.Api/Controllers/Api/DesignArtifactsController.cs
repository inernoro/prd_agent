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
    /// <summary>
    /// 公开生成流放行的事件名。worker 产出的事件必须出现在这里才会推给前端，漏一个就是
    /// 「事件发了、前端永远收不到」的静默断链——`model` 就这么漏过一次（Codex P1，2026-09-15）。
    /// 守卫：DesignArtifactStreamEventContractTests 扫 worker 真正 append 的事件名逐一比对。
    /// </summary>
    internal static readonly HashSet<string> PublicGenerationStreamEvents = new(StringComparer.Ordinal)
    {
        "phase",
        "model",
        "thinking",
        "delta",
        "preview",
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
    private readonly IHostedSiteService _sites;
    private readonly ILogger<DesignArtifactsController>? _logger;
    private readonly IDesignGenerationSettingsService? _generationSettings;

    public DesignArtifactsController(
        MongoDbContext db,
        IRunEventStore events,
        IRunQueue queue,
        IDesignArtifactProviderCatalog providers,
        IDesignKnowledgeSnapshotResolver knowledgeSnapshots,
        LlmGatewayDataContext gatewayDb,
        IDesignArtifactCancellationCoordinator cancellation,
        IConfiguration configuration,
        IHostedSiteService sites,
        ILogger<DesignArtifactsController>? logger = null,
        IDesignGenerationSettingsService? generationSettings = null)
    {
        _db = db;
        _events = events;
        _queue = queue;
        _providers = providers;
        _knowledgeSnapshots = knowledgeSnapshots;
        _gatewayDb = gatewayDb;
        _cancellation = cancellation;
        _configuration = configuration;
        _sites = sites;
        _logger = logger;
        _generationSettings = generationSettings;
    }

    [HttpGet("runtime-capabilities")]
    public async Task<IActionResult> RuntimeCapabilities()
    {
        var runtimes = (await _providers.ListAsync(this.GetRequiredUserId(), CancellationToken.None))
            .Where(item => item.ArtifactTypes.Contains(DesignArtifactTypes.WebPage, StringComparer.Ordinal))
            .ToList();
        return Ok(ApiResponse<object>.Ok(new
        {
            defaultRuntime = WebPageDesignRuntimePolicy.RequiredRuntime,
            runtimes = runtimes.Select(ToPublicCapability).ToList(),
        }));
    }

    /// <summary>
    /// 在创建设计任务前读取知识来源的当前权威哈希。响应不返回正文；创建 Run 时仍会二次读取并校验。
    /// </summary>
    /// <summary>
    /// 本部署最近 30 天网页生成的真实耗时（按执行器 × 产物类型分组的 P50 / P95），
    /// 以及「资料到可分享链接」端到端耗时。口径见 <see cref="DesignArtifactTimingStats"/>。
    /// 只返回聚合数字，不含任何任务正文或用户标识。前端据此给出「预计约 X 分钟」，
    /// 样本不足 estimateMinSamples 时前端退回经验值并明说数据在积累。
    /// </summary>
    [HttpGet("timing-stats")]
    public async Task<IActionResult> TimingStats(CancellationToken ct)
    {
        var result = await DesignArtifactTimingStats.QueryAsync(_db, DateTime.UtcNow, ct);
        return Ok(ApiResponse<object>.Ok(result));
    }

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

        // 目标空间在这一刻就定下来：用户还在场，权限不通过可以当场告诉他。等到建站时才校验，
        // 用户多半已经走了，剩下的只有「静默落回个人空间」这一种结局。
        var destinationTeamId = TrimOptional(request.DestinationTeamId, 64);
        if (destinationTeamId != null
            && !await _sites.CanPublishIntoTeamAsync(userId, destinationTeamId, CancellationToken.None))
        {
            return StatusCode(403, ApiResponse<object>.Fail(
                ErrorCodes.PERMISSION_DENIED, "你在该团队是只读或非成员角色，无法把生成的网页放进这个空间"));
        }

        var runtimeDecision = WebPageDesignRuntimePolicy.ResolveForNewRun(request.Runtime);
        var runtime = runtimeDecision.Runtime;
        if (runtimeDecision.ClientOverrideIgnored)
        {
            _logger?.LogWarning(
                "网页生成任务忽略了旧客户端提交的执行器选择，统一使用 OpenDesign。userId={UserId} operation={Operation}",
                userId,
                DesignArtifactOperations.Generate);
        }
        var capability = await _providers.FindAsync(userId, runtime, CancellationToken.None);
        if (capability == null)
            return Conflict(ApiResponse<object>.Fail("RUNTIME_NOT_READY", "设计服务未配置，请联系管理员检查部署状态"));
        if (!capability.ArtifactTypes.Contains(DesignArtifactTypes.WebPage, StringComparer.Ordinal)
            || !capability.Operations.Contains(DesignArtifactOperations.Generate, StringComparer.Ordinal))
            return Conflict(ApiResponse<object>.Fail("RUNTIME_NOT_READY", "设计服务暂不支持生成网页"));
        if (!capability.Enabled)
            return Conflict(ApiResponse<object>.Fail(
                "RUNTIME_NOT_READY",
                capability.Reason ?? "设计服务尚未部署并通过健康检查，请稍后重试"));

        var references = request.KnowledgeReferences ?? new List<DesignKnowledgeReferenceRequest>();
        List<DesignUploadedSource> uploadedSources;
        DesignArtifactDesignDirection? designDirection = null;
        try
        {
            uploadedSources = await DesignRunInputAttachments.ResolveSourcesAsync(
                _db, userId, request.AttachmentIds, CancellationToken.None);
            if (!string.IsNullOrWhiteSpace(request.StyleId) && !string.IsNullOrWhiteSpace(request.DesignSystemId))
                return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                    "风格只能选一种：预设风格、我的风格或目录里的设计系统，不能同时提交"));
            // 预设 / 我的风格（personal:<id>，服务端按归属人取）/ 目录设计系统，判据全在 FreezeForRunAsync 一处。
            if (_generationSettings != null)
                designDirection = await _generationSettings.FreezeForRunAsync(
                    userId, request.StyleId, request.DesignSystemId, CancellationToken.None);
        }
        catch (DesignRunInputException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (DesignGenerationSettingsException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        if (references.Count == 0 && uploadedSources.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请至少选择一篇知识或上传一个文件作为网页内容来源"));
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
            if (identities.Count == 0) snapshots = Array.Empty<DesignKnowledgeSnapshot>();
            else
            {
                var workspace = await _knowledgeSnapshots.ResolveWorkspaceForRunAsync(userId, identities, CancellationToken.None);
                snapshots = workspace.KnowledgeReferences;
                originals = workspace.Originals;
            }
        }
        catch (DesignKnowledgeSnapshotException ex)
        {
            return KnowledgeReferenceFailure(ex);
        }

        var sourceSurface = string.Equals(request.SourceSurface, DesignArtifactSourceSurfaces.KnowledgeBase, StringComparison.OrdinalIgnoreCase)
            ? DesignArtifactSourceSurfaces.KnowledgeBase
            : DesignArtifactSourceSurfaces.WebHosting;
        var runId = Guid.NewGuid().ToString("N");
        var createdAt = DateTime.UtcNow;
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
            DestinationTeamId = destinationTeamId,
            Runtime = runtime,
            LlmRequestPolicy = requestPolicy,
            RuntimeConnectionId = capability.ConnectionId,
            Instruction = instruction,
            Title = TrimOptional(request.Title, 200)
                    ?? (snapshots.Count > 0 ? snapshots[0].Title : Path.GetFileNameWithoutExtension(uploadedSources[0].FileName)),
            KnowledgeReferences = snapshots.ToList(),
            KnowledgeOriginals = originals,
            UploadedSources = uploadedSources.Count > 0 ? uploadedSources : null,
            DesignDirection = designDirection,
            InputAuthority = snapshots.Count > 0 || uploadedSources.Count > 0
                ? DesignArtifactInputAuthorities.MixedUserAndServerKnowledge
                : DesignArtifactInputAuthorities.UserSupplied,
            UserSuppliedContentHash = System.Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(instruction))).ToLowerInvariant(),
            Progress = 2,
            PhaseCode = DesignArtifactPhaseCodes.Queued,
            Phase = "网页生成任务已进入队列",
            FirstVisibleFeedbackAt = createdAt,
            LastProgressAt = createdAt,
            CreatedAt = createdAt,
            UpdatedAt = createdAt,
        };
        DesignArtifactBriefFactory.Freeze(run, currentHtml: null);
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
                new { phaseCode = run.PhaseCode, progress = 2, message = run.Phase },
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

    /// <summary>
    /// 从服务端发现当前用户的活动或可重开任务。浏览器存储只作加速，
    /// 换标签页、设备或禁用 sessionStorage 也能找回同一条 Run。
    /// </summary>
    [HttpGet("runs/active")]
    public async Task<IActionResult> GetActiveRun(
        [FromQuery] string? operation = null,
        [FromQuery] string? targetSiteId = null)
    {
        var userId = this.GetRequiredUserId();
        var normalizedOperation = operation?.Trim().ToLowerInvariant();
        if (normalizedOperation is not (null or DesignArtifactOperations.Generate or DesignArtifactOperations.Edit))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务类型只能是 generate 或 edit"));
        var normalizedSiteId = TrimOptional(targetSiteId, 128);
        if (normalizedOperation == DesignArtifactOperations.Edit && normalizedSiteId == null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "查找修改任务时必须提供站点编号"));

        var filter = Builders<DesignArtifactRun>.Filter.Eq(item => item.DeploymentSlug, DeploymentScope.Current)
                     & Builders<DesignArtifactRun>.Filter.Eq(item => item.UserId, userId)
                     & Builders<DesignArtifactRun>.Filter.Eq(item => item.ArtifactType, DesignArtifactTypes.WebPage)
                     & Builders<DesignArtifactRun>.Filter.Eq(item => item.Runtime, DesignArtifactRuntimes.OpenDesign);
        if (normalizedOperation != null)
            filter &= Builders<DesignArtifactRun>.Filter.Eq(item => item.Operation, normalizedOperation);
        if (normalizedSiteId != null)
            filter &= Builders<DesignArtifactRun>.Filter.Eq(item => item.TargetSiteId, normalizedSiteId);
        var candidates = await _db.DesignArtifactRuns.Find(filter)
            .SortByDescending(item => item.CreatedAt)
            .Limit(20)
            .ToListAsync(CancellationToken.None);
        var run = candidates.FirstOrDefault(item => item.Status is RunStatuses.Queued or RunStatuses.Running or RunStatuses.Committing);
        if (run == null && candidates.FirstOrDefault() is { } latest && IsRestartableInterrupted(latest))
            run = latest;
        return Ok(ApiResponse<object?>.Ok(run == null ? null : ToDto(run)));
    }

    /// <summary>
    /// 服务重启中断后以原 Run 的冻结输入创建新 Run。幂等键决定新 runId，
    /// 重复点击只返回同一条新任务；原 Run 的中断原因保持不变。
    /// </summary>
    [HttpPost("runs/{runId}/restart")]
    public async Task<IActionResult> RestartRun(
        string runId,
        [FromBody] RestartDesignArtifactRunRequest request)
    {
        var userId = this.GetRequiredUserId();
        var source = await _db.FindDesignArtifactRunHistoryAsync(
            item => item.Id == runId && item.UserId == userId,
            CancellationToken.None);
        if (source == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "设计任务不存在"));
        if (!IsRestartableInterrupted(source))
            return Conflict(ApiResponse<object>.Fail(
                "DESIGN_ARTIFACT_NOT_RESTARTABLE",
                "只有被服务重启中断的 OpenDesign 任务才能用冻结输入重开"));
        var key = request.IdempotencyKey?.Trim() ?? string.Empty;
        if (key.Length is < 8 or > 128 || key.Any(char.IsControl))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "重开请求缺少有效的幂等键"));
        var keyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant();
        var deterministicId = Convert.ToHexString(SHA256.HashData(
                Encoding.UTF8.GetBytes($"{source.Id}:{keyHash}")))
            .ToLowerInvariant()[..32];
        var existing = await _db.DesignArtifactRuns.Find(item => item.Id == deterministicId).FirstOrDefaultAsync(CancellationToken.None);
        if (existing != null)
        {
            if (existing.UserId != userId || existing.RestartedFromRunId != source.Id
                                          || existing.RestartIdempotencyKeyHash != keyHash)
                return Conflict(ApiResponse<object>.Fail("DESIGN_ARTIFACT_RESTART_CONFLICT", "重开请求冲突，请刷新后重试"));
            return Accepted(ApiResponse<object>.Ok(ToDto(existing)));
        }

        var capability = await _providers.FindAsync(userId, DesignArtifactRuntimes.OpenDesign, CancellationToken.None);
        if (capability == null || !capability.Enabled || !capability.Operations.Contains(source.Operation, StringComparer.Ordinal))
            return Conflict(ApiResponse<object>.Fail(
                "RUNTIME_NOT_READY",
                capability?.Reason ?? "设计服务尚未恢复，冻结输入已保留，请稍后再重开"));

        string? currentHtml = null;
        if (source.Operation == DesignArtifactOperations.Edit)
        {
            if (string.IsNullOrWhiteSpace(source.TargetSiteId))
                return Conflict(ApiResponse<object>.Fail("DESIGN_ARTIFACT_RESTART_INPUT_MISSING", "原修改任务缺少目标站点，无法重开"));
            try
            {
                currentHtml = (await _sites.GetEditableEntryHtmlAsync(
                    source.TargetSiteId,
                    userId,
                    CancellationToken.None)).Html;
            }
            catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException)
            {
                return Conflict(ApiResponse<object>.Fail("DESIGN_ARTIFACT_RESTART_INPUT_MISSING", "原页面已不可用，无法按冻结要求重开"));
            }
            var currentHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
                    DesignArtifactWorkspaceContract.NormalizeCurrentHtmlForRemoteEditing(currentHtml))))
                .ToLowerInvariant();
            if (string.IsNullOrWhiteSpace(source.VersionBoundary?.BaseContentHash)
                || !string.Equals(source.VersionBoundary.BaseContentHash, currentHash, StringComparison.Ordinal))
                return Conflict(ApiResponse<object>.Fail(
                    "DESIGN_ARTIFACT_RESTART_INPUT_CHANGED",
                    "原页面已发生变化，不能冒充上次冻结输入重开；请从当前页面重新发起修改"));
        }

        var now = DateTime.UtcNow;
        var restarted = CloneForRestart(source, capability, deterministicId, keyHash, now);
        WebPageDesignArtifactLifecycleAdapter.InitializeNewRun(restarted, capability, currentHtml);
        try
        {
            await _db.DesignArtifactRuns.InsertOneAsync(restarted, cancellationToken: CancellationToken.None);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            existing = await _db.DesignArtifactRuns.Find(item => item.Id == deterministicId).FirstOrDefaultAsync(CancellationToken.None);
            if (existing == null || existing.UserId != userId || existing.RestartedFromRunId != source.Id
                                 || existing.RestartIdempotencyKeyHash != keyHash)
                return Conflict(ApiResponse<object>.Fail("DESIGN_ARTIFACT_RESTART_CONFLICT", "重开请求冲突，请刷新后重试"));
            return Accepted(ApiResponse<object>.Ok(ToDto(existing)));
        }

        var meta = new RunMeta
        {
            RunId = restarted.Id,
            Kind = RunKinds.DesignArtifact,
            Status = RunStatuses.Queued,
            CreatedByUserId = userId,
            CreatedAt = restarted.CreatedAt,
            InputJson = JsonSerializer.Serialize(new { restartedFromRunId = source.Id }),
        };
        try
        {
            await _events.SetRunAsync(RunKinds.DesignArtifact, meta, RunTtl, ct: CancellationToken.None);
            await _events.AppendEventAsync(
                RunKinds.DesignArtifact,
                restarted.Id,
                "phase",
                new { phaseCode = restarted.PhaseCode, progress = restarted.Progress, message = restarted.Phase },
                RunTtl,
                CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "重开设计任务的 Redis 投影暂不可用 runId={RunId}", restarted.Id);
        }
        try
        {
            await _queue.EnqueueAsync(RunKinds.DesignArtifact, restarted.Id, CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger?.LogWarning(ex, "重开设计任务即时入队失败，等待 Mongo 恢复器 runId={RunId}", restarted.Id);
        }
        return Accepted(ApiResponse<object>.Ok(ToDto(restarted)));
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
        // 与查询接口同一口径：只要这条任务存在就不许回「不存在」。分支重新部署后任务可能还登记在
        // 上一版 revision 名下，是接管、还是说清楚为什么不能停，交给取消协调器按作用域判（#135）。
        var generationRun = await _db.DesignArtifactRuns
            .Find(run => run.Id == runId
                         && run.UserId == userId
                         && run.ArtifactType == DesignArtifactTypes.WebPage
                         && run.Operation == DesignArtifactOperations.Generate)
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
        catch (DesignArtifactCancellationUnavailableException ex)
        {
            return Conflict(ApiResponse<object>.Fail(ex.Code, ex.Message));
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
        string? lastMongoModel = null;
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
                    // 终态一出就停：同一批里迟到的输出不再转发，与修改流同一条规则。
                    if (item.EventName is "done" or "error" or "cancelled")
                    {
                        terminalEventEmitted = true;
                        break;
                    }
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
                        phaseCode = snapshot.PhaseCode,
                        progress = snapshot.Progress,
                        message = snapshot.Phase,
                    }), ct);
                    lastMongoProgress = snapshot.Progress;
                    lastMongoPhase = snapshot.Phase;
                }
                // Redis 那条投影挂了的时候，模型事件也跟着没了——而模型已经落在库里。
                // 不在这里补一条，用户看到的就是「这次没有模型」，而不是「这次读不到模型」
                // （静默降级：坏的那条路产出的结果和正常结果分不开）。
                if (!string.IsNullOrWhiteSpace(snapshot.ResolvedModel)
                    && !string.Equals(snapshot.ResolvedModel, lastMongoModel, StringComparison.Ordinal))
                {
                    await WriteEventAsync(null, "model", JsonSerializer.Serialize(new
                    {
                        model = snapshot.ResolvedModel,
                        platform = snapshot.ResolvedPlatform,
                    }), ct);
                    lastMongoModel = snapshot.ResolvedModel;
                }
                if (snapshot.Status == RunStatuses.Done)
                {
                    var siteId = snapshot.ArtifactSiteId ?? snapshot.ProducedArtifactSiteId;
                    var revisionId = snapshot.ArtifactRevisionId ?? snapshot.ProducedArtifactRevisionId;
                    if (!string.IsNullOrWhiteSpace(siteId))
                    {
                        // destinationApplyError 必须跟着走：正常路径的 done 带着它，
                        // 前端据此提醒「页面留在了个人空间」。兜底这条漏掉它，
                        // 就是把一次「站建好了但没归到目标团队」报成完全成功——
                        // 降级路径产出的结果与正常结果分不开，正是这份代码上面那段注释在防的事。
                        await WriteEventAsync(null, "done", JsonSerializer.Serialize(new
                        {
                            siteId,
                            revisionId,
                            status = HostedSiteRevisionStatuses.Draft,
                            destinationApplyError = snapshot.DestinationApplyError,
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
        // 实际执行的模型与平台：刷新或恢复未完成任务时，面板靠它显示「{模型} · {平台}」，
        // 而不是只显示运行时名字（ai-model-visibility §4）。
        run.ResolvedModel,
        run.ResolvedPlatform,
        run.LlmRequestPolicy,
        llmRequestPolicyState = run.LlmRequestPolicy == null ? "legacy-unfrozen" : "frozen",
        styleId = run.DesignDirection?.StyleId,
        styleName = run.DesignDirection?.StyleName,
        designSystemId = run.DesignDirection?.DesignSystemId,
        promptFingerprint = run.DesignDirection?.PromptFingerprint,
        reviewMode = run.DesignDirection?.ReviewMode,
        designBrief = run.DesignBrief == null ? null : new
        {
            run.DesignBrief.SchemaVersion,
            run.DesignBrief.Version,
            run.DesignBrief.Fingerprint,
            run.DesignBrief.BrandKitRef,
            run.DesignBrief.BrandKitVersion,
        },
        brandPackage = run.BrandPackage == null ? null : new
        {
            run.BrandPackage.SchemaVersion,
            run.BrandPackage.Version,
            run.BrandPackage.Ref,
            run.BrandPackage.Source,
            run.BrandPackage.DesignSystemId,
            run.BrandPackage.Fingerprint,
        },
        designContextProvenance = run.DesignContextProvenance == null ? null : new
        {
            run.DesignContextProvenance.SchemaVersion,
            run.DesignContextProvenance.Version,
            run.DesignContextProvenance.Source,
            run.DesignContextProvenance.SourceRunId,
            run.DesignContextProvenance.SourceRevisionId,
            run.DesignContextProvenance.ParentDesignBriefFingerprint,
            run.DesignContextProvenance.ParentBrandPackageFingerprint,
        },
        uploadedSources = run.UploadedSources?.Select(x => new { x.AttachmentId, x.FileName, x.ContentHash }),
        run.Title,
        run.Progress,
        run.PhaseCode,
        run.Phase,
        run.FirstVisibleFeedbackAt,
        run.FirstPreviewAt,
        run.LastProgressAt,
        run.ArtifactSiteId,
        run.ArtifactRevisionId,
        run.ProducedArtifactSiteId,
        run.ProducedArtifactRevisionId,
        // 目标空间与它应用失败的原因。前端据此提示「已生成，但归属团队失败」——
        // 建站成功、归属失败是一种部分成功，不许它长得跟完全成功一样。
        run.DestinationTeamId,
        run.DestinationApplyError,
        run.LinkedRunId,
        run.RestartedFromRunId,
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

    private static bool IsRestartableInterrupted(DesignArtifactRun run) =>
        run.Runtime == DesignArtifactRuntimes.OpenDesign
        && run.Status == RunStatuses.Error
        && (run.PhaseCode == DesignArtifactPhaseCodes.Interrupted
            || run.LifecycleFailureCode == WebPageDesignArtifactLifecycleAdapter.InterruptedFailureCode
            || string.Equals(run.Error, HostedSiteEditRunWorker.RestartInterruptedMessage, StringComparison.Ordinal));

    private static DesignArtifactRun CloneForRestart(
        DesignArtifactRun source,
        DesignArtifactProviderCapability capability,
        string runId,
        string keyHash,
        DateTime now) => new()
    {
        Id = runId,
        DeploymentSlug = DeploymentScope.Current,
        UserId = source.UserId,
        Status = RunStatuses.Queued,
        ArtifactType = source.ArtifactType,
        Operation = source.Operation,
        SourceSurface = source.SourceSurface,
        Runtime = DesignArtifactRuntimes.OpenDesign,
        DestinationTeamId = source.DestinationTeamId,
        RuntimeConnectionId = capability.ConnectionId,
        Instruction = source.Instruction,
        InputAuthority = source.InputAuthority,
        UserSuppliedContentHash = source.UserSuppliedContentHash,
        Title = source.Title,
        TargetSiteId = source.TargetSiteId,
        LinkedRunId = source.Id,
        RestartedFromRunId = source.Id,
        RestartIdempotencyKeyHash = keyHash,
        LlmRequestPolicy = source.LlmRequestPolicy,
        KnowledgeReferences = source.KnowledgeReferences,
        KnowledgeOriginals = source.KnowledgeOriginals,
        DesignDirection = source.DesignDirection,
        DesignBrief = source.DesignBrief,
        BrandPackage = source.BrandPackage,
        DesignContextProvenance = source.DesignContextProvenance,
        UploadedSources = source.UploadedSources,
        ReferenceImages = source.ReferenceImages,
        Progress = 2,
        PhaseCode = DesignArtifactPhaseCodes.Queued,
        Phase = source.Operation == DesignArtifactOperations.Edit
            ? "已用上次冻结的要求重新创建修改任务"
            : "已用上次冻结的资料与要求重新创建生成任务",
        FirstVisibleFeedbackAt = now,
        LastProgressAt = now,
        CreatedAt = now,
        UpdatedAt = now,
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
        record.PhaseCode,
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

public sealed class RestartDesignArtifactRunRequest
{
    public string? IdempotencyKey { get; set; }
}

public sealed class CreateDesignArtifactRunRequest
{
    public string? ArtifactType { get; set; }
    public string? SourceSurface { get; set; }
    public string? Runtime { get; set; }
    public string? Instruction { get; set; }
    public string? Title { get; set; }

    /// <summary>
    /// 目标团队空间。在请求这一刻冻结，由服务端建站时应用——不要再依赖浏览器的完成回调，
    /// 那条路在用户关掉页面时就断了，站点会静默留在个人空间。
    /// </summary>
    public string? DestinationTeamId { get; set; }

    public List<DesignKnowledgeReferenceRequest>? KnowledgeReferences { get; set; }

    /// <summary>
    /// 风格预设编号；为空取网页生成设置里的默认风格。「我的风格」写作 <c>personal:&lt;id&gt;</c>，
    /// 服务端按编号 + 当前用户取出风格正文，别人的编号与不存在一样被拒。
    /// </summary>
    public string? StyleId { get; set; }

    /// <summary>
    /// 直接选用 OpenDesign 目录里的一套设计系统（风格画廊「更多风格」）；与 StyleId 二选一。
    /// 按服务端快照核对，不在目录里的编号拒绝。
    /// </summary>
    public string? DesignSystemId { get; set; }

    /// <summary>直接上传的文件（附件编号，最多 5 个）；与知识库引用至少有一种。</summary>
    public List<string>? AttachmentIds { get; set; }

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
    string? PhaseCode,
    int? Progress,
    DateTime OccurredAt,
    bool Authoritative);
