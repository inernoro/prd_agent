using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services.FileConvertAgent;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;

namespace PrdAgent.Api.Controllers;

/// <summary>
/// 文件批量转换智能体（file-convert-agent）
/// 核心流程：上传源文件 → 上传模板 → 配置字段映射 → 批量生成目标文件 → 下载 ZIP
/// </summary>
[ApiController]
[Route("api/file-convert")]
[Authorize]
public class FileConvertController : ControllerBase
{
    private const string AppKey = "file-convert-agent";
    private const long MaxUploadBytes = 50 * 1024 * 1024; // 50 MB

    private readonly MongoDbContext _db;
    private readonly IAssetStorage _storage;
    private readonly FileParserService _parser;
    private readonly TemplateParserService _templateParser;
    private readonly ILogger<FileConvertController> _logger;

    public FileConvertController(
        MongoDbContext db,
        IAssetStorage storage,
        FileParserService parser,
        TemplateParserService templateParser,
        ILogger<FileConvertController> logger)
    {
        _db = db;
        _storage = storage;
        _parser = parser;
        _templateParser = templateParser;
        _logger = logger;
    }

    // ───────────────────────── 文件上传与解析 ─────────────────────────

    /// <summary>上传源文件并解析列名</summary>
    [HttpPost("parse-source")]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<IActionResult> ParseSource(IFormFile file)
    {
        if (file == null || file.Length == 0)
            return BadRequest(new { error = "请上传源文件" });

        var bytes = await ReadFormFileAsync(file);
        var result = await _parser.ParseAsync(bytes, file.FileName);
        if (!string.IsNullOrEmpty(result.Error))
            return BadRequest(new { error = result.Error });

        // 存储文件供后续生成任务使用
        var stored = await _storage.SaveAsync(bytes, file.ContentType ?? "application/octet-stream",
            CancellationToken.None, domain: "file-convert", type: "source", fileName: file.FileName);

        return Ok(new
        {
            fileUrl = stored.Url,
            fileName = file.FileName,
            columns = result.Columns,
            previewRows = result.Rows.Take(3).ToList(),
            totalRows = result.Rows.Count
        });
    }

    /// <summary>上传模板文件并解析占位符</summary>
    [HttpPost("parse-template")]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<IActionResult> ParseTemplate(IFormFile file)
    {
        if (file == null || file.Length == 0)
            return BadRequest(new { error = "请上传模板文件" });

        var bytes = await ReadFormFileAsync(file);
        var result = await _templateParser.ParseAsync(bytes, file.FileName);
        if (!string.IsNullOrEmpty(result.Error))
            return BadRequest(new { error = result.Error });

        var stored = await _storage.SaveAsync(bytes, file.ContentType ?? "application/octet-stream",
            CancellationToken.None, domain: "file-convert", type: "template", fileName: file.FileName);

        return Ok(new
        {
            fileUrl = stored.Url,
            fileName = file.FileName,
            placeholders = result.Placeholders
        });
    }

    // ───────────────────────── 任务管理 ─────────────────────────

    public record CreateTaskRequest(
        string SourceFileUrl,
        string SourceFileName,
        string TemplateFileUrl,
        string TemplateFileName,
        List<FileConvertFieldMapping> FieldMappings,
        string? RuleId);

    /// <summary>创建批量转换任务（入队）</summary>
    [HttpPost("tasks")]
    public async Task<IActionResult> CreateTask([FromBody] CreateTaskRequest req)
    {
        var userId = this.GetRequiredUserId();
        if (req.FieldMappings == null || req.FieldMappings.Count == 0)
            return BadRequest(new { error = "字段映射不能为空" });

        var task = new FileConvertTask
        {
            UserId = userId,
            SourceFileUrl = req.SourceFileUrl,
            SourceFileName = req.SourceFileName,
            TemplateFileUrl = req.TemplateFileUrl,
            TemplateFileName = req.TemplateFileName,
            FieldMappings = req.FieldMappings,
            RuleId = req.RuleId,
            Status = FileConvertTaskStatus.Queued,
        };

        await _db.FileConvertTasks.InsertOneAsync(task, cancellationToken: CancellationToken.None);
        _logger.LogInformation("[FileConvert] 新任务入队 {TaskId} userId={UserId}", task.Id, userId);

        return Ok(new { taskId = task.Id });
    }

    /// <summary>SSE：实时推送任务进度（轮询 DB，每秒一次，afterSeq 不支持则每次推全量日志）</summary>
    [HttpGet("tasks/{taskId}/progress")]
    public async Task GetProgress(string taskId, CancellationToken ct)
    {
        var userId = this.GetRequiredUserId();
        Response.ContentType = "text/event-stream";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";

        var lastLogCount = 0;

        async Task SendEventAsync(string eventType, object data)
        {
            var json = System.Text.Json.JsonSerializer.Serialize(data);
            await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n", ct);
            await Response.Body.FlushAsync(ct);
        }

        try
        {
            while (!ct.IsCancellationRequested)
            {
                var task = await _db.FileConvertTasks
                    .Find(t => t.Id == taskId && t.UserId == userId)
                    .FirstOrDefaultAsync(CancellationToken.None);

                if (task == null)
                {
                    await SendEventAsync("error", new { message = "任务不存在" });
                    break;
                }

                // 推送新日志行（增量）
                if (task.ProgressLogs.Count > lastLogCount)
                {
                    var newLogs = task.ProgressLogs.Skip(lastLogCount).ToList();
                    foreach (var log in newLogs)
                        await SendEventAsync("log", new { message = log });
                    lastLogCount = task.ProgressLogs.Count;
                }

                // 推送进度快照
                await SendEventAsync("progress", new
                {
                    status = task.Status,
                    totalRows = task.TotalRows,
                    processedRows = task.ProcessedRows,
                });

                if (task.Status is FileConvertTaskStatus.Done or FileConvertTaskStatus.Error)
                {
                    await SendEventAsync("done", new
                    {
                        status = task.Status,
                        resultZipUrl = task.ResultZipUrl,
                        errorMessage = task.ErrorMessage
                    });
                    break;
                }

                await SendEventAsync("heartbeat", new { ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds() });

                try { await Task.Delay(1000, ct); }
                catch (OperationCanceledException) { break; }
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[FileConvert] SSE 异常 taskId={TaskId}", taskId);
        }
    }

    /// <summary>获取任务列表（最近 20 条）</summary>
    [HttpGet("tasks")]
    public async Task<IActionResult> ListTasks()
    {
        var userId = this.GetRequiredUserId();
        var tasks = await _db.FileConvertTasks
            .Find(t => t.UserId == userId)
            .SortByDescending(t => t.CreatedAt)
            .Limit(20)
            .Project(t => new
            {
                t.Id,
                t.Status,
                t.SourceFileName,
                t.TemplateFileName,
                t.TotalRows,
                t.ProcessedRows,
                t.ResultZipUrl,
                t.ErrorMessage,
                t.CreatedAt,
                t.UpdatedAt
            })
            .ToListAsync(CancellationToken.None);

        return Ok(tasks);
    }

    /// <summary>代理下载 ZIP（通过后端中转，避免跨域问题）</summary>
    [HttpGet("tasks/{taskId}/download")]
    public async Task<IActionResult> DownloadResult(string taskId)
    {
        var userId = this.GetRequiredUserId();
        var task = await _db.FileConvertTasks
            .Find(t => t.Id == taskId && t.UserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (task == null) return NotFound(new { error = "任务不存在" });
        if (task.Status != FileConvertTaskStatus.Done || string.IsNullOrEmpty(task.ResultZipUrl))
            return BadRequest(new { error = "任务尚未完成或结果不存在" });

        var bytes = await _storage.TryDownloadBytesAsync(task.ResultZipUrl, CancellationToken.None);
        if (bytes == null) return NotFound(new { error = "ZIP 文件已过期，请重新生成" });

        var zipName = $"result_{task.SourceFileName}_{task.CreatedAt:yyyyMMddHHmm}.zip";
        return File(bytes, "application/zip", zipName);
    }

    // ───────────────────────── 规则管理 ─────────────────────────

    public record SaveRuleRequest(
        string Name,
        string? Description,
        List<FileConvertFieldMapping> FieldMappings,
        string? LastSourceFileName,
        string? LastTemplateFileName);

    /// <summary>保存规则</summary>
    [HttpPost("rules")]
    public async Task<IActionResult> SaveRule([FromBody] SaveRuleRequest req)
    {
        var userId = this.GetRequiredUserId();
        if (string.IsNullOrWhiteSpace(req.Name))
            return BadRequest(new { error = "规则名称不能为空" });
        if (req.FieldMappings == null || req.FieldMappings.Count == 0)
            return BadRequest(new { error = "字段映射不能为空" });

        var rule = new FileConvertRule
        {
            UserId = userId,
            Name = req.Name.Trim(),
            Description = req.Description?.Trim(),
            FieldMappings = req.FieldMappings,
            LastSourceFileName = req.LastSourceFileName,
            LastTemplateFileName = req.LastTemplateFileName,
        };

        await _db.FileConvertRules.InsertOneAsync(rule, cancellationToken: CancellationToken.None);
        return Ok(new { ruleId = rule.Id });
    }

    /// <summary>获取规则列表</summary>
    [HttpGet("rules")]
    public async Task<IActionResult> ListRules()
    {
        var userId = this.GetRequiredUserId();
        var rules = await _db.FileConvertRules
            .Find(r => r.UserId == userId)
            .SortByDescending(r => r.UpdatedAt)
            .Project(r => new
            {
                r.Id,
                r.Name,
                r.Description,
                r.FieldMappings,
                r.LastSourceFileName,
                r.LastTemplateFileName,
                r.CreatedAt,
                r.UpdatedAt
            })
            .ToListAsync(CancellationToken.None);

        return Ok(rules);
    }

    /// <summary>更新规则（重命名或更新映射）</summary>
    [HttpPut("rules/{ruleId}")]
    public async Task<IActionResult> UpdateRule(string ruleId, [FromBody] SaveRuleRequest req)
    {
        var userId = this.GetRequiredUserId();
        var filter = Builders<FileConvertRule>.Filter.And(
            Builders<FileConvertRule>.Filter.Eq(r => r.Id, ruleId),
            Builders<FileConvertRule>.Filter.Eq(r => r.UserId, userId));

        var update = Builders<FileConvertRule>.Update
            .Set(r => r.Name, req.Name.Trim())
            .Set(r => r.Description, req.Description?.Trim())
            .Set(r => r.FieldMappings, req.FieldMappings)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        var result = await _db.FileConvertRules.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None);
        if (result.MatchedCount == 0) return NotFound(new { error = "规则不存在" });

        return Ok(new { ok = true });
    }

    /// <summary>删除规则</summary>
    [HttpDelete("rules/{ruleId}")]
    public async Task<IActionResult> DeleteRule(string ruleId)
    {
        var userId = this.GetRequiredUserId();
        var filter = Builders<FileConvertRule>.Filter.And(
            Builders<FileConvertRule>.Filter.Eq(r => r.Id, ruleId),
            Builders<FileConvertRule>.Filter.Eq(r => r.UserId, userId));

        var result = await _db.FileConvertRules.DeleteOneAsync(filter, CancellationToken.None);
        if (result.DeletedCount == 0) return NotFound(new { error = "规则不存在" });

        return Ok(new { ok = true });
    }

    // ───────────────────────── 工具 ─────────────────────────

    private static async Task<byte[]> ReadFormFileAsync(IFormFile file)
    {
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        return ms.ToArray();
    }
}
