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
    private readonly MongoDbContext _db;
    private readonly IRunEventStore _runStore;
    private readonly IConfiguration _configuration;
    private readonly ILogger<VideoAgentController> _logger;

    private const string AppKey = "video-agent";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public VideoAgentController(
        MongoDbContext db,
        IRunEventStore runStore,
        IConfiguration configuration,
        ILogger<VideoAgentController> logger)
    {
        _db = db;
        _runStore = runStore;
        _configuration = configuration;
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
        var adminId = GetAdminId();

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
            OwnerAdminId = adminId,
            Status = VideoGenRunStatus.Queued,
            ArticleMarkdown = markdown,
            ArticleTitle = title,
            SystemPrompt = request?.SystemPrompt?.Trim(),
            StyleDescription = request?.StyleDescription?.Trim(),
            CreatedAt = DateTime.UtcNow
        };

        await _db.VideoGenRuns.InsertOneAsync(run, cancellationToken: ct);

        _logger.LogInformation("VideoAgent Run 已创建: runId={RunId}, titleLen={TitleLen}, mdLen={MdLen}",
            run.Id, title?.Length ?? 0, markdown.Length);

        return Ok(ApiResponse<object>.Ok(new { runId = run.Id }));
    }

    /// <summary>
    /// 列出当前用户的视频生成任务
    /// </summary>
    [HttpGet("runs")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> ListRuns([FromQuery] int limit = 20, [FromQuery] int skip = 0, CancellationToken ct = default)
    {
        var adminId = GetAdminId();
        limit = Math.Clamp(limit, 1, 50);
        skip = Math.Max(skip, 0);

        var filter = Builders<VideoGenRun>.Filter.Eq(x => x.OwnerAdminId, adminId);
        var sort = Builders<VideoGenRun>.Sort.Descending(x => x.CreatedAt);

        var total = await _db.VideoGenRuns.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.VideoGenRuns.Find(filter).Sort(sort).Skip(skip).Limit(limit).ToListAsync(ct);

        // 列表返回精简版 + 分镜数量
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
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();

        var run = await _db.VideoGenRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
            .FirstOrDefaultAsync(ct);

        if (run == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }

        // 兼容旧数据：将本地路径转换为 API URL
        NormalizeVideoUrls(run);

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
        var adminId = GetAdminId();
        var run = await _db.VideoGenRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
            .FirstOrDefaultAsync(ct);

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

        // 重新计算时长（按旁白字数）
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
    /// 重新生成单个分镜（LLM 重新生成指定分镜的内容）
    /// Worker 从 Queued 状态的场景中挑选处理
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/regenerate")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> RegenerateScene(string runId, int sceneIndex, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var run = await _db.VideoGenRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
            .FirstOrDefaultAsync(ct);

        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        if (run.Status != VideoGenRunStatus.Editing)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅在编辑阶段可重新生成分镜"));

        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "分镜序号超出范围"));

        // 标记该分镜为 Generating（Worker 轮询时会处理）
        run.Scenes[sceneIndex].Status = SceneItemStatus.Generating;
        run.Scenes[sceneIndex].ErrorMessage = null;

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes),
            cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(true));
    }

    /// <summary>
    /// 触发视频渲染（用户编辑完分镜后，手动点击"导出"）
    /// </summary>
    [HttpPost("runs/{runId}/render")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> TriggerRender(string runId, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var run = await _db.VideoGenRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
            .FirstOrDefaultAsync(ct);

        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        if (run.Status != VideoGenRunStatus.Editing)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅在编辑阶段可触发导出"));

        if (run.Scenes.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有分镜数据"));

        // 将状态切换为 Rendering，Worker 会自动拾取
        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId && x.Status == VideoGenRunStatus.Editing,
            Builders<VideoGenRun>.Update
                .Set(x => x.Status, VideoGenRunStatus.Rendering)
                .Set(x => x.CurrentPhase, "rendering")
                .Set(x => x.PhaseProgress, 0),
            cancellationToken: ct);

        await PublishEventAsync(runId, "phase.changed", new { phase = "rendering", progress = 0 });

        _logger.LogInformation("VideoAgent 触发渲染: runId={RunId}, scenes={Count}", runId, run.Scenes.Count);

        return Ok(ApiResponse<object>.Ok(true));
    }

    // ─── 分镜预览视频（Remotion 渲染单场景） ───

    /// <summary>
    /// 为指定分镜生成预览视频（标记 imageStatus=running，由 VideoGenRunWorker 渲染）
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/preview")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GenerateScenePreview(string runId, int sceneIndex, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var run = await _db.VideoGenRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
            .FirstOrDefaultAsync(ct);

        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        if (run.Status != VideoGenRunStatus.Editing)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅在编辑阶段可生成预览"));

        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "分镜序号超出范围"));

        // 标记 imageStatus=running，Worker 会自动拾取并渲染
        run.Scenes[sceneIndex].ImageStatus = "running";
        run.Scenes[sceneIndex].ImageUrl = null;

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes),
            cancellationToken: ct);

        _logger.LogInformation("VideoAgent 分镜预览排队: runId={RunId}, scene={Scene}", runId, sceneIndex);

        return Ok(ApiResponse<object>.Ok(true));
    }

    // ─── 分镜背景图生成（AI 图生模型） ───

    /// <summary>
    /// 为指定分镜生成 AI 背景图（标记 backgroundImageStatus=running，由 Worker 调图生模型）
    /// </summary>
    [HttpPost("runs/{runId}/scenes/{sceneIndex:int}/generate-bg")]
    [ProducesResponseType(typeof(ApiResponse<object>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GenerateSceneBgImage(string runId, int sceneIndex, CancellationToken ct)
    {
        var adminId = GetAdminId();
        var run = await _db.VideoGenRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
            .FirstOrDefaultAsync(ct);

        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));

        if (run.Status != VideoGenRunStatus.Editing)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅在编辑阶段可生成背景图"));

        if (sceneIndex < 0 || sceneIndex >= run.Scenes.Count)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "分镜序号超出范围"));

        // 标记 backgroundImageStatus=running，Worker 会自动拾取并调图生模型
        run.Scenes[sceneIndex].BackgroundImageStatus = "running";
        run.Scenes[sceneIndex].BackgroundImageUrl = null;

        await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId,
            Builders<VideoGenRun>.Update.Set(x => x.Scenes, run.Scenes),
            cancellationToken: ct);

        _logger.LogInformation("VideoAgent 背景图排队: runId={RunId}, scene={Scene}", runId, sceneIndex);

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

        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();

        var run = await _db.VideoGenRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
            .FirstOrDefaultAsync(cancellationToken);

        if (run == null)
        {
            await WriteEventAsync(null, "error",
                JsonSerializer.Serialize(new { code = ErrorCodes.NOT_FOUND, message = "任务不存在" }, JsonOptions),
                cancellationToken);
            return;
        }

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

                run = await _db.VideoGenRuns
                    .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
                    .FirstOrDefaultAsync(cancellationToken);
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
        var adminId = GetAdminId();
        runId = (runId ?? string.Empty).Trim();

        var res = await _db.VideoGenRuns.UpdateOneAsync(
            x => x.Id == runId && x.OwnerAdminId == adminId,
            Builders<VideoGenRun>.Update.Set(x => x.CancelRequested, true),
            cancellationToken: ct);

        if (res.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }

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
        var adminId = GetAdminId();
        var run = await _db.VideoGenRuns
            .Find(x => x.Id == runId && x.OwnerAdminId == adminId)
            .FirstOrDefaultAsync(ct);

        if (run == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "任务不存在"));
        }

        if (run.Status != VideoGenRunStatus.Completed)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "任务尚未完成"));
        }

        return type.ToLowerInvariant() switch
        {
            "srt" => Content(run.SrtContent ?? string.Empty, "application/x-subrip", System.Text.Encoding.UTF8),
            "narration" => Content(run.NarrationDoc ?? string.Empty, "text/markdown; charset=utf-8", System.Text.Encoding.UTF8),
            "script" => Content(run.ScriptMarkdown ?? string.Empty, "text/markdown; charset=utf-8", System.Text.Encoding.UTF8),
            _ => BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "不支持的下载类型，可选: srt, narration, script")),
        };
    }

    /// <summary>
    /// 兼容旧数据：将本地文件系统路径转换为 /api/video-agent/assets/{fileName} 格式
    /// </summary>
    private static void NormalizeVideoUrls(VideoGenRun run)
    {
        foreach (var scene in run.Scenes)
        {
            scene.ImageUrl = NormalizePath(scene.ImageUrl);
        }
        run.VideoAssetUrl = NormalizePath(run.VideoAssetUrl);
    }

    private static string? NormalizePath(string? url)
    {
        if (string.IsNullOrWhiteSpace(url) || url.StartsWith("/api/")) return url;
        // 本地路径 → 提取文件名 → API URL
        var fileName = Path.GetFileName(url);
        if (string.IsNullOrWhiteSpace(fileName) || !fileName.EndsWith(".mp4")) return url;
        return $"/api/video-agent/assets/{fileName}";
    }

    // ─── 静态资源 ───

    /// <summary>
    /// 提供 prd-video/out/ 目录下渲染产物的 HTTP 访问（视频预览/下载）
    /// 仅允许 .mp4 文件，文件名必须为安全字符
    /// </summary>
    [HttpGet("assets/{fileName}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public IActionResult ServeAsset(string fileName)
    {
        // 安全校验：仅允许 [a-zA-Z0-9_\-\.] 文件名 + .mp4 扩展名
        if (string.IsNullOrWhiteSpace(fileName)
            || !System.Text.RegularExpressions.Regex.IsMatch(fileName, @"^[\w\-\.]+\.mp4$"))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "非法文件名"));
        }

        var videoProjectPath = _configuration["VideoAgent:RemotionProjectPath"];
        if (string.IsNullOrWhiteSpace(videoProjectPath))
        {
            var baseDir = AppContext.BaseDirectory;
            videoProjectPath = Path.GetFullPath(Path.Combine(baseDir, "..", "..", "..", "..", "..", "..", "prd-video"));
        }

        var filePath = Path.Combine(videoProjectPath, "out", fileName);
        if (!System.IO.File.Exists(filePath))
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "文件不存在"));
        }

        var stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.Read);
        return File(stream, "video/mp4", enableRangeProcessing: true);
    }

    // ─── Helpers ───

    private async Task PublishEventAsync(string runId, string eventName, object payload)
    {
        try
        {
            await _runStore.AppendEventAsync(RunKinds.VideoGen, runId, eventName, payload,
                ttl: TimeSpan.FromHours(2), ct: CancellationToken.None);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "VideoGen 事件发布失败: runId={RunId}, event={Event}", runId, eventName);
        }
    }

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
