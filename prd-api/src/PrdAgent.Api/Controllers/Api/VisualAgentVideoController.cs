using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 视觉创作 · 视频生成（每日限额体验）
/// 复用 video_gen_runs 集合和 VideoGenRunWorker，通过 AppKey="visual-agent" 区分来源。
/// 遵循应用身份隔离原则，hardcode appKey = "visual-agent"
/// </summary>
[ApiController]
[Route("api/visual-agent/video-gen")]
[Authorize]
[AdminController("visual-agent", AdminPermissionCatalog.VisualAgentUse)]
public class VisualAgentVideoController : ControllerBase
{
    private readonly IVideoGenService _videoGenService;
    private readonly IRunEventStore _runStore;
    private readonly ILogger<VisualAgentVideoController> _logger;

    private const string AppKey = "visual-agent";
    private const int DailyLimit = 1;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public VisualAgentVideoController(
        IVideoGenService videoGenService,
        IRunEventStore runStore,
        ILogger<VisualAgentVideoController> logger)
    {
        _videoGenService = videoGenService;
        _runStore = runStore;
        _logger = logger;
    }

    private string GetAdminId() =>
        User.FindFirst("sub")?.Value
        ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? "unknown";

    // ─── 每日额度 ───

    /// <summary>
    /// 查询当前用户今日剩余视频生成额度
    /// </summary>
    [HttpGet("quota")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetQuota(CancellationToken ct)
    {
        var usedToday = await _videoGenService.CountTodayRunsAsync(GetAdminId(), AppKey, ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            dailyLimit = DailyLimit,
            usedToday,
            remaining = Math.Max(0, DailyLimit - usedToday),
        }));
    }

    /// <summary>
    /// 创建视频生成任务（含每日限额检查）
    /// </summary>
    [HttpPost("runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> CreateRun([FromBody] CreateVideoGenRunRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();

        // ── 每日限额检查 ──
        var usedToday = await _videoGenService.CountTodayRunsAsync(adminId, AppKey, ct);
        if (usedToday >= DailyLimit)
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.QUOTA_EXCEEDED,
                $"每日视频生成体验次数已达上限（{DailyLimit}次/天），明天再来试试吧"));
        }

        try
        {
            var runId = await _videoGenService.CreateRunAsync(AppKey, adminId, request, ct);

            _logger.LogInformation("VisualAgent VideoGen 已创建: runId={RunId}, todayUsed={Used}/{Limit}",
                runId, usedToday + 1, DailyLimit);

            return Ok(ApiResponse<object>.Ok(new { runId }));
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 列出当前用户通过视觉创作入口创建的视频任务
    /// </summary>
    [HttpGet("runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListRuns([FromQuery] int limit = 20, [FromQuery] int skip = 0, CancellationToken ct = default)
    {
        var (total, items) = await _videoGenService.ListRunsAsync(GetAdminId(), AppKey, limit, skip, ct);

        var lite = items.Select(r => new
        {
            r.Id,
            r.Status,
            r.ArticleTitle,
            r.CurrentPhase,
            r.PhaseProgress,
            r.TotalDurationSeconds,
            r.VideoAssetUrl,
            r.CreatedAt,
            r.StartedAt,
            r.EndedAt,
            r.ErrorMessage,
            ScenesCount = r.Scenes.Count,
            ScenesReady = r.Scenes.Count(s => s.Status == SceneItemStatus.Done),
        });

        return Ok(ApiResponse<object>.Ok(new { total, items = lite }));
    }

    /// <summary>
    /// 获取任务详情
    /// </summary>
    [HttpGet("runs/{runId}")]
    [ProducesResponseType(typeof(ApiResponse<VideoGenRun>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> GetRun(string runId, CancellationToken ct)
    {
        var run = await _videoGenService.GetRunAsync(runId, GetAdminId(), AppKey, ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        return Ok(ApiResponse<VideoGenRun>.Ok(run));
    }

    /// <summary>
    /// 更新单个分镜
    /// </summary>
    [HttpPut("runs/{runId}/scenes/{sceneIndex:int}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateScene(string runId, int sceneIndex, [FromBody] UpdateVideoSceneRequest request, CancellationToken ct)
    {
        try
        {
            var (scene, totalDuration) = await _videoGenService.UpdateSceneAsync(runId, GetAdminId(), sceneIndex, request, AppKey, ct);
            return Ok(ApiResponse<object>.Ok(new { scene, totalDurationSeconds = totalDuration }));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentOutOfRangeException)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 重新生成单个分镜
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/regenerate")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> RegenerateScene(string runId, int sceneIndex, CancellationToken ct)
    {
        try
        {
            await _videoGenService.RegenerateSceneAsync(runId, GetAdminId(), sceneIndex, AppKey, ct);
            return Ok(ApiResponse<object>.Ok(true));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentOutOfRangeException)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 触发视频渲染
    /// </summary>
    [HttpPost("runs/{runId}/render")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> TriggerRender(string runId, CancellationToken ct)
    {
        try
        {
            await _videoGenService.TriggerRenderAsync(runId, GetAdminId(), AppKey, ct);
            return Ok(ApiResponse<object>.Ok(true));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 为指定分镜生成预览视频
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/preview")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GenerateScenePreview(string runId, int sceneIndex, CancellationToken ct)
    {
        try
        {
            await _videoGenService.RequestScenePreviewAsync(runId, GetAdminId(), sceneIndex, AppKey, ct);
            return Ok(ApiResponse<object>.Ok(true));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentOutOfRangeException)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 为指定分镜生成 AI 背景图
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/generate-bg")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GenerateSceneBgImage(string runId, int sceneIndex, CancellationToken ct)
    {
        try
        {
            await _videoGenService.RequestSceneBgImageAsync(runId, GetAdminId(), sceneIndex, AppKey, ct);
            return Ok(ApiResponse<object>.Ok(true));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentOutOfRangeException)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 为指定分镜生成 TTS 语音
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/generate-audio")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GenerateSceneAudio(string runId, int sceneIndex, CancellationToken ct)
    {
        try
        {
            await _videoGenService.RequestSceneAudioAsync(runId, GetAdminId(), sceneIndex, AppKey, ct);
            return Ok(ApiResponse<object>.Ok(true));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentOutOfRangeException)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 批量生成所有分镜的 TTS 语音
    /// </summary>
    [HttpPost("runs/{runId}/generate-all-audio")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GenerateAllAudio(string runId, CancellationToken ct)
    {
        try
        {
            await _videoGenService.RequestAllAudioAsync(runId, GetAdminId(), AppKey, ct);
            return Ok(ApiResponse<object>.Ok(true));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }
        catch (Exception ex) when (ex is InvalidOperationException or ArgumentOutOfRangeException)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
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

        var bodyFeature = HttpContext.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpResponseBodyFeature>();
        bodyFeature?.DisableBuffering();

        var adminId = GetAdminId();
        var run = await _videoGenService.GetRunAsync(runId, adminId, AppKey, cancellationToken);
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
            var events = await _runStore.GetEventsAsync(RunKinds.VideoGen, runId, lastSeq, limit: 100, cancellationToken);
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

                var currentRun = await _videoGenService.GetRunAsync(runId, adminId, AppKey, cancellationToken);
                if (currentRun == null) break;
                if (currentRun.Status is VideoGenRunStatus.Completed or VideoGenRunStatus.Failed or VideoGenRunStatus.Cancelled)
                {
                    if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 2) break;
                }
                if (currentRun.Status == VideoGenRunStatus.Editing)
                {
                    if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 2) break;
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
    public async Task<IActionResult> CancelRun(string runId, CancellationToken ct)
    {
        var found = await _videoGenService.CancelRunAsync(runId, GetAdminId(), AppKey, ct);
        if (!found)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        return Ok(ApiResponse<object>.Ok(true));
    }

    /// <summary>
    /// 下载产出物
    /// </summary>
    [HttpGet("runs/{runId}/download/{type}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> Download(string runId, string type, CancellationToken ct)
    {
        var run = await _videoGenService.GetRunAsync(runId, GetAdminId(), AppKey, ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        if (run.Status != VideoGenRunStatus.Completed)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务尚未完成"));

        return type.ToLowerInvariant() switch
        {
            "srt" => Content(run.SrtContent ?? string.Empty, "application/x-subrip", System.Text.Encoding.UTF8),
            "narration" => Content(run.NarrationDoc ?? string.Empty, "text/markdown; charset=utf-8", System.Text.Encoding.UTF8),
            "script" => Content(run.ScriptMarkdown ?? string.Empty, "text/markdown; charset=utf-8", System.Text.Encoding.UTF8),
            _ => BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的下载类型，可选: srt, narration, script")),
        };
    }

    // ─── Private Helpers ───

    private async Task WriteEventAsync(string? id, string eventName, string dataJson, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(id))
            await Response.WriteAsync($"id: {id}\n", ct);
        await Response.WriteAsync($"event: {eventName}\n", ct);
        await Response.WriteAsync($"data: {dataJson}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }
}
