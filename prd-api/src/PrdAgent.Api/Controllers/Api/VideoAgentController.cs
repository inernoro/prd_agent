using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

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
    private readonly ILogger<VideoAgentController> _logger;

    private const string AppKey = "video-agent";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public VideoAgentController(
        IVideoGenService videoGenService,
        IRunEventStore runStore,
        ILogger<VideoAgentController> logger)
    {
        _videoGenService = videoGenService;
        _runStore = runStore;
        _logger = logger;
    }

    private string GetAdminId() =>
        User.FindFirst("sub")?.Value
        ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? "unknown";

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
    /// 更新单个分镜（用户编辑阶段）
    /// </summary>
    [HttpPut("runs/{runId}/scenes/{sceneIndex:int}")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> UpdateScene(string runId, int sceneIndex, [FromBody] UpdateVideoSceneRequest request, CancellationToken ct)
    {
        try
        {
            var (scene, totalDuration) = await _videoGenService.UpdateSceneAsync(runId, GetAdminId(), sceneIndex, request, ct: ct);
            return Ok(ApiResponse<object>.Ok(new { scene, totalDurationSeconds = totalDuration }));
        }
        catch (KeyNotFoundException)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
        catch (ArgumentOutOfRangeException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }
    }

    /// <summary>
    /// 重新生成单个分镜（LLM 重新生成指定分镜的内容）
    /// Worker 从 Queued 状态的场景中挑选处理
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/regenerate")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> RegenerateScene(string runId, int sceneIndex, CancellationToken ct)
    {
        try
        {
            await _videoGenService.RegenerateSceneAsync(runId, GetAdminId(), sceneIndex, ct: ct);
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
    /// 触发视频渲染（用户编辑完分镜后，手动点击"导出"）
    /// </summary>
    [HttpPost("runs/{runId}/render")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> TriggerRender(string runId, CancellationToken ct)
    {
        try
        {
            await _videoGenService.TriggerRenderAsync(runId, GetAdminId(), ct: ct);
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

    // ─── 分镜预览视频（Remotion 渲染单场景） ───

    /// <summary>
    /// 为指定分镜生成预览视频（标记 imageStatus=running，由 VideoGenRunWorker 渲染）
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/preview")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GenerateScenePreview(string runId, int sceneIndex, CancellationToken ct)
    {
        try
        {
            await _videoGenService.RequestScenePreviewAsync(runId, GetAdminId(), sceneIndex, ct: ct);
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

    // ─── 分镜背景图生成（AI 图生模型） ───

    /// <summary>
    /// 为指定分镜生成 AI 背景图（标记 backgroundImageStatus=running，由 Worker 调图生模型）
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/generate-bg")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GenerateSceneBgImage(string runId, int sceneIndex, CancellationToken ct)
    {
        try
        {
            await _videoGenService.RequestSceneBgImageAsync(runId, GetAdminId(), sceneIndex, ct: ct);
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

        // 立即发送 SSE 注释作为心跳，确保连接建立并防止代理超时
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

                run = await _videoGenService.GetRunAsync(runId, adminId, ct: cancellationToken);
                if (run == null) break;
                if (run.Status is VideoGenRunStatus.Completed or VideoGenRunStatus.Failed or VideoGenRunStatus.Cancelled)
                {
                    if ((DateTime.UtcNow - lastKeepAliveAt).TotalSeconds >= 2) break;
                }
                // Editing 状态也要退出轮询（分镜生成完成后进入 Editing）
                if (run.Status == VideoGenRunStatus.Editing)
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
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> CancelRun(string runId, CancellationToken ct)
    {
        var found = await _videoGenService.CancelRunAsync(runId, GetAdminId(), ct: ct);
        if (!found)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        return Ok(ApiResponse<object>.Ok(true));
    }

    /// <summary>
    /// 下载产出物
    /// </summary>
    [HttpGet("runs/{runId}/download/{type}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Download(string runId, string type, CancellationToken ct)
    {
        var run = await _videoGenService.GetRunAsync(runId, GetAdminId(), ct: ct);
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
