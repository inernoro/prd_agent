using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.FileConvertAgent;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
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
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmCtx;

    public FileConvertController(
        MongoDbContext db,
        IAssetStorage storage,
        FileParserService parser,
        TemplateParserService templateParser,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmCtx,
        ILogger<FileConvertController> logger)
    {
        _db = db;
        _storage = storage;
        _parser = parser;
        _templateParser = templateParser;
        _gateway = gateway;
        _llmCtx = llmCtx;
        _logger = logger;
    }

    // ───────────────────────── 文件上传与解析 ─────────────────────────

    /// <summary>上传源文件并解析列名（临时存储，任务执行后自动清理）</summary>
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

        // 用 UploadToKeyAsync 存临时文件，key 可被 Worker 精确删除
        var ext = Path.GetExtension(file.FileName).TrimStart('.').ToLowerInvariant();
        var fileKey = $"file-convert/tmp/{Guid.NewGuid():N}/source.{ext}";
        var mime = file.ContentType ?? "application/octet-stream";
        await _storage.UploadToKeyAsync(fileKey, bytes, mime, CancellationToken.None);

        return Ok(new
        {
            fileKey,
            fileName = file.FileName,
            columns = result.Columns,
            previewRows = result.Rows.Take(3).ToList(),
            totalRows = result.Rows.Count
        });
    }

    /// <summary>上传模板文件并解析占位符（临时存储，任务执行后自动清理）</summary>
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

        var ext = Path.GetExtension(file.FileName).TrimStart('.').ToLowerInvariant();
        var fileKey = $"file-convert/tmp/{Guid.NewGuid():N}/template.{ext}";
        var mime = file.ContentType ?? "application/octet-stream";
        await _storage.UploadToKeyAsync(fileKey, bytes, mime, CancellationToken.None);

        return Ok(new
        {
            fileKey,
            fileName = file.FileName,
            placeholders = result.Placeholders
        });
    }

    // ───────────────────────── 任务管理 ─────────────────────────

    public record CreateTaskRequest(
        string SourceFileKey,
        string SourceFileName,
        /// <summary>template / expression</summary>
        string OutputMode,
        // ── template 模式 ──
        string? TemplateFileKey,
        string? TemplateFileName,
        List<FileConvertFieldMapping>? FieldMappings,
        // ── expression 模式 ──
        List<FileConvertOutputColumn>? OutputColumns,
        string? RuleId);

    /// <summary>创建批量转换任务（入队）</summary>
    [HttpPost("tasks")]
    public async Task<IActionResult> CreateTask([FromBody] CreateTaskRequest req)
    {
        var userId = this.GetRequiredUserId();

        if (req.OutputMode == FileConvertOutputMode.Expression)
        {
            if (req.OutputColumns == null || req.OutputColumns.Count == 0)
                return BadRequest(new { error = "expression 模式下输出列不能为空" });
        }
        else
        {
            if (req.FieldMappings == null || req.FieldMappings.Count == 0)
                return BadRequest(new { error = "template 模式下字段映射不能为空" });
            if (string.IsNullOrEmpty(req.TemplateFileKey))
                return BadRequest(new { error = "template 模式下模板文件不能为空" });
        }

        var task = new FileConvertTask
        {
            UserId = userId,
            SourceFileKey = req.SourceFileKey,
            SourceFileName = req.SourceFileName,
            OutputMode = req.OutputMode,
            TemplateFileKey = req.TemplateFileKey,
            TemplateFileName = req.TemplateFileName,
            FieldMappings = req.FieldMappings ?? new(),
            OutputColumns = req.OutputColumns ?? new(),
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
                        hasResult = !string.IsNullOrEmpty(task.ResultZipKey),
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
                hasResult = t.ResultZipKey != null && t.ResultZipKey != "",
                t.ErrorMessage,
                t.CreatedAt,
                t.UpdatedAt
            })
            .ToListAsync(CancellationToken.None);

        return Ok(tasks);
    }

    /// <summary>代理下载 ZIP，下载后删除存储文件（一次性下载）</summary>
    [HttpGet("tasks/{taskId}/download")]
    public async Task<IActionResult> DownloadResult(string taskId)
    {
        var userId = this.GetRequiredUserId();
        var task = await _db.FileConvertTasks
            .Find(t => t.Id == taskId && t.UserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (task == null) return NotFound(new { error = "任务不存在" });
        if (task.Status != FileConvertTaskStatus.Done || string.IsNullOrEmpty(task.ResultZipKey))
            return BadRequest(new { error = "任务尚未完成或结果不存在" });

        var bytes = await _storage.TryDownloadBytesAsync(task.ResultZipKey, CancellationToken.None);
        if (bytes == null) return NotFound(new { error = "ZIP 文件已过期，请重新生成" });

        // 下载后异步清理 ZIP（不阻塞响应）
        _ = Task.Run(async () =>
        {
            try { await _storage.DeleteByKeyAsync(task.ResultZipKey, CancellationToken.None); }
            catch (Exception ex) { _logger.LogWarning(ex, "[FileConvert] 清理 ZIP 失败 key={Key}", task.ResultZipKey); }

            // 同步更新任务状态，防止重复下载尝试误提示
            var filter = Builders<FileConvertTask>.Filter.Eq(t => t.Id, task.Id);
            var update = Builders<FileConvertTask>.Update
                .Unset(t => t.ResultZipKey)
                .Set(t => t.UpdatedAt, DateTime.UtcNow);
            try { await _db.FileConvertTasks.UpdateOneAsync(filter, update, cancellationToken: CancellationToken.None); }
            catch { /* ignore */ }
        });

        var zipName = $"result_{Path.GetFileNameWithoutExtension(task.SourceFileName)}_{task.CreatedAt:yyyyMMddHHmm}.zip";
        return File(bytes, "application/zip", zipName);
    }

    // ───────────────────────── 规则管理 ─────────────────────────

    public record SaveRuleRequest(
        string Name,
        string? Description,
        List<FileConvertFieldMapping> FieldMappings,
        string? LastSourceFileName,
        /// <summary>可选：将此临时模板 key 提升为永久存储并绑定到规则</summary>
        string? TempTemplateFileKey,
        string? TemplateFileName);

    /// <summary>保存规则（可选同时保存模板文件供下次复用）</summary>
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
            TemplateFileName = req.TemplateFileName,
        };

        // 若用户选择保存模板，将临时 Key 提升为规则永久 Key
        if (!string.IsNullOrWhiteSpace(req.TempTemplateFileKey) &&
            req.TempTemplateFileKey.StartsWith("file-convert/tmp/", StringComparison.OrdinalIgnoreCase))
        {
            var bytes = await _storage.TryDownloadBytesAsync(req.TempTemplateFileKey, CancellationToken.None);
            if (bytes != null)
            {
                var ext = Path.GetExtension(req.TemplateFileName ?? "template.docx").TrimStart('.').ToLowerInvariant();
                var permanentKey = $"file-convert/rules/{rule.Id}/template.{ext}";
                var mime = ext switch
                {
                    "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "csv" => "text/csv",
                    _ => "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                };
                await _storage.UploadToKeyAsync(permanentKey, bytes, mime, CancellationToken.None);
                rule.TemplateFileKey = permanentKey;

                // 删除临时文件（已转移）
                try { await _storage.DeleteByKeyAsync(req.TempTemplateFileKey, CancellationToken.None); }
                catch (Exception ex) { _logger.LogWarning(ex, "[FileConvert] 清理提升后临时模板失败"); }
            }
        }

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
                r.TemplateFileKey,
                r.TemplateFileName,
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

    /// <summary>删除规则（同时清理附带的永久模板文件）</summary>
    [HttpDelete("rules/{ruleId}")]
    public async Task<IActionResult> DeleteRule(string ruleId)
    {
        var userId = this.GetRequiredUserId();
        var filter = Builders<FileConvertRule>.Filter.And(
            Builders<FileConvertRule>.Filter.Eq(r => r.Id, ruleId),
            Builders<FileConvertRule>.Filter.Eq(r => r.UserId, userId));

        var rule = await _db.FileConvertRules.Find(filter).FirstOrDefaultAsync(CancellationToken.None);
        if (rule == null) return NotFound(new { error = "规则不存在" });

        await _db.FileConvertRules.DeleteOneAsync(filter, CancellationToken.None);

        // 清理规则附带的永久模板文件
        if (!string.IsNullOrWhiteSpace(rule.TemplateFileKey))
        {
            try { await _storage.DeleteByKeyAsync(rule.TemplateFileKey, CancellationToken.None); }
            catch (Exception ex) { _logger.LogWarning(ex, "[FileConvert] 清理规则模板失败 key={Key}", rule.TemplateFileKey); }
        }

        return Ok(new { ok = true });
    }

    // ───────────────────────── AI 规则建议 ─────────────────────────

    public record SuggestRulesRequest(
        List<string> Columns,
        List<Dictionary<string, string>> SampleRows,
        List<string> Placeholders);

    /// <summary>
    /// AI 分析原始数据，流式输出每个占位符的表达式建议
    /// SSE 格式：event: suggestion\ndata: {placeholder, expression, reason}
    /// </summary>
    [HttpPost("suggest-rules")]
    public async Task SuggestRules([FromBody] SuggestRulesRequest req)
    {
        var userId = this.GetRequiredUserId();
        Response.ContentType = "text/event-stream";
        Response.Headers["Cache-Control"] = "no-cache";
        Response.Headers["X-Accel-Buffering"] = "no";

        async Task SendAsync(string eventType, object data)
        {
            var json = JsonSerializer.Serialize(data);
            await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }

        try
        {
            await SendAsync("status", new { message = "AI 正在分析数据..." });

            // 构建数据样本描述
            var sampleSb = new StringBuilder();
            sampleSb.AppendLine("源文件列名：" + string.Join("、", req.Columns));
            sampleSb.AppendLine("样本数据（前3行）：");
            foreach (var row in req.SampleRows.Take(3))
            {
                var entries = req.Columns.Select(c => $"  {c}: {row.GetValueOrDefault(c, "")}");
                sampleSb.AppendLine(string.Join("\n", entries));
                sampleSb.AppendLine("---");
            }

            var placeholderList = string.Join("、", req.Placeholders);

            // $$""" = 双美元号 raw string：{x} 是字面量，{{x}} 才是插值
            var prompt = $$"""
你是数据处理专家。用户有一个源数据文件和一个目标模板。

{{sampleSb}}

目标模板需要填充的占位符：{{placeholderList}}

请为每个占位符写一个"值表达式"，告诉系统如何从源数据提取/转换内容。

值表达式语法规则（用 {列名} 引用列值）：
- 直接取值：{列名}
- 管道操作：{列名 | 操作}
  - url_last：取 URL 最后一段（如 https://x.com/abc/CODE 提取 CODE）
  - trim：去除首尾空格
  - upper / lower：大写/小写
  - regex: 正则：用正则提取第一个捕获组（如 regex: ([A-Z0-9]{16}$)）
  - split: 分隔符, N：按分隔符切割取第N段（如 split: /, 3）
  - replace: 旧, 新：替换字符串
- 多段拼接：{列A} {列B} 或 前缀-{列名}-后缀
- 管道可链式：{列名 | url_last | upper}

请对每个占位符输出 JSON（每行一个），格式：
{"placeholder": "占位符名", "expression": "值表达式", "reason": "一句话说明"}

不要包含 markdown 代码块，直接输出 JSON 行。
""";

            using var _ = _llmCtx.BeginScope(new LlmRequestContext(
                RequestId: Guid.NewGuid().ToString("N"),
                GroupId: null,
                SessionId: null,
                UserId: userId,
                ViewRole: null,
                DocumentChars: null,
                DocumentHash: null,
                SystemPromptRedacted: null,
                RequestType: "chat",
                AppCallerCode: $"{AppKey}.suggest-rules::chat"));

            var messages = new System.Text.Json.Nodes.JsonArray
            {
                new System.Text.Json.Nodes.JsonObject { ["role"] = "user", ["content"] = prompt }
            };

            var gatewayReq = new GatewayRequest
            {
                AppCallerCode = $"{AppKey}.suggest-rules::chat",
                ModelType = "chat",
                Stream = true,
                RequestBody = new System.Text.Json.Nodes.JsonObject
                {
                    ["messages"] = messages,
                    ["temperature"] = 0.3,
                },
            };

            var lineBuffer = new StringBuilder();
            await foreach (var chunk in _gateway.StreamAsync(gatewayReq, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    lineBuffer.Append(chunk.Content);
                    var text = lineBuffer.ToString();

                    // 尝试逐行解析 JSON 建议
                    var lines = text.Split('\n');
                    for (var i = 0; i < lines.Length - 1; i++)
                    {
                        var line = lines[i].Trim();
                        if (string.IsNullOrWhiteSpace(line)) continue;
                        try
                        {
                            var obj = JsonSerializer.Deserialize<JsonElement>(line);
                            if (obj.TryGetProperty("placeholder", out _))
                                await SendAsync("suggestion", obj);
                        }
                        catch { /* 非 JSON 行跳过 */ }
                    }
                    // 保留最后一行（可能不完整）
                    lineBuffer.Clear();
                    lineBuffer.Append(lines[^1]);
                }
            }

            // 处理最后一行
            if (lineBuffer.Length > 0)
            {
                var last = lineBuffer.ToString().Trim();
                if (!string.IsNullOrWhiteSpace(last))
                {
                    try
                    {
                        var obj = JsonSerializer.Deserialize<JsonElement>(last);
                        if (obj.TryGetProperty("placeholder", out _))
                            await SendAsync("suggestion", obj);
                    }
                    catch { /* ignore */ }
                }
            }

            await SendAsync("done", new { message = "建议生成完成" });
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[FileConvert] AI 建议规则失败");
            await Response.WriteAsync($"event: error\ndata: {{\"message\":\"{ex.Message}\"}}\n\n");
            await Response.Body.FlushAsync();
        }
    }

    // ───────────────────────── 工具 ─────────────────────────

    private static async Task<byte[]> ReadFormFileAsync(IFormFile file)
    {
        using var ms = new MemoryStream();
        await file.CopyToAsync(ms);
        return ms.ToArray();
    }
}
