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
/// 管理后台 - 视频 Agent：文章转教程视频
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
    private readonly ILogger<VideoAgentController> _logger;

    private const string AppKey = "video-agent";
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public VideoAgentController(
        MongoDbContext db,
        IRunEventStore runStore,
        ILogger<VideoAgentController> logger)
    {
        _db = db;
        _runStore = runStore;
        _logger = logger;
    }

    private string GetAdminId() =>
        User.FindFirst("sub")?.Value
        ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
        ?? "unknown";

    /// <summary>
    /// 创建视频生成任务
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

        // 列表不返回大字段
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

        return Ok(ApiResponse<VideoGenRun>.Ok(run));
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
