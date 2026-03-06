using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

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
    private readonly MongoDbContext _db;
    private readonly IRunEventStore _runStore;
    private readonly ILogger<VisualAgentVideoController> _logger;

    private const string AppKey = "visual-agent";
    private const int DailyLimit = 1;
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public VisualAgentVideoController(
        MongoDbContext db,
        IRunEventStore runStore,
        ILogger<VisualAgentVideoController> logger)
    {
        _db = db;
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
        var adminId = GetAdminId();
        var usedToday = await CountTodayRunsAsync(adminId, ct);

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
        var usedToday = await CountTodayRunsAsync(adminId, ct);
        if (usedToday >= DailyLimit)
        {
            return BadRequest(ApiResponse<object>.Fail(
                ErrorCodes.QUOTA_EXCEEDED,
                $"每日视频生成体验次数已达上限（{DailyLimit}次/天），明天再来试试吧"));
        }

        var markdown = (request?.ArticleMarkdown ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(markdown))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文章内容不能为空"));
        }

        if (markdown.Length > 100_000)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文章内容超过 10 万字限制"));
        }

        var title = (request?.ArticleTitle ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(title)) title = null;

        var run = new VideoGenRun
        {
            AppKey = AppKey,
            OwnerAdminId = adminId,
            Status = VideoGenRunStatus.Queued,
            ArticleMarkdown = markdown,
            ArticleTitle = title,
            SystemPrompt = request?.SystemPrompt?.Trim(),
            StyleDescription = request?.StyleDescription?.Trim(),
            CreatedAt = DateTime.UtcNow
        };

        await _db.VideoGenRuns.InsertOneAsync(run, cancellationToken: ct);

        _logger.LogInformation("VisualAgent VideoGen 已创建: runId={RunId}, titleLen={TitleLen}, mdLen={MdLen}, todayUsed={Used}/{Limit}",
            run.Id, title?.Length ?? 0, markdown.Length, usedToday + 1, DailyLimit);

        return Ok(ApiResponse<object>.Ok(new { runId = run.Id }));
    }

    /// <summary>
    /// 列出当前用户通过视觉创作入口创建的视频任务
    /// </summary>
    [HttpGet("runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListRuns([FromQuery] int limit = 20, [FromQuery] int skip = 0, CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        limit = Math.Clamp(limit, 1, 50);
        skip = Math.Max(skip, 0);

        var filter = Builders<VideoGenRun>.Filter.Eq(x => x.OwnerAdminId, adminId)
                   & Builders<VideoGenRun>.Filter.Eq(x => x.AppKey, AppKey);
        var sort = Builders<VideoGenRun>.Sort.Descending(x => x.CreatedAt);

        var total = await _db.VideoGenRuns.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.VideoGenRuns.Find(filter).Sort(sort).Skip(skip).Limit(limit).ToListAsync(ct);

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
        var run = await FindRunAsync(runId, ct);
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
        var run = await FindRunAsync(runId, ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        if (run.Status != VideoGenRunStatus.Editing)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅在编辑阶段可修改分镜"));

        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "分镜序号超出范围"));

        var scene = run.Scenes[sceneIndex];
        if (!string.IsNullOrWhiteSpace(request.Topic)) scene.Topic = request.Topic.Trim();
        if (!string.IsNullOrWhiteSpace(request.Narration)) scene.Narration = request.Narration.Trim();
        if (!string.IsNullOrWhiteSpace(request.VisualDescription)) scene.VisualDescription = request.VisualDescription.Trim();
        if (!string.IsNullOrWhiteSpace(request.SceneType)) scene.SceneType = request.SceneType.Trim();

        scene.DurationSeconds = Math.Max(3, Math.Round(scene.Narration.Length / 3.7, 1));
        var totalDuration = run.Scenes.Sum(s => s.DurationSeconds);

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update
                .Set(x => x.Scenes, run.Scenes)
                .Set(x => x.TotalDurationSeconds, totalDuration),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { scene, totalDurationSeconds = totalDuration }));
    }

    /// <summary>
    /// 重新生成单个分镜
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/regenerate")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> RegenerateScene(string runId, int sceneIndex, CancellationToken ct)
    {
        var run = await FindRunAsync(runId, ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        if (run.Status != VideoGenRunStatus.Editing)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅在编辑阶段可重新生成分镜"));

        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "分镜序号超出范围"));

        run.Scenes[sceneIndex].Status = SceneItemStatus.Generating;
        run.Scenes[sceneIndex].ErrorMessage = null;

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(true));
    }

    /// <summary>
    /// 触发视频渲染
    /// </summary>
    [HttpPost("runs/{runId}/render")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> TriggerRender(string runId, CancellationToken ct)
    {
        var run = await FindRunAsync(runId, ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        if (run.Status != VideoGenRunStatus.Editing)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅在编辑阶段可触发导出"));

        if (run.Scenes.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有分镜数据"));

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId && x.Status == VideoGenRunStatus.Editing,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Rendering)
                .Set(x => x.CurrentPhase, "rendering")
                .Set(x => x.PhaseProgress, 0),
            cancellationToken: ct);

        await PublishEventAsync(runId, "phase.changed", new { phase = "rendering", progress = 0 });

        _logger.LogInformation("VisualAgent VideoGen 触发渲染: runId={RunId}, scenes={Count}", runId, run.Scenes.Count);

        return Ok(ApiResponse<object>.Ok(true));
    }

    /// <summary>
    /// 为指定分镜生成预览视频
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/preview")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GenerateScenePreview(string runId, int sceneIndex, CancellationToken ct)
    {
        var run = await FindRunAsync(runId, ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        if (run.Status != VideoGenRunStatus.Editing)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅在编辑阶段可生成预览"));

        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "分镜序号超出范围"));

        run.Scenes[sceneIndex].ImageStatus = "running";
        run.Scenes[sceneIndex].ImageUrl = null;

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(true));
    }

    /// <summary>
    /// 为指定分镜生成 AI 背景图
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/generate-bg")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GenerateSceneBgImage(string runId, int sceneIndex, CancellationToken ct)
    {
        var run = await FindRunAsync(runId, ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        if (run.Status != VideoGenRunStatus.Editing)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅在编辑阶段可生成背景图"));

        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "分镜序号超出范围"));

        run.Scenes[sceneIndex].BackgroundImageStatus = "running";
        run.Scenes[sceneIndex].BackgroundImageUrl = null;

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(true));
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

        var run = await FindRunAsync(runId, cancellationToken);
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

                var currentRun = await _db.VideoGenRuns
                    .Find(x => x.Id == runId && x.OwnerAdminId == GetAdminId())
                    .FirstOrDefaultAsync(cancellationToken);
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
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();

        var res = await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId && x.OwnerAdminId == adminId && x.AppKey == AppKey,
            Builders<VideoGenRun>.Update.Set(x => x.CancelRequested, true),
            cancellationToken: ct);

        if (res.MatchedCount == 0)
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
        var run = await FindRunAsync(runId, ct);
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

    /// <summary>
    /// 查询今日该用户通过 visual-agent 入口创建的视频 run 数量
    /// </summary>
    private async Task<long> CountTodayRunsAsync(string adminId, CancellationToken ct)
    {
        var todayStart = DateTime.UtcNow.Date;
        return await _db.VideoGenRuns.CountDocumentsAsync(
            x => x.OwnerAdminId == adminId
              && x.AppKey == AppKey
              && x.CreatedAt >= todayStart,
            cancellationToken: ct);
    }

    /// <summary>
    /// 查找属于当前用户且来自 visual-agent 入口的 run
    /// </summary>
    private async Task<VideoGenRun?> FindRunAsync(string runId, CancellationToken ct)
    {
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();
        return await _db.VideoGenRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId && x.AppKey == AppKey)
            .FirstOrDefaultAsync(ct);
    }

    private async Task PublishEventAsync(string runId, string eventName, object payload)
    {
        try
        {
            await _runStore.AppendEventAsync(RunKinds.VideoGen, runId, eventName, payload,
                ttl: TimeSpan.FromHours(2), ct: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "VisualAgent VideoGen 事件发布失败: runId={RunId}, event={Event}", runId, eventName);
        }
    }

    private async Task WriteEventAsync(string? id, string eventName, string dataJson, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(id))
            await Response.WriteAsync($"id: {id}\n", ct);
        await Response.WriteAsync($"event: {eventName}\n", ct);
        await Response.WriteAsync($"data: {dataJson}\n\n", ct);
        await Response.Body.FlushAsync(ct);
    }
}
