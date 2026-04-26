using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Security;
using MongoDB.Driver;
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
    private readonly MongoDbContext _db;
    private readonly ILogger<VideoAgentController> _logger;

    private const string AppKey = "video-agent";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public VideoAgentController(
        IVideoGenService videoGenService,
        IRunEventStore runStore,
        MongoDbContext db,
        IOpenRouterVideoClient videoClient,
        ILogger<VideoAgentController> logger)
    {
        _videoGenService = videoGenService;
        _runStore = runStore;
        _db = db;
        _videoClient = videoClient;
        _logger = logger;
    }

    private readonly IOpenRouterVideoClient _videoClient;

    private string GetAdminId() => this.GetRequiredUserId();

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
            GenerateAudio = true,
            UserId = GetAdminId()
        }, ct);

        return Ok(ApiResponse<object>.Ok(new { result.Success, result.JobId, result.ActualModel, result.Cost, result.ErrorMessage }));
    }

    [HttpGet("videogen-direct/status/{jobId}")]
    public async Task<IActionResult> VideoGenDirectStatus(string jobId, CancellationToken ct)
    {
        var status = await _videoClient.GetStatusAsync(AppCallerRegistry.VideoAgent.VideoGen.Generate, jobId, ct);
        return Ok(ApiResponse<object>.Ok(new { status.Status, status.VideoUrl, status.Cost, status.ErrorMessage, status.IsCompleted, status.IsFailed }));
    }

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

    /// <summary>
    /// 切换任务级默认渲染模式（Remotion ↔ VideoGen），可选同步覆盖所有分镜
    /// </summary>
    [HttpPut("runs/{runId}/render-mode")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> UpdateRunRenderMode(string runId, [FromBody] UpdateRunRenderModeRequest request, CancellationToken ct)
    {
        try
        {
            await _videoGenService.UpdateRunRenderModeAsync(runId, GetAdminId(), request.Mode, request.ApplyToAllScenes, ct: ct);
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
    /// 为指定分镜生成 TTS 语音（手动触发）
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
}
