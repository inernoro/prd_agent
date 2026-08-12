using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Security;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 视频 Agent：文章转教程视频（交互式分镜编辑）
/// 流程：文章输入 → 分镜生成(LLM) → 分镜编辑(用户可逐条编辑/重试) → 导出渲染(Remotion)
/// 遵循应用身份隔离原则，hardcode appKey = "video-agent"
/// </summary>
[ApiController]
[Route("api/video-agent")]
[Authorize]
[AdminController("video-agent", AdminPermissionCatalog.VideoAgentUse)]
public class VideoAgentController : ControllerBase
{
    private readonly IVideoGenService _videoGenService;
    private readonly IRunEventStore _runStore;
    private readonly MongoDbContext _db;
    private readonly IModelPoolQueryService _modelPoolQuery;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<VideoAgentController> _logger;
    private readonly IDataProtector _directVideoJobProtector;

    private const string AppKey = "video-agent";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public VideoAgentController(
        IVideoGenService videoGenService,
        IRunEventStore runStore,
        MongoDbContext db,
        IModelPoolQueryService modelPoolQuery,
        IOpenRouterVideoClient videoClient,
        ILLMRequestContextAccessor llmRequestContext,
        IAssetStorage assetStorage,
        IDataProtectionProvider dataProtectionProvider,
        ILogger<VideoAgentController> logger)
    {
        _videoGenService = videoGenService;
        _runStore = runStore;
        _db = db;
        _modelPoolQuery = modelPoolQuery;
        _videoClient = videoClient;
        _llmRequestContext = llmRequestContext;
        _assetStorage = assetStorage;
        _logger = logger;
        _directVideoJobProtector = dataProtectionProvider.CreateProtector(
            "PrdAgent.VideoAgent.DirectJobOwnership.v1");
    }

    private readonly IOpenRouterVideoClient _videoClient;

    private string GetAdminId() => this.GetRequiredUserId();

    [HttpGet("models")]
    public async Task<IActionResult> ListVideoModels(CancellationToken ct)
    {
        var pools = await _modelPoolQuery.GetModelPoolsAsync(
            AppCallerRegistry.VideoAgent.VideoGen.Generate,
            ModelTypes.VideoGen,
            ct);
        var poolItems = pools.SelectMany(pool => pool.Models)
            .OrderBy(item => item.Priority)
            .GroupBy(item => item.ModelId, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .ToList();
        if (poolItems.Count == 0)
            return Ok(ApiResponse<List<VideoModelOption>>.Ok([]));

        var modelIds = poolItems.Select(item => item.ModelId).ToList();
        var models = await _db.LLMModels.Find(model =>
                modelIds.Contains(model.Id) || modelIds.Contains(model.ModelName))
            .ToListAsync(ct);
        var groupIds = pools.Select(pool => pool.Id).ToList();
        var groups = await _db.ModelGroups.Find(group => groupIds.Contains(group.Id)).ToListAsync(ct);

        var result = poolItems.Select(item =>
        {
            var config = models.FirstOrDefault(model =>
                string.Equals(model.Id, item.ModelId, StringComparison.OrdinalIgnoreCase) ||
                string.Equals(model.ModelName, item.ModelId, StringComparison.OrdinalIgnoreCase));
            var pricing = groups.SelectMany(group => group.Models)
                .FirstOrDefault(model => string.Equals(model.ModelId, item.ModelId, StringComparison.OrdinalIgnoreCase));
            return BuildVideoModelOption(item.ModelId, config?.ModelName, config?.Name, item.HealthStatus, pricing);
        }).ToList();

        return Ok(ApiResponse<List<VideoModelOption>>.Ok(result));
    }

    private static VideoModelOption BuildVideoModelOption(
        string id,
        string? providerModelName,
        string? displayName,
        string healthStatus,
        ModelGroupItem? pricing)
    {
        var key = $"{id} {providerModelName}".ToLowerInvariant();
        var isSeedance20 = key.Contains("seedance-2");
        var isSeedance15 = key.Contains("seedance-1-5") || key.Contains("seedance-1.5");
        var isSeedance = key.Contains("seedance");
        var isWan = key.Contains("wan-") || key.Contains("wan2");
        var isVeo = key.Contains("veo-3");
        return new VideoModelOption
        {
            Id = id,
            Name = string.IsNullOrWhiteSpace(displayName) ? id : displayName,
            HealthStatus = healthStatus,
            SupportsAudio = isSeedance15 || isSeedance20 || isVeo,
            SupportsFirstFrame = true,
            SupportsLastFrame = isSeedance || isWan,
            SupportsReferenceAssets = isSeedance20,
            AspectRatios = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
            Resolutions = isSeedance || isWan || isVeo ? ["720p", "1080p"] : ["720p"],
            Durations = VideoModelCapabilities.GetSupportedDurations(key).ToList(),
            PricePerCall = pricing?.PricePerCall,
            PriceCurrency = pricing?.PriceCurrency,
        };
    }

    [HttpGet("projects")]
    public async Task<IActionResult> ListProjects(CancellationToken ct)
    {
        var projects = await _videoGenService.ListProjectsAsync(GetAdminId(), AppKey, ct);
        return Ok(ApiResponse<List<VideoProject>>.Ok(projects));
    }

    [HttpPost("projects")]
    public async Task<IActionResult> CreateProject([FromBody] CreateVideoProjectRequest request, CancellationToken ct)
    {
        var project = await _videoGenService.CreateProjectAsync(AppKey, GetAdminId(), request, ct);
        return Ok(ApiResponse<VideoProject>.Ok(project));
    }

    [HttpGet("projects/{projectId}")]
    public async Task<IActionResult> GetProject(string projectId, CancellationToken ct)
    {
        var project = await _videoGenService.GetProjectAsync(projectId, GetAdminId(), AppKey, ct);
        return project == null
            ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "视频项目不存在"))
            : Ok(ApiResponse<VideoProject>.Ok(project));
    }

    [HttpPut("projects/{projectId}")]
    public async Task<IActionResult> UpdateProject(
        string projectId,
        [FromBody] UpdateVideoProjectRequest request,
        CancellationToken ct)
    {
        try
        {
            var project = await _videoGenService.UpdateProjectAsync(projectId, GetAdminId(), request, AppKey, ct);
            return Ok(ApiResponse<VideoProject>.Ok(project));
        }
        catch (KeyNotFoundException ex)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, ex.Message));
        }
    }

    [HttpGet("projects/{projectId}/exports")]
    public async Task<IActionResult> ListProjectExports(string projectId, CancellationToken ct)
    {
        var project = await _videoGenService.GetProjectAsync(projectId, GetAdminId(), AppKey, ct);
        if (project == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "视频项目不存在"));
        var tasks = await _videoGenService.ListExportTasksAsync(projectId, GetAdminId(), AppKey, ct);
        return Ok(ApiResponse<List<VideoExportTask>>.Ok(tasks));
    }

    /// <summary>
    /// 直出视频（绕过 Worker，直接同步走 Gateway + OpenRouter）
    /// 用于诊断 Worker 热重载问题时的快速验证通道。
    /// 返回 jobId，客户端自行轮询 /videogen-direct/status/:jobId
    /// </summary>
    [HttpPost("videogen-direct")]
    public async Task<IActionResult> VideoGenDirect([FromBody] VideoGenDirectRequest req, CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Prompt))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "prompt 不能为空"));

        var result = await _videoClient.SubmitAsync(new OpenRouterVideoSubmitRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.VideoGen.Generate,
            Model = req.Model,
            Prompt = req.Prompt,
            AspectRatio = req.AspectRatio ?? "16:9",
            Resolution = req.Resolution ?? "720p",
            DurationSeconds = req.DurationSeconds ?? 5,
            GenerateAudio = req.GenerateAudio ?? true,
            UserId = GetAdminId()
        }, ct);

        if (result.Success && !string.IsNullOrWhiteSpace(result.JobId))
        {
            var now = DateTime.UtcNow;
            var ownership = new DirectVideoJobOwnership
            {
                AppKey = AppKey,
                OwnerAdminId = GetAdminId(),
                JobId = result.JobId,
                Model = result.ActualModel ?? req.Model,
                OfferingId = result.OfferingId,
                CreatedAt = now,
                ExpiresAt = now.Add(DirectVideoJobOwnership.Retention),
            };
            var recoveryToken = CreateDirectVideoJobRecoveryToken(ownership);
            var ownershipPersisted = await TryPersistDirectVideoJobOwnershipAsync(ownership);
            return Ok(ApiResponse<object>.Ok(new
            {
                result.Success,
                result.JobId,
                result.ActualModel,
                result.Cost,
                result.ErrorMessage,
                RecoveryToken = recoveryToken,
                OwnershipPersisted = ownershipPersisted,
            }));
        }

        return Ok(ApiResponse<object>.Ok(new { result.Success, result.JobId, result.ActualModel, result.Cost, result.ErrorMessage }));
    }

    [HttpGet("videogen-direct/status/{jobId}")]
    public async Task<IActionResult> VideoGenDirectStatus(
        string jobId,
        [FromQuery] string? recoveryToken,
        CancellationToken ct)
    {
        var ownership = await FindOwnedDirectVideoJobAsync(jobId, recoveryToken);
        if (ownership == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "视频任务不存在或不可访问，请从本人的任务记录重新打开"));

        var status = string.IsNullOrWhiteSpace(ownership.OfferingId)
            ? await _videoClient.GetStatusAsync(
                AppCallerRegistry.VideoAgent.VideoGen.Generate,
                jobId,
                ownership.Model,
                ct)
            : await _videoClient.GetStatusForOfferingAsync(
                AppCallerRegistry.VideoAgent.VideoGen.Generate,
                jobId,
                ownership.Model,
                ownership.OfferingId,
                ct);
        return Ok(ApiResponse<object>.Ok(new { status.Status, status.VideoUrl, status.Cost, status.ErrorMessage, status.IsCompleted, status.IsFailed }));
    }

    [HttpGet("videogen-direct/content/{jobId}")]
    public async Task<IActionResult> DownloadDirectVideo(
        string jobId,
        [FromQuery] string? recoveryToken,
        CancellationToken ct)
    {
        var ownership = await FindOwnedDirectVideoJobAsync(jobId, recoveryToken);
        if (ownership == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "视频任务不存在或不可访问，请从本人的任务记录重新打开"));

        var downloaded = string.IsNullOrWhiteSpace(ownership.OfferingId)
            ? await _videoClient.DownloadVideoBytesAsync(
                AppCallerRegistry.VideoAgent.VideoGen.Generate,
                jobId,
                expectedModel: ownership.Model,
                ct: ct)
            : await _videoClient.DownloadVideoBytesForOfferingAsync(
                AppCallerRegistry.VideoAgent.VideoGen.Generate,
                jobId,
                0,
                ownership.Model,
                ownership.OfferingId,
                ct);
        if (!downloaded.Success || downloaded.Bytes == null || downloaded.Bytes.Length == 0)
        {
            _logger.LogWarning(
                "直出视频下载失败 jobId={JobId} model={Model} reason={Reason}",
                jobId,
                ownership.Model,
                downloaded.ErrorMessage);
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.LLM_ERROR,
                "视频已经生成，但暂时无法下载，请稍后重试或切换模型"));
        }

        return File(
            downloaded.Bytes,
            downloaded.ContentType ?? "video/mp4",
            $"video-{jobId}.mp4");
    }

    [HttpDelete("videogen-direct/{jobId}")]
    public async Task<IActionResult> DeleteDirectVideoJob(
        string jobId,
        [FromQuery] string? recoveryToken,
        CancellationToken ct)
    {
        var ownerAdminId = GetAdminId();
        DirectVideoJobOwnership? ownership;
        try
        {
            ownership = await _db.DirectVideoJobOwnerships
                .Find(item => item.AppKey == AppKey
                              && item.JobId == jobId
                              && item.OwnerAdminId == ownerAdminId)
                .FirstOrDefaultAsync(ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "直出视频清理前无法读取归属记录 jobId={JobId}", jobId);
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "视频任务暂时无法清理，请稍后重试"));
        }

        if (ownership == null
            && !TryReadDirectVideoJobRecoveryToken(recoveryToken, jobId, ownerAdminId, out ownership))
        {
            // 不存在且没有本人有效恢复凭证时保持幂等，不为无法证明归属的任务创建墓碑。
            return Ok(ApiResponse<object>.Ok(new { cleaned = true }));
        }

        var revokedAt = DateTime.UtcNow;
        var tombstoneExpiresAt = ownership.ExpiresAt > revokedAt
            ? ownership.ExpiresAt
            : revokedAt.Add(DirectVideoJobOwnership.Retention);
        try
        {
            var update = Builders<DirectVideoJobOwnership>.Update
                .Set(item => item.RevokedAt, revokedAt)
                .Set(item => item.ExpiresAt, tombstoneExpiresAt)
                .SetOnInsert(item => item.Id, ownership.Id)
                .SetOnInsert(item => item.AppKey, ownership.AppKey)
                .SetOnInsert(item => item.OwnerAdminId, ownership.OwnerAdminId)
                .SetOnInsert(item => item.JobId, ownership.JobId)
                .SetOnInsert(item => item.Model, ownership.Model)
                .SetOnInsert(item => item.OfferingId, ownership.OfferingId)
                .SetOnInsert(item => item.CreatedAt, ownership.CreatedAt);
            await _db.DirectVideoJobOwnerships.UpdateOneAsync(
                item => item.AppKey == AppKey
                        && item.JobId == jobId
                        && item.OwnerAdminId == ownerAdminId,
                update,
                new UpdateOptions { IsUpsert = true },
                ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "直出视频清理撤销凭证失败 jobId={JobId}", jobId);
            return StatusCode(StatusCodes.Status503ServiceUnavailable,
                ApiResponse<object>.Fail(ErrorCodes.INTERNAL_ERROR, "视频任务暂时无法清理，请稍后重试"));
        }

        // 撤销墓碑保留到恢复凭证过期，重复清理仍然安全成功。
        return Ok(ApiResponse<object>.Ok(new { cleaned = true }));
    }

    private async Task<DirectVideoJobOwnership?> FindOwnedDirectVideoJobAsync(
        string jobId,
        string? recoveryToken)
    {
        if (string.IsNullOrWhiteSpace(jobId)) return null;
        var ownerAdminId = GetAdminId();
        try
        {
            var persisted = await _db.DirectVideoJobOwnerships
                .Find(item => item.JobId == jobId && item.OwnerAdminId == ownerAdminId && item.AppKey == AppKey)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (persisted != null) return persisted.RevokedAt.HasValue ? null : persisted;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "直出视频归属读取失败，无法安全确认恢复凭证是否已撤销 jobId={JobId}", jobId);
            return null;
        }

        if (!TryReadDirectVideoJobRecoveryToken(recoveryToken, jobId, ownerAdminId, out var recovered))
            return null;

        var ownershipRestored = await TryPersistDirectVideoJobOwnershipAsync(recovered);
        return ownershipRestored ? recovered : null;
    }

    private async Task<bool> TryPersistDirectVideoJobOwnershipAsync(DirectVideoJobOwnership ownership)
    {
        try
        {
            var update = Builders<DirectVideoJobOwnership>.Update
                .Set(item => item.Model, ownership.Model)
                .Set(item => item.OfferingId, ownership.OfferingId)
                .Set(item => item.ExpiresAt, ownership.ExpiresAt)
                .SetOnInsert(item => item.Id, ownership.Id)
                .SetOnInsert(item => item.AppKey, ownership.AppKey)
                .SetOnInsert(item => item.OwnerAdminId, ownership.OwnerAdminId)
                .SetOnInsert(item => item.JobId, ownership.JobId)
                .SetOnInsert(item => item.CreatedAt, ownership.CreatedAt);
            await _db.DirectVideoJobOwnerships.UpdateOneAsync(
                item => item.AppKey == ownership.AppKey
                        && item.JobId == ownership.JobId
                        && item.OwnerAdminId == ownership.OwnerAdminId
                        && item.RevokedAt == null,
                update,
                new UpdateOptions { IsUpsert = true },
                CancellationToken.None);
            return true;
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            _logger.LogWarning(
                "直出视频恢复凭证已被撤销，拒绝重建归属记录 jobId={JobId}",
                ownership.JobId);
            return false;
        }
        catch (Exception ex)
        {
            _logger.LogError(
                ex,
                "直出视频已由上游受理，但归属记录暂未写入；客户端可用签名凭证恢复 jobId={JobId}",
                ownership.JobId);
            return false;
        }
    }

    private string CreateDirectVideoJobRecoveryToken(DirectVideoJobOwnership ownership)
    {
        var payload = new DirectVideoJobRecoveryPayload(
            ownership.AppKey,
            ownership.OwnerAdminId,
            ownership.JobId,
            ownership.Model,
            ownership.OfferingId,
            ownership.ExpiresAt);
        return _directVideoJobProtector.Protect(JsonSerializer.Serialize(payload, JsonOptions));
    }

    private bool TryReadDirectVideoJobRecoveryToken(
        string? recoveryToken,
        string jobId,
        string ownerAdminId,
        out DirectVideoJobOwnership ownership)
    {
        ownership = null!;
        if (string.IsNullOrWhiteSpace(recoveryToken)) return false;
        try
        {
            var payload = JsonSerializer.Deserialize<DirectVideoJobRecoveryPayload>(
                _directVideoJobProtector.Unprotect(recoveryToken),
                JsonOptions);
            if (payload == null
                || payload.ExpiresAt <= DateTime.UtcNow
                || !string.Equals(payload.AppKey, AppKey, StringComparison.Ordinal)
                || !string.Equals(payload.OwnerAdminId, ownerAdminId, StringComparison.Ordinal)
                || !string.Equals(payload.JobId, jobId, StringComparison.Ordinal))
            {
                return false;
            }

            ownership = new DirectVideoJobOwnership
            {
                AppKey = payload.AppKey,
                OwnerAdminId = payload.OwnerAdminId,
                JobId = payload.JobId,
                Model = payload.Model,
                OfferingId = payload.OfferingId,
                CreatedAt = DateTime.UtcNow,
                ExpiresAt = payload.ExpiresAt,
            };
            return true;
        }
        catch
        {
            return false;
        }
    }

    private sealed record DirectVideoJobRecoveryPayload(
        string AppKey,
        string OwnerAdminId,
        string JobId,
        string? Model,
        string? OfferingId,
        DateTime ExpiresAt);

    /// <summary>
    /// 创建视频生成任务（仅保存输入，Worker 自动开始分镜生成）
    /// </summary>
    [HttpPost("runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> CreateRun([FromBody] CreateVideoGenRunRequest request, CancellationToken ct)
    {
        try
        {
            var runId = await _videoGenService.CreateRunAsync(AppKey, GetAdminId(), request, ct);
            return Ok(ApiResponse<object>.Ok(new { runId }));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 列出当前用户的视频生成任务
    /// </summary>
    [HttpGet("runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListRuns([FromQuery] int limit = 20, [FromQuery] int skip = 0, CancellationToken ct = default)
    {
        var (total, items) = await _videoGenService.ListRunsAsync(GetAdminId(), appKey: null, limit, skip, ct);

        var lite = items.Select(r => new
        {
            r.Id,
            r.Status,
            r.Mode,
            r.ArticleTitle,
            r.CurrentPhase,
            r.PhaseProgress,
            r.TotalDurationSeconds,
            r.VideoAssetUrl,
            r.CreatedAt,
            r.StartedAt,
            r.EndedAt,
            r.ErrorMessage,
            r.ExportErrorMessage,
            ScenesCount = r.Scenes.Count,
            ScenesReady = r.Scenes.Count(scene => scene.Status == SceneItemStatus.Done && !string.IsNullOrWhiteSpace(scene.VideoUrl)),
            HasActiveScenes = r.Scenes.Any(scene => scene.Status is SceneItemStatus.Generating or SceneItemStatus.Submitting or SceneItemStatus.SubmittingClaimed or SceneItemStatus.Polling or SceneItemStatus.PollingClaimed or SceneItemStatus.Rendering),
        });

        return Ok(ApiResponse<object>.Ok(new { total, items = lite }));
    }

    /// <summary>
    /// 获取视频生成任务详情
    /// </summary>
    [HttpGet("runs/{runId}")]
    [ProducesResponseType(typeof(ApiResponse<VideoGenRun>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetRun(string runId, CancellationToken ct)
    {
        var run = await _videoGenService.GetRunAsync(runId, GetAdminId(), ct: ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        return Ok(ApiResponse<VideoGenRun>.Ok(run));
    }

    /// <summary>
    /// 下载当前用户已完成的视频产物。
    /// 通过受鉴权的业务端点返回稳定文件名，避免前端直接打开对象存储链接。
    /// </summary>
    [HttpGet("runs/{runId}/download")]
    [Produces("video/mp4")]
    [ProducesResponseType(typeof(FileContentResult), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> DownloadRun(string runId, CancellationToken ct)
    {
        var run = await _videoGenService.GetRunAsync(runId, GetAdminId(), ct: ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        if (run.Status != VideoGenRunStatus.Completed || string.IsNullOrWhiteSpace(run.VideoAssetSha256))
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.INVALID_FORMAT,
                "视频尚未生成完成，请等待完成后再下载"));
        }

        var asset = await _assetStorage.TryReadByShaAsync(
            run.VideoAssetSha256,
            ct,
            domain: AppDomainPaths.DomainVideoAgent,
            type: AppDomainPaths.TypeVideo);
        if (asset == null || asset.Value.bytes.Length == 0)
        {
            return NotFound(ApiResponse<object>.Fail(
                ErrorCodes.NOT_FOUND,
                "视频文件暂时不可用，请重新生成后再下载"));
        }

        return File(asset.Value.bytes, "video/mp4", $"video-{run.Id}.mp4");
    }


    // ─── Storyboard 模式（高级创作）：分镜编辑 / 重新设计 / 单镜渲染 ───

    /// <summary>更新分镜内容（topic/prompt/model/duration 等，仅 Editing 阶段）</summary>
    [HttpPut("runs/{runId}/scenes/{sceneIndex:int}")]
    public async Task<IActionResult> UpdateScene(string runId, int sceneIndex, [FromBody] UpdateVideoSceneRequest request, CancellationToken ct)
    {
        try
        {
            await _videoGenService.UpdateSceneAsync(runId, GetAdminId(), sceneIndex, request, ct: ct);
            return Ok(ApiResponse<object>.Ok(true));
        }
        catch (KeyNotFoundException) { return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在")); }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentOutOfRangeException)
        { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
    }

    /// <summary>LLM 重新生成分镜 prompt（标记 Generating，由 worker 处理）</summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/regenerate")]
    public async Task<IActionResult> RegenerateScene(string runId, int sceneIndex, CancellationToken ct)
    {
        try
        {
            await _videoGenService.RegenerateSceneAsync(runId, GetAdminId(), sceneIndex, ct: ct);
            return Ok(ApiResponse<object>.Ok(true));
        }
        catch (KeyNotFoundException) { return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在")); }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentOutOfRangeException)
        { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
    }

    /// <summary>触发分镜视频渲染（进入提交队列，由 worker 调 OpenRouter）</summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/render")]
    public async Task<IActionResult> RenderScene(string runId, int sceneIndex, CancellationToken ct)
    {
        try
        {
            await _videoGenService.RenderSceneAsync(runId, GetAdminId(), sceneIndex, ct: ct);
            return Ok(ApiResponse<object>.Ok(true));
        }
        catch (KeyNotFoundException) { return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在")); }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentOutOfRangeException)
        { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
    }

    /// <summary>批量触发未完成分镜渲染，由 worker 原子领取处理</summary>
    [HttpPost("runs/{runId}/scenes/render-batch")]
    public async Task<IActionResult> RenderScenes(
        string runId,
        [FromBody] BatchRenderVideoScenesRequest? request,
        CancellationToken ct)
    {
        try
        {
            var count = await _videoGenService.RenderScenesAsync(
                runId, GetAdminId(), request?.SceneIndexes, ct: ct);
            return Ok(ApiResponse<object>.Ok(new { count }));
        }
        catch (KeyNotFoundException) { return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在")); }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentOutOfRangeException)
        { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
    }

    [HttpPost("runs/{runId}/scenes/reorder")]
    public async Task<IActionResult> ReorderScenes(
        string runId,
        [FromBody] ReorderVideoScenesRequest request,
        CancellationToken ct)
    {
        try
        {
            await _videoGenService.ReorderScenesAsync(runId, GetAdminId(), request.SceneIndexes, ct: ct);
            return Ok(ApiResponse<object>.Ok(true));
        }
        catch (KeyNotFoundException ex) { return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, ex.Message)); }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentException)
        { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
    }

    /// <summary>选择一个历史生成版本作为当前分镜产物</summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/versions/{versionId}/activate")]
    public async Task<IActionResult> ActivateSceneVersion(
        string runId,
        int sceneIndex,
        string versionId,
        CancellationToken ct)
    {
        try
        {
            await _videoGenService.ActivateSceneVersionAsync(
                runId, GetAdminId(), sceneIndex, versionId, ct: ct);
            return Ok(ApiResponse<object>.Ok(true));
        }
        catch (KeyNotFoundException ex) { return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, ex.Message)); }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentOutOfRangeException)
        { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
    }

    /// <summary>把全部已完成分镜合成为完整 MP4</summary>
    [HttpPost("runs/{runId}/export")]
    public async Task<IActionResult> ExportRun(string runId, CancellationToken ct)
    {
        try
        {
            var task = await _videoGenService.RequestExportAsync(runId, GetAdminId(), ct: ct);
            return Ok(ApiResponse<VideoExportTask>.Ok(task));
        }
        catch (KeyNotFoundException) { return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在")); }
        catch (InvalidOperationException ex)
        { return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message)); }
    }

    /// <summary>
    /// SSE 流式获取任务事件
    /// </summary>
    [HttpGet("runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamRun(string runId, [FromQuery] int? afterSeq, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        // 禁用 ASP.NET Core 响应缓冲，确保 SSE 即时推送
        var bodyFeature = HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>();
        bodyFeature?.DisableBuffering();

        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();

        var run = await _videoGenService.GetRunAsync(runId, adminId, ct: cancellationToken);
        if (run == null)
        {
            await WriteEventAsync(null, "error",
                JsonSerializer.Serialize(new { code = ErrorCodes.NOT_FOUND, message = "任务不存在" }, JsonOptions),
                cancellationToken);
            return;
        }

        await WriteEventAsync(null, "heartbeat", JsonSerializer.Serialize(new
        {
            serverTime = DateTime.UtcNow,
            status = run.Status,
            phase = run.CurrentPhase,
            progress = run.PhaseProgress,
        }, JsonOptions), cancellationToken);

        long lastSeq = afterSeq ?? 0;
        var lastHeartbeatAt = DateTime.UtcNow;

        while (!cancellationToken.IsCancellationRequested)
        {
            var events = await _runStore.GetEventsAsync(RunKinds.VideoGen, runId, lastSeq, limit: 100, cancellationToken);
            if (events.Count > 0)
            {
                foreach (var ev in events)
                {
                    await WriteEventAsync(ev.Seq.ToString(), ev.EventName, ev.PayloadJson, cancellationToken);
                    lastSeq = ev.Seq;
                }
            }
            else
            {
                run = await _videoGenService.GetRunAsync(runId, adminId, ct: cancellationToken);
                if (run == null) break;
                if ((DateTime.UtcNow - lastHeartbeatAt).TotalSeconds >= 2)
                {
                    await WriteEventAsync(null, "heartbeat", JsonSerializer.Serialize(new
                    {
                        serverTime = DateTime.UtcNow,
                        status = run.Status,
                        phase = run.CurrentPhase,
                        progress = run.PhaseProgress,
                    }, JsonOptions), cancellationToken);
                    lastHeartbeatAt = DateTime.UtcNow;
                }
                if (run.Status is VideoGenRunStatus.Completed or VideoGenRunStatus.Failed or VideoGenRunStatus.Cancelled)
                {
                    break;
                }

                await Task.Delay(650, cancellationToken);
            }
        }
    }

    /// <summary>
    /// 取消视频生成任务
    /// </summary>
    [HttpPost("runs/{runId}/cancel")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> CancelRun(string runId, CancellationToken ct)
    {
        var found = await _videoGenService.CancelRunAsync(runId, GetAdminId(), ct: ct);
        if (!found)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        return Ok(ApiResponse<object>.Ok(true));
    }

    /// <summary>删除当前用户的终态视频任务及其独占生成产物。</summary>
    [HttpDelete("runs/{runId}")]
    public async Task<IActionResult> DeleteRun(
        string runId,
        [FromQuery] bool deleteEmptyProject = false,
        CancellationToken ct = default)
    {
        try
        {
            var result = await _videoGenService.DeleteRunAsync(
                runId,
                GetAdminId(),
                deleteEmptyProject,
                AppKey,
                ct);
            return result == null
                ? NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"))
                : Ok(ApiResponse<DeleteVideoGenRunResult>.Ok(result));
        }
        catch (InvalidOperationException ex) when (ex.Message.StartsWith("任务仍在生成", StringComparison.Ordinal))
        {
            return Conflict(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "视频任务清理失败: runId={RunId}", runId);
            return StatusCode(
                StatusCodes.Status503ServiceUnavailable,
                ApiResponse<object>.Fail(
                    "VIDEO_CLEANUP_FAILED",
                    "视频任务暂时未能全部清理，请稍后重试；系统会按当前任务记录继续补齐清理"));
        }
    }

    // 注：原 srt / narration / script 下载端点已移除——这些都是分镜流程产物。
    // 直出视频结果直接用 run.VideoAssetUrl 作为外链下载即可。

    // ═══════════════════════════════════════════════════════════
    // 视频转文档（Video-to-Doc）端点
    // ═══════════════════════════════════════════════════════════

    /// <summary>
    /// 创建视频转文档任务
    /// </summary>
    [HttpPost("v2d/runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> CreateV2dRun([FromBody] CreateVideoToDocRunRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();

        var videoUrl = (request?.VideoUrl ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(videoUrl))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "视频 URL 不能为空"));
        }

        if (!Uri.TryCreate(videoUrl, UriKind.Absolute, out _))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "视频 URL 格式无效"));
        }

        var run = new VideoToDocRun
        {
            OwnerAdminId = adminId,
            Status = VideoToDocRunStatus.Queued,
            VideoUrl = videoUrl,
            VideoTitle = request?.VideoTitle?.Trim(),
            SystemPrompt = request?.SystemPrompt?.Trim(),
            Language = (request?.Language ?? "auto").Trim(),
            ForceFullShadowSample = _llmRequestContext.Current?.ForceFullShadowSample == true,
            CreatedAt = DateTime.UtcNow
        };

        await _db.VideoToDocRuns.InsertOneAsync(run, cancellationToken: ct);

        _logger.LogInformation("VideoToDoc Run 已创建: runId={RunId}, videoUrl={Url}",
            run.Id, videoUrl);

        return Ok(ApiResponse<object>.Ok(new { runId = run.Id }));
    }

    /// <summary>
    /// 列出当前用户的视频转文档任务
    /// </summary>
    [HttpGet("v2d/runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListV2dRuns([FromQuery] int limit = 20, [FromQuery] int skip = 0, CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        limit = Math.Clamp(limit, 1, 50);
        skip = Math.Max(skip, 0);

        var filter = Builders<VideoToDocRun>.Filter.Eq(x => x.OwnerAdminId, adminId);
        var sort = Builders<VideoToDocRun>.Sort.Descending(x => x.CreatedAt);

        var total = await _db.VideoToDocRuns.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.VideoToDocRuns.Find(filter).Sort(sort).Skip(skip).Limit(limit).ToListAsync(ct);

        var lite = items.Select(r => new
        {
            r.Id,
            r.Status,
            r.VideoTitle,
            r.VideoUrl,
            r.CurrentPhase,
            r.PhaseProgress,
            r.DurationSeconds,
            r.KeyFrameCount,
            r.DetectedLanguage,
            r.CreatedAt,
            r.StartedAt,
            r.EndedAt,
            r.ErrorMessage,
            HasDocument = !string.IsNullOrEmpty(r.OutputMarkdown),
        });

        return Ok(ApiResponse<object>.Ok(new { total, items = lite }));
    }

    /// <summary>
    /// 获取视频转文档任务详情
    /// </summary>
    [HttpGet("v2d/runs/{runId}")]
    [ProducesResponseType(typeof(ApiResponse<VideoToDocRun>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetV2dRun(string runId, CancellationToken ct)
    {
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();

        var run = await _db.VideoToDocRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
            .FirstOrDefaultAsync(ct);

        if (run == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }

        return Ok(ApiResponse<VideoToDocRun>.Ok(run));
    }

    /// <summary>
    /// 下载视频转文档产出物
    /// </summary>
    [HttpGet("v2d/runs/{runId}/download/{type}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> DownloadV2d(string runId, string type, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var run = await _db.VideoToDocRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
            .FirstOrDefaultAsync(ct);

        if (run == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }

        if (run.Status != VideoToDocRunStatus.Completed)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务尚未完成"));
        }

        return type.ToLowerInvariant() switch
        {
            "markdown" => Content(run.OutputMarkdown ?? string.Empty, "text/markdown; charset=utf-8", System.Text.Encoding.UTF8),
            "transcript" => Content(run.PlainTranscript ?? string.Empty, "text/plain; charset=utf-8", System.Text.Encoding.UTF8),
            _ => BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的下载类型，可选: markdown, transcript")),
        };
    }

    /// <summary>
    /// SSE 流式获取视频转文档任务事件
    /// </summary>
    [HttpGet("v2d/runs/{runId}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamV2dRun(string runId, [FromQuery] int? afterSeq, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";
        Response.Headers["X-Accel-Buffering"] = "no";

        var bodyFeature = HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>();
        bodyFeature?.DisableBuffering();

        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();

        var run = await _db.VideoToDocRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
            .FirstOrDefaultAsync(cancellationToken);

        if (run == null)
        {
            await WriteEventAsync(null, "error",
                JsonSerializer.Serialize(new { code = ErrorCodes.NOT_FOUND, message = "任务不存在" }, JsonOptions),
                cancellationToken);
            return;
        }

        await Response.WriteAsync(": connected\n\n", cancellationToken);
        await Response.Body.FlushAsync(cancellationToken);

        long lastSeq = afterSeq ?? 0;
        var lastKeepAliveAt = DateTime.UtcNow;

        while (!cancellationToken.IsCancellationRequested)
        {
            var events = await _runStore.GetEventsAsync(RunKinds.VideoToDoc, runId, lastSeq, limit: 100, cancellationToken);
            if (events.Count > 0)
            {
                foreach (var ev in events)
                {
                    await WriteEventAsync(ev.Seq.ToString(), ev.EventName, ev.PayloadJson, cancellationToken);
                    lastSeq = ev.Seq;
                }
                lastKeepAliveAt = DateTime.UtcNow;
            }
            else
            {
                if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 10)
                {
                    await Response.WriteAsync(": keepalive\n\n", cancellationToken);
                    await Response.Body.FlushAsync(cancellationToken);
                    lastKeepAliveAt = DateTime.UtcNow;
                }

                run = await _db.VideoToDocRuns
                    .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
                    .FirstOrDefaultAsync(cancellationToken);
                if (run == null) break;
                if (run.Status is VideoToDocRunStatus.Completed or VideoToDocRunStatus.Failed or VideoToDocRunStatus.Cancelled)
                {
                    if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 2) break;
                }

                await Task.Delay(650, cancellationToken);
            }
        }
    }

    /// <summary>
    /// 取消视频转文档任务
    /// </summary>
    [HttpPost("v2d/runs/{runId}/cancel")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> CancelV2dRun(string runId, CancellationToken ct)
    {
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();

        var res = await _db.VideoToDocRuns.UpdateOneAsync(
            x => x.Id == runId && x.OwnerAdminId == adminId,
            Builders<VideoToDocRun>.Update.Set(x => x.CancelRequested, true),
            cancellationToken: ct);

        if (res.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }

        return Ok(ApiResponse<object>.Ok(true));
    }

    // ─── Helpers ───

    private async Task WriteEventAsync(string? id, string eventName, string dataJson, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(id))
        {
            await Response.WriteAsync($"id: {id}\n", ct);
        }
        await Response.WriteAsync($"event: {eventName}\n", ct);
        await Response.WriteAsync($"data: {dataJson}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }
}

public class VideoGenDirectRequest
{
    public string Prompt { get; set; } = string.Empty;
    public string? Model { get; set; }
    public string? AspectRatio { get; set; }
    public string? Resolution { get; set; }
    public int? DurationSeconds { get; set; }
    public bool? GenerateAudio { get; set; }
}
