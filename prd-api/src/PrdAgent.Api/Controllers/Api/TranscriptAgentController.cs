using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 音视频转录 Agent
/// </summary>
[ApiController]
[Route("api/transcript-agent")]
[Authorize]
[AdminController("ai-toolbox", AdminPermissionCatalog.AiToolboxUse)]
public class TranscriptAgentController : ControllerBase
{
    private const string AppKey = "transcript-agent";
    private const long MaxUploadBytes = 100 * 1024 * 1024; // 100MB
    private static readonly HashSet<string> AllowedMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/m4a",
        "audio/x-m4a", "audio/ogg", "audio/flac", "audio/webm",
        "video/mp4", "video/webm", "video/quicktime"
    };

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<TranscriptAgentController> _logger;

    public TranscriptAgentController(
        MongoDbContext db,
        IAssetStorage assetStorage,
        ILogger<TranscriptAgentController> logger)
    {
        _db = db;
        _assetStorage = assetStorage;
        _logger = logger;
    }

    // ────────────── Workspace CRUD ──────────────

    [HttpGet("workspaces")]
    public async Task<IActionResult> ListWorkspaces()
    {
        var userId = this.GetRequiredUserId();
        var list = await _db.TranscriptWorkspaces
            .Find(w => w.OwnerUserId == userId || w.MemberUserIds.Contains(userId))
            .SortByDescending(w => w.UpdatedAt)
            .ToListAsync();
        return Ok(list);
    }

    [HttpPost("workspaces")]
    public async Task<IActionResult> CreateWorkspace([FromBody] CreateWorkspaceDto dto)
    {
        var userId = this.GetRequiredUserId();
        var workspace = new TranscriptWorkspace
        {
            Title = dto.Title.Trim(),
            OwnerUserId = userId
        };
        await _db.TranscriptWorkspaces.InsertOneAsync(workspace);
        return Ok(workspace);
    }

    [HttpGet("workspaces/{id}")]
    public async Task<IActionResult> GetWorkspace(string id)
    {
        var userId = this.GetRequiredUserId();
        var workspace = await _db.TranscriptWorkspaces
            .Find(w => w.Id == id && (w.OwnerUserId == userId || w.MemberUserIds.Contains(userId)))
            .FirstOrDefaultAsync();
        if (workspace == null) return NotFound();
        return Ok(workspace);
    }

    [HttpDelete("workspaces/{id}")]
    public async Task<IActionResult> DeleteWorkspace(string id)
    {
        var userId = this.GetRequiredUserId();
        var result = await _db.TranscriptWorkspaces.DeleteOneAsync(w => w.Id == id && w.OwnerUserId == userId);
        if (result.DeletedCount == 0) return NotFound();

        // 级联删除素材和任务
        await _db.TranscriptItems.DeleteManyAsync(i => i.WorkspaceId == id);
        await _db.TranscriptRuns.DeleteManyAsync(r => r.WorkspaceId == id);
        return NoContent();
    }

    // ────────────── Item (素材) ──────────────

    [HttpGet("workspaces/{workspaceId}/items")]
    public async Task<IActionResult> ListItems(string workspaceId)
    {
        var userId = this.GetRequiredUserId();
        var workspace = await _db.TranscriptWorkspaces
            .Find(w => w.Id == workspaceId && (w.OwnerUserId == userId || w.MemberUserIds.Contains(userId)))
            .FirstOrDefaultAsync();
        if (workspace == null) return NotFound();

        var items = await _db.TranscriptItems
            .Find(i => i.WorkspaceId == workspaceId)
            .SortByDescending(i => i.CreatedAt)
            .ToListAsync();
        return Ok(items);
    }

    [HttpPost("workspaces/{workspaceId}/items/upload")]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<IActionResult> UploadItem(string workspaceId, IFormFile file)
    {
        var userId = this.GetRequiredUserId();
        var workspace = await _db.TranscriptWorkspaces
            .Find(w => w.Id == workspaceId && (w.OwnerUserId == userId || w.MemberUserIds.Contains(userId)))
            .FirstOrDefaultAsync();
        if (workspace == null) return NotFound("工作区不存在");

        if (file.Length > MaxUploadBytes)
            return BadRequest($"文件大小超过限制（最大 {MaxUploadBytes / 1024 / 1024}MB）");

        if (!AllowedMimeTypes.Contains(file.ContentType))
            return BadRequest($"不支持的文件格式: {file.ContentType}");

        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        var bytes = ms.ToArray();

        var stored = await _assetStorage.SaveAsync(bytes, file.ContentType, CancellationToken.None, "transcript-agent", "audio");

        var item = new TranscriptItem
        {
            WorkspaceId = workspaceId,
            OwnerUserId = userId,
            FileName = file.FileName,
            MimeType = file.ContentType,
            FileSize = file.Length,
            FileUrl = stored.Url,
            TranscribeStatus = "pending"
        };
        await _db.TranscriptItems.InsertOneAsync(item);

        // 自动创建 ASR 转写任务
        var run = new TranscriptRun
        {
            ItemId = item.Id,
            WorkspaceId = workspaceId,
            OwnerUserId = userId,
            Type = "asr",
            Status = "queued"
        };
        await _db.TranscriptRuns.InsertOneAsync(run);

        _logger.LogInformation("[{AppKey}] Upload item {ItemId} in workspace {WorkspaceId}, run {RunId} queued",
            AppKey, item.Id, workspaceId, run.Id);

        return Ok(new { item, runId = run.Id });
    }

    [HttpDelete("items/{itemId}")]
    public async Task<IActionResult> DeleteItem(string itemId)
    {
        var userId = this.GetRequiredUserId();
        var result = await _db.TranscriptItems.DeleteOneAsync(i => i.Id == itemId && i.OwnerUserId == userId);
        if (result.DeletedCount == 0) return NotFound();

        await _db.TranscriptRuns.DeleteManyAsync(r => r.ItemId == itemId);
        return NoContent();
    }

    // ────────────── 重命名素材 ──────────────

    /// <summary>
    /// 重命名素材
    /// </summary>
    [HttpPatch("items/{itemId}/rename")]
    public async Task<IActionResult> RenameItem(string itemId, [FromBody] RenameItemRequest request)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.TranscriptItems.Find(
            i => i.Id == itemId && i.OwnerUserId == userId).FirstOrDefaultAsync();
        if (item == null) return NotFound();

        if (string.IsNullOrWhiteSpace(request.FileName))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "文件名不能为空"));

        await _db.TranscriptItems.UpdateOneAsync(
            Builders<TranscriptItem>.Filter.Eq(i => i.Id, itemId),
            Builders<TranscriptItem>.Update
                .Set(i => i.FileName, request.FileName.Trim())
                .Set(i => i.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { id = itemId }));
    }

    // ────────────── 转写结果编辑 ──────────────

    [HttpPut("items/{itemId}/segments")]
    public async Task<IActionResult> UpdateSegments(string itemId, [FromBody] List<TranscriptSegment> segments)
    {
        var userId = this.GetRequiredUserId();
        var update = Builders<TranscriptItem>.Update
            .Set(i => i.Segments, segments)
            .Set(i => i.UpdatedAt, DateTime.UtcNow);
        var result = await _db.TranscriptItems.UpdateOneAsync(
            i => i.Id == itemId && i.OwnerUserId == userId, update);
        if (result.MatchedCount == 0) return NotFound();
        return Ok();
    }

    // ────────────── 模板转文案 ──────────────

    [HttpGet("templates")]
    public async Task<IActionResult> ListTemplates()
    {
        var userId = this.GetRequiredUserId();
        var templates = await _db.TranscriptTemplates
            .Find(t => t.IsSystem || t.OwnerUserId == userId)
            .SortBy(t => t.Name)
            .ToListAsync();
        return Ok(templates);
    }

    [HttpPost("templates")]
    public async Task<IActionResult> CreateTemplate([FromBody] CreateTemplateDto dto)
    {
        var userId = this.GetRequiredUserId();
        var template = new TranscriptTemplate
        {
            Name = dto.Name.Trim(),
            Description = dto.Description?.Trim(),
            Prompt = dto.Prompt.Trim(),
            IsSystem = dto.IsSystem,
            OwnerUserId = dto.IsSystem ? null : userId
        };
        await _db.TranscriptTemplates.InsertOneAsync(template);
        return Ok(template);
    }

    [HttpPost("items/{itemId}/copywrite")]
    public async Task<IActionResult> CreateCopywriteRun(string itemId, [FromBody] CreateCopywriteDto dto)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.TranscriptItems.Find(i => i.Id == itemId && i.OwnerUserId == userId).FirstOrDefaultAsync();
        if (item == null) return NotFound("素材不存在");
        if (item.Segments == null || item.Segments.Count == 0)
            return BadRequest("该素材尚未完成转写");

        var run = new TranscriptRun
        {
            ItemId = itemId,
            WorkspaceId = item.WorkspaceId,
            OwnerUserId = userId,
            Type = "copywrite",
            TemplateId = dto.TemplateId,
            Status = "queued"
        };
        await _db.TranscriptRuns.InsertOneAsync(run);

        _logger.LogInformation("[{AppKey}] Copywrite run {RunId} for item {ItemId}, template {TemplateId}",
            AppKey, run.Id, itemId, dto.TemplateId);

        return Ok(run);
    }

    // ────────────── Run 进度 SSE 流 ──────────────

    /// <summary>
    /// 转录进度 SSE 流 — 推送 run 状态变化直到完成/失败
    /// 事件类型：
    /// - progress: {status, progress}
    /// - segments: {segments} （完成时推送最终分段结果）
    /// - done: {status: "completed"}
    /// - error: {error: "..."}
    /// </summary>
    [HttpGet("runs/{runId}/progress")]
    public async Task StreamRunProgress(string runId, CancellationToken ct)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.Append("Cache-Control", "no-cache");
        Response.Headers.Append("X-Accel-Buffering", "no");

        var userId = this.GetRequiredUserId();

        // 验证 run 存在且属于当前用户
        var run = await _db.TranscriptRuns.Find(r => r.Id == runId && r.OwnerUserId == userId).FirstOrDefaultAsync(ct);
        if (run == null) { Response.StatusCode = 404; return; }

        var lastProgress = -1;
        var lastStatus = "";
        var lastResult = "";
        var jsonOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

        // 轮询直到完成/失败（每秒检查一次，最多10分钟）
        var heartbeatCounter = 0;
        for (var i = 0; i < 600 && !ct.IsCancellationRequested; i++)
        {
            run = await _db.TranscriptRuns.Find(r => r.Id == runId).FirstOrDefaultAsync(ct);
            if (run == null) break;

            // 进度变化时推送
            if (run.Progress != lastProgress || run.Status != lastStatus)
            {
                lastProgress = run.Progress;
                lastStatus = run.Status;

                await SendSseEvent("progress", new { status = run.Status, progress = run.Progress });
                heartbeatCounter = 0;
            }

            // 实时识别文字变化时推送
            if (run.Result != null && run.Result != lastResult)
            {
                lastResult = run.Result;
                await SendSseEvent("typing", new { text = run.Result });
                heartbeatCounter = 0;
            }

            // 完成：推送段落数据
            if (run.Status == "completed")
            {
                var item = await _db.TranscriptItems.Find(ti => ti.Id == run.ItemId).FirstOrDefaultAsync(CancellationToken.None);
                if (item?.Segments != null)
                {
                    await SendSseEvent("segments", new
                    {
                        segments = item.Segments.Select(s => new { s.Start, s.End, s.Text })
                    });
                }
                await SendSseEvent("done", new { status = "completed" });
                break;
            }

            // 失败
            if (run.Status == "failed")
            {
                await SendSseEvent("error", new { error = run.Error ?? "转录失败" });
                break;
            }

            // 每 10 秒发送 keepalive 心跳
            heartbeatCounter++;
            if (heartbeatCounter >= 10)
            {
                try
                {
                    await Response.WriteAsync(": keepalive\n\n", CancellationToken.None);
                    await Response.Body.FlushAsync(CancellationToken.None);
                }
                catch (OperationCanceledException) { }
                catch (ObjectDisposedException) { }
                heartbeatCounter = 0;
            }

            await Task.Delay(1000, ct);
        }

        // 本地方法
        async Task SendSseEvent(string eventType, object data)
        {
            var json = JsonSerializer.Serialize(data, jsonOptions);
            try
            {
                await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n", CancellationToken.None);
                await Response.Body.FlushAsync(CancellationToken.None);
            }
            catch (OperationCanceledException) { }
            catch (ObjectDisposedException) { }
        }
    }

    // ────────────── Run 状态查询 ──────────────

    [HttpGet("runs/{runId}")]
    public async Task<IActionResult> GetRun(string runId)
    {
        var userId = this.GetRequiredUserId();
        var run = await _db.TranscriptRuns.Find(r => r.Id == runId && r.OwnerUserId == userId).FirstOrDefaultAsync();
        if (run == null) return NotFound();
        return Ok(run);
    }

    [HttpGet("workspaces/{workspaceId}/runs")]
    public async Task<IActionResult> ListRuns(string workspaceId)
    {
        var userId = this.GetRequiredUserId();
        var runs = await _db.TranscriptRuns
            .Find(r => r.WorkspaceId == workspaceId && r.OwnerUserId == userId)
            .SortByDescending(r => r.CreatedAt)
            .ToListAsync();
        return Ok(runs);
    }

    // ────────────── 保存文案编辑 ──────────────

    /// <summary>
    /// 保存用户对文案 run 的编辑结果
    /// </summary>
    [HttpPut("runs/{runId}/result")]
    public async Task<IActionResult> UpdateRunResult(string runId, [FromBody] UpdateRunResultDto dto)
    {
        var userId = this.GetRequiredUserId();
        var run = await _db.TranscriptRuns.Find(r => r.Id == runId && r.OwnerUserId == userId).FirstOrDefaultAsync();
        if (run == null) return NotFound();

        await _db.TranscriptRuns.UpdateOneAsync(
            Builders<TranscriptRun>.Filter.Eq(r => r.Id, runId),
            Builders<TranscriptRun>.Update
                .Set(r => r.Result, dto.Result)
                .Set(r => r.UpdatedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { id = runId }));
    }

    // ────────────── 删除 Run ──────────────

    [HttpDelete("runs/{runId}")]
    public async Task<IActionResult> DeleteRun(string runId)
    {
        var userId = this.GetRequiredUserId();
        var run = await _db.TranscriptRuns.Find(r => r.Id == runId && r.OwnerUserId == userId).FirstOrDefaultAsync();
        if (run == null) return NotFound();

        await _db.TranscriptRuns.DeleteOneAsync(r => r.Id == runId);
        return Ok(new { id = runId });
    }

    // ────────────── 导出 ──────────────

    [HttpPost("items/{itemId}/export")]
    public async Task<IActionResult> Export(string itemId, [FromBody] ExportDto dto)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.TranscriptItems.Find(i => i.Id == itemId && i.OwnerUserId == userId).FirstOrDefaultAsync();
        if (item == null) return NotFound();
        if (item.Segments == null || item.Segments.Count == 0)
            return BadRequest("该素材尚未完成转写");

        var results = new Dictionary<string, string>();

        foreach (var format in dto.Formats)
        {
            results[format] = format switch
            {
                "txt" => ExportPlainText(item),
                "srt" => ExportSrt(item),
                "timestamped" => ExportTimestamped(item),
                _ => $"不支持的格式: {format}"
            };
        }

        return Ok(results);
    }

    private static string ExportPlainText(TranscriptItem item)
    {
        return string.Join("\n", item.Segments!.Select(s => s.Text));
    }

    private static string ExportSrt(TranscriptItem item)
    {
        var lines = new List<string>();
        for (var i = 0; i < item.Segments!.Count; i++)
        {
            var seg = item.Segments[i];
            lines.Add((i + 1).ToString());
            lines.Add($"{FormatSrtTime(seg.Start)} --> {FormatSrtTime(seg.End)}");
            lines.Add(seg.Text);
            lines.Add("");
        }
        return string.Join("\n", lines);
    }

    private static string ExportTimestamped(TranscriptItem item)
    {
        return string.Join("\n", item.Segments!.Select(s =>
            $"[{TimeSpan.FromSeconds(s.Start):hh\\:mm\\:ss}] {s.Text}"));
    }

    private static string FormatSrtTime(double seconds)
    {
        var ts = TimeSpan.FromSeconds(seconds);
        return $"{ts.Hours:D2}:{ts.Minutes:D2}:{ts.Seconds:D2},{ts.Milliseconds:D3}";
    }
}

// ────────────── DTOs ──────────────

public record CreateWorkspaceDto(string Title);
public record CreateCopywriteDto(string TemplateId);
public record CreateTemplateDto(string Name, string? Description, string Prompt, bool IsSystem = false);
public record ExportDto(List<string> Formats);
public record UpdateRunResultDto(string Result);

public class RenameItemRequest
{
    public string FileName { get; set; } = string.Empty;
}
