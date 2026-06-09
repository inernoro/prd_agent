using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.ChannelTraceAgent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 商品溯源智能体（appKey: channel-trace-agent）
///
/// 面向「防窜物流」领域的内部研发辅助智能体，三大能力：
///   1) 业务知识问答：基于知识库帮助快速理解防窜物流业务知识（SSE 流式）
///   2) 线上问题排查：记录常见线上问题，基于已有案例给出快速排查路径（SSE 流式）
///   3) 业务/代码差异对比：定向对比业务规则与当前代码实现的逻辑差异（SSE 流式）
///
/// SSE 采用内联模式 + keepalive 心跳（参照 ProjectRouteAgentController）。
/// </summary>
[ApiController]
[Route("api/channel-trace-agent")]
[Authorize]
[AdminController("channel-trace-agent", AdminPermissionCatalog.ChannelTraceAgentUse)]
public class ChannelTraceAgentController : ControllerBase
{
    private const string AppKey = "channel-trace-agent";

    /// <summary>注入知识库 / 案例库到提示词的字符预算（防止超长上下文）。</summary>
    private const int KnowledgeContextBudget = 60_000;
    private const int CaseContextBudget = 50_000;
    private const int CodeDiffInputBudget = 30_000;

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ChannelTraceCodeScanService _codeScan;
    private readonly ILogger<ChannelTraceAgentController> _logger;

    public ChannelTraceAgentController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ChannelTraceCodeScanService codeScan,
        ILogger<ChannelTraceAgentController> logger)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _codeScan = codeScan;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private string GetDisplayName()
        => User.FindFirst("displayName")?.Value
           ?? User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value
           ?? GetUserId();

    private bool HasManagePermission()
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(AdminPermissionCatalog.ChannelTraceAgentManage)
               || permissions.Contains(AdminPermissionCatalog.Super);
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
    };

    // ──────────────────────────────────────────────────────────────
    // 能力 1：防窜物流业务知识库（CRUD）
    // ──────────────────────────────────────────────────────────────

    [HttpGet("knowledge")]
    public async Task<IActionResult> ListKnowledge([FromQuery] string? keyword, CancellationToken ct)
    {
        var filter = Builders<ChannelTraceKnowledge>.Filter.Empty;
        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var kw = keyword.Trim();
            filter = Builders<ChannelTraceKnowledge>.Filter.Or(
                Builders<ChannelTraceKnowledge>.Filter.Regex(x => x.Title, new MongoDB.Bson.BsonRegularExpression(kw, "i")),
                Builders<ChannelTraceKnowledge>.Filter.Regex(x => x.Content, new MongoDB.Bson.BsonRegularExpression(kw, "i")));
        }
        var items = await _db.ChannelTraceKnowledge.Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(500)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    public class UpsertKnowledgeRequest
    {
        public string? Title { get; set; }
        public string? Content { get; set; }
        public List<string>? Tags { get; set; }
    }

    [HttpPost("knowledge")]
    public async Task<IActionResult> CreateKnowledge([FromBody] UpsertKnowledgeRequest req, CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "知识标题不能为空"));
        if (string.IsNullOrWhiteSpace(req.Content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "知识正文不能为空"));

        var userId = GetUserId();
        var now = DateTime.UtcNow;
        var entry = new ChannelTraceKnowledge
        {
            Title = req.Title.Trim(),
            Content = req.Content,
            Tags = NormalizeTags(req.Tags),
            CreatedBy = userId,
            CreatedByName = GetDisplayName(),
            UpdatedBy = userId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.ChannelTraceKnowledge.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { item = entry }));
    }

    public class ImportRequest
    {
        public string? AttachmentId { get; set; }
        public string? Title { get; set; }
        public List<string>? Tags { get; set; }
    }

    /// <summary>
    /// 从已上传附件导入一条业务知识：读取附件抽取出的文本作为正文（1 文件 = 1 条）。
    /// </summary>
    [HttpPost("knowledge/import")]
    public async Task<IActionResult> ImportKnowledge([FromBody] ImportRequest req, CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.AttachmentId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "attachmentId 不能为空"));

        var userId = GetUserId();
        var attachment = await _db.Attachments
            .Find(x => x.AttachmentId == req.AttachmentId && x.UploaderId == userId)
            .FirstOrDefaultAsync(ct);
        if (attachment == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "附件不存在或不属于当前用户"));
        if (string.IsNullOrWhiteSpace(attachment.ExtractedText))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无法从文件中提取文本内容，请确认上传的是可解析的文档"));

        var now = DateTime.UtcNow;
        var entry = new ChannelTraceKnowledge
        {
            Title = string.IsNullOrWhiteSpace(req.Title) ? StripExtension(attachment.FileName) : req.Title.Trim(),
            Content = attachment.ExtractedText,
            Tags = NormalizeTags(req.Tags),
            CreatedBy = userId,
            CreatedByName = GetDisplayName(),
            UpdatedBy = userId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.ChannelTraceKnowledge.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { item = entry }));
    }

    [HttpPut("knowledge/{id}")]
    public async Task<IActionResult> UpdateKnowledge(string id, [FromBody] UpsertKnowledgeRequest req, CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Title) || string.IsNullOrWhiteSpace(req.Content))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "标题与正文均不能为空"));

        var entry = await _db.ChannelTraceKnowledge.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "知识条目不存在"));
        if (entry.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权编辑此知识条目"));

        entry.Title = req.Title.Trim();
        entry.Content = req.Content;
        entry.Tags = NormalizeTags(req.Tags);
        entry.UpdatedBy = GetUserId();
        entry.UpdatedAt = DateTime.UtcNow;
        await _db.ChannelTraceKnowledge.ReplaceOneAsync(x => x.Id == id, entry, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { item = entry }));
    }

    [HttpDelete("knowledge/{id}")]
    public async Task<IActionResult> DeleteKnowledge(string id, CancellationToken ct)
    {
        var entry = await _db.ChannelTraceKnowledge.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "知识条目不存在"));
        if (entry.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权删除此知识条目"));

        await _db.ChannelTraceKnowledge.DeleteOneAsync(x => x.Id == id, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    public class AskKnowledgeRequest
    {
        public string? Question { get; set; }
    }

    /// <summary>
    /// 业务知识问答（SSE 流式）。事件：model / typing / done / error。
    /// </summary>
    [HttpPost("knowledge/ask")]
    [Produces("text/event-stream")]
    public async Task AskKnowledge([FromBody] AskKnowledgeRequest req)
    {
        var userId = GetUserId();
        await RunSseAsync(async writeEvent =>
        {
            if (req == null || string.IsNullOrWhiteSpace(req.Question))
            {
                await writeEvent("error", new { message = "请输入问题" });
                return;
            }

            var entries = await _db.ChannelTraceKnowledge.Find(Builders<ChannelTraceKnowledge>.Filter.Empty)
                .SortByDescending(x => x.UpdatedAt)
                .Limit(500)
                .ToListAsync(CancellationToken.None);

            var kbContext = BuildKnowledgeContext(entries, KnowledgeContextBudget);

            var systemPrompt =
                "你是「商品溯源智能体」中的防窜物流业务知识助手。你的职责是帮助研发 / 运营 / 测试人员快速理解防窜物流业务知识。\n" +
                "回答要求：\n" +
                " - 优先依据下方「业务知识库」内容作答，引用到的要点尽量贴合原文术语\n" +
                " - 知识库未覆盖时，可结合通用领域常识补充，但必须明确标注「（知识库未收录，以下为通用理解）」\n" +
                " - 用中文回答，结构清晰（必要时分点 / 小标题），先给结论再展开\n" +
                " - 涉及流程的，按「上码 → 关联 → 出入库 → 流通 → 窜货判定」之类的链路顺序讲清楚\n" +
                (string.IsNullOrWhiteSpace(kbContext)
                    ? " - 当前知识库为空，请提示用户先在「业务知识」标签维护知识，并基于通用理解谨慎作答\n"
                    : "");

            var userPrompt = new StringBuilder();
            if (!string.IsNullOrWhiteSpace(kbContext))
            {
                userPrompt.AppendLine("===== 防窜物流业务知识库 =====");
                userPrompt.AppendLine(kbContext);
                userPrompt.AppendLine();
            }
            userPrompt.AppendLine("===== 用户问题 =====");
            userPrompt.AppendLine(req.Question.Trim());

            await writeEvent("phase", new { phase = "answering", message = "AI 正在检索业务知识并作答…" });
            await StreamChatAsync(writeEvent, userId, systemPrompt, userPrompt.ToString(),
                AppCallerRegistry.ChannelTraceAgent.Knowledge.Chat);
            await writeEvent("done", new { });
        });
    }

    // ──────────────────────────────────────────────────────────────
    // 能力 2：线上问题案例库（CRUD + 智能排查）
    // ──────────────────────────────────────────────────────────────

    [HttpGet("cases")]
    public async Task<IActionResult> ListCases([FromQuery] string? keyword, CancellationToken ct)
    {
        var filter = Builders<ChannelTraceCase>.Filter.Empty;
        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var kw = keyword.Trim();
            filter = Builders<ChannelTraceCase>.Filter.Or(
                Builders<ChannelTraceCase>.Filter.Regex(x => x.Title, new MongoDB.Bson.BsonRegularExpression(kw, "i")),
                Builders<ChannelTraceCase>.Filter.Regex(x => x.Symptom, new MongoDB.Bson.BsonRegularExpression(kw, "i")));
        }
        var items = await _db.ChannelTraceCases.Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(500)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    public class UpsertCaseRequest
    {
        public string? Title { get; set; }
        public string? Symptom { get; set; }
        public string? RootCause { get; set; }
        public string? Resolution { get; set; }
        public List<string>? Tags { get; set; }
        public string? Severity { get; set; }
    }

    [HttpPost("cases")]
    public async Task<IActionResult> CreateCase([FromBody] UpsertCaseRequest req, CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "案例标题不能为空"));
        if (string.IsNullOrWhiteSpace(req.Symptom))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "问题现象不能为空"));

        var userId = GetUserId();
        var now = DateTime.UtcNow;
        var entry = new ChannelTraceCase
        {
            Title = req.Title.Trim(),
            Symptom = req.Symptom.Trim(),
            RootCause = string.IsNullOrWhiteSpace(req.RootCause) ? null : req.RootCause.Trim(),
            Resolution = string.IsNullOrWhiteSpace(req.Resolution) ? null : req.Resolution.Trim(),
            Tags = NormalizeTags(req.Tags),
            Severity = NormalizeSeverity(req.Severity),
            CreatedBy = userId,
            CreatedByName = GetDisplayName(),
            UpdatedBy = userId,
            CreatedAt = now,
            UpdatedAt = now,
        };
        await _db.ChannelTraceCases.InsertOneAsync(entry, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { item = entry }));
    }

    /// <summary>
    /// 从已上传附件导入线上问题案例（SSE 流式）：AI 把历史 bug 文档解析为多条结构化案例并入库。
    /// 事件：phase / model / case（每解析出一条）/ done / error。
    /// </summary>
    [HttpPost("cases/import")]
    [Produces("text/event-stream")]
    public async Task ImportCases([FromBody] ImportRequest req)
    {
        var userId = GetUserId();
        await RunSseAsync(async writeEvent =>
        {
            if (req == null || string.IsNullOrWhiteSpace(req.AttachmentId))
            {
                await writeEvent("error", new { message = "attachmentId 不能为空" });
                return;
            }

            var attachment = await _db.Attachments
                .Find(x => x.AttachmentId == req.AttachmentId && x.UploaderId == userId)
                .FirstOrDefaultAsync(CancellationToken.None);
            if (attachment == null)
            {
                await writeEvent("error", new { message = "附件不存在或不属于当前用户" });
                return;
            }
            if (string.IsNullOrWhiteSpace(attachment.ExtractedText))
            {
                await writeEvent("error", new { message = "无法从文件中提取文本内容" });
                return;
            }

            // 大文件（如 93 条缺陷汇总）一次性让模型输出整段 JSON 会超 max_tokens 被截断 →
            // JSON 解析失败 → 整体导入失败，且非流式等待很久。改为「分段解析 + 逐条入库 + 增量进度」：
            // 每段独立调用，单段失败只跳过该段不影响其它段，避免长时间空白与一损俱损。
            var text = Truncate(attachment.ExtractedText, 200_000);
            var chunks = SplitIntoChunks(text, 6000);

            var systemPrompt =
                "你是「商品溯源智能体」的案例整理助手。下面是一份「历史线上问题/缺陷文档」的**一个片段**，" +
                "请只把该片段中**确实描述了的具体线上问题**解析为结构化案例；统计/概述/目录类内容没有具体问题就返回空数组。\n" +
                "每条案例字段：title（一句话标题）、symptom（问题现象）、rootCause（根因，可空）、resolution（排查步骤/解决方案，可空）、tags（字符串数组）、severity（low/medium/high）。\n" +
                "规则：忠实于原文，不要编造原文没有的根因或解决方案（缺失就留空）。\n" +
                "严格只输出一个 JSON 对象，UTF-8，禁止 markdown 代码围栏：{ \"cases\": [ { ... } ] }";

            await writeEvent("phase", new { phase = "parsing", message = $"文件已切分为 {chunks.Count} 段，开始逐段解析…" });

            var now = DateTime.UtcNow;
            var displayName = GetDisplayName();
            var inserted = 0;
            var sentModel = false;
            var anyChunkSucceeded = false;

            for (var ci = 0; ci < chunks.Count; ci++)
            {
                await writeEvent("phase", new
                {
                    phase = "parsing",
                    message = $"正在解析第 {ci + 1}/{chunks.Count} 段…（已入库 {inserted} 条）",
                });

                string? content = null;
                string? model = null, platform = null;
                try
                {
                    using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                        RequestId: Guid.NewGuid().ToString("N"),
                        GroupId: null, SessionId: null, UserId: userId, ViewRole: null,
                        DocumentChars: chunks[ci].Length, DocumentHash: null,
                        SystemPromptRedacted: AppCallerRegistry.ChannelTraceAgent.CaseImport.Chat,
                        RequestType: "chat",
                        AppCallerCode: AppCallerRegistry.ChannelTraceAgent.CaseImport.Chat));

                    var resp = await _gateway.SendAsync(new GatewayRequest
                    {
                        AppCallerCode = AppCallerRegistry.ChannelTraceAgent.CaseImport.Chat,
                        ModelType = ModelTypes.Chat,
                        RequestBody = new JsonObject
                        {
                            ["messages"] = new JsonArray
                            {
                                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                                new JsonObject { ["role"] = "user", ["content"] = chunks[ci] },
                            },
                            ["temperature"] = 0.2,
                            ["max_tokens"] = 4000,
                        },
                        TimeoutSeconds = 120,
                    }, CancellationToken.None);

                    model = string.IsNullOrEmpty(resp.Resolution?.ActualModel) ? null : resp.Resolution!.ActualModel;
                    platform = resp.Resolution?.ActualPlatformName;
                    if (resp.Success && !string.IsNullOrWhiteSpace(resp.Content))
                    {
                        content = resp.Content;
                        anyChunkSucceeded = true;
                    }
                    else
                    {
                        _logger.LogWarning("[ChannelTraceAgent] case import chunk {Idx} failed: {Err}", ci, resp.ErrorMessage);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[ChannelTraceAgent] case import chunk {Idx} exception", ci);
                }

                if (content == null) continue;

                if (!sentModel && !string.IsNullOrEmpty(model))
                {
                    sentModel = true;
                    await writeEvent("model", new { model, platform });
                }

                foreach (var c in ParseCasesJson(content))
                {
                    c.Tags = NormalizeTags(c.Tags);
                    c.Tags.Add("导入");
                    c.Tags = c.Tags.Distinct().ToList();
                    c.Severity = NormalizeSeverity(c.Severity);
                    c.CreatedBy = userId;
                    c.CreatedByName = displayName;
                    c.UpdatedBy = userId;
                    c.CreatedAt = now;
                    c.UpdatedAt = now;
                    await _db.ChannelTraceCases.InsertOneAsync(c, cancellationToken: CancellationToken.None);
                    inserted++;
                    await writeEvent("case", new { id = c.Id, title = c.Title, severity = c.Severity, index = inserted });
                }
            }

            if (inserted == 0)
            {
                await writeEvent("error", new
                {
                    message = anyChunkSucceeded
                        ? "未能从文件中解析出任何线上问题案例（文件可能只含统计/概述，没有具体问题清单）"
                        : "AI 解析失败，请稍后重试或更换更清晰的文件",
                });
                return;
            }

            await writeEvent("done", new { count = inserted });
        });
    }

    [HttpPut("cases/{id}")]
    public async Task<IActionResult> UpdateCase(string id, [FromBody] UpsertCaseRequest req, CancellationToken ct)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Title) || string.IsNullOrWhiteSpace(req.Symptom))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "标题与现象均不能为空"));

        var entry = await _db.ChannelTraceCases.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "案例不存在"));
        if (entry.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权编辑此案例"));

        entry.Title = req.Title.Trim();
        entry.Symptom = req.Symptom.Trim();
        entry.RootCause = string.IsNullOrWhiteSpace(req.RootCause) ? null : req.RootCause.Trim();
        entry.Resolution = string.IsNullOrWhiteSpace(req.Resolution) ? null : req.Resolution.Trim();
        entry.Tags = NormalizeTags(req.Tags);
        entry.Severity = NormalizeSeverity(req.Severity);
        entry.UpdatedBy = GetUserId();
        entry.UpdatedAt = DateTime.UtcNow;
        await _db.ChannelTraceCases.ReplaceOneAsync(x => x.Id == id, entry, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { item = entry }));
    }

    [HttpDelete("cases/{id}")]
    public async Task<IActionResult> DeleteCase(string id, CancellationToken ct)
    {
        var entry = await _db.ChannelTraceCases.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (entry == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "案例不存在"));
        if (entry.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权删除此案例"));

        await _db.ChannelTraceCases.DeleteOneAsync(x => x.Id == id, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ── 线上问题对话式诊断（多轮会话：案例召回 + 代码定位 + 模糊时引导补齐）──

    [HttpGet("diagnose/sessions")]
    public async Task<IActionResult> ListDiagnoseSessions(CancellationToken ct)
    {
        var userId = GetUserId();
        var items = await _db.ChannelTraceDiagnoseSessions
            .Find(x => x.CreatedBy == userId)
            .SortByDescending(x => x.UpdatedAt)
            .Limit(100)
            .ToListAsync(ct);
        // 列表只回摘要，不带完整 messages，省带宽
        var summaries = items.Select(s => new
        {
            id = s.Id,
            title = s.Title,
            messageCount = s.Messages.Count,
            createdAt = s.CreatedAt,
            updatedAt = s.UpdatedAt,
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items = summaries }));
    }

    [HttpGet("diagnose/sessions/{id}")]
    public async Task<IActionResult> GetDiagnoseSession(string id, CancellationToken ct)
    {
        var session = await _db.ChannelTraceDiagnoseSessions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (session == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "会话不存在"));
        if (session.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权访问"));
        return Ok(ApiResponse<object>.Ok(new { item = session }));
    }

    [HttpDelete("diagnose/sessions/{id}")]
    public async Task<IActionResult> DeleteDiagnoseSession(string id, CancellationToken ct)
    {
        var session = await _db.ChannelTraceDiagnoseSessions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (session == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "会话不存在"));
        if (session.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权删除"));
        await _db.ChannelTraceDiagnoseSessions.DeleteOneAsync(x => x.Id == id, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    public class DiagnoseAskRequest
    {
        /// <summary>已有会话 id；为空时新建会话</summary>
        public string? SessionId { get; set; }
        public string? Message { get; set; }
    }

    /// <summary>
    /// 线上问题对话式诊断（SSE 流式，多轮）。每轮：召回历史案例 + 扫描内置仓库代码 →
    /// AI 给出初步原因/建议；信息不足以定位时主动发澄清问题引导用户补齐。
    /// 事件：session / relatedCases / codeHits / model / typing / done / error。
    /// </summary>
    [HttpPost("diagnose/ask")]
    [Produces("text/event-stream")]
    public async Task DiagnoseAsk([FromBody] DiagnoseAskRequest req)
    {
        var userId = GetUserId();
        await RunSseAsync(async writeEvent =>
        {
            if (req == null || string.IsNullOrWhiteSpace(req.Message))
            {
                await writeEvent("error", new { message = "请输入问题描述" });
                return;
            }
            var message = req.Message.Trim();

            // 1. 取/建会话
            ChannelTraceDiagnoseSession? session = null;
            if (!string.IsNullOrWhiteSpace(req.SessionId))
            {
                session = await _db.ChannelTraceDiagnoseSessions.Find(x => x.Id == req.SessionId).FirstOrDefaultAsync(CancellationToken.None);
                if (session != null && session.CreatedBy != userId && !HasManagePermission())
                {
                    await writeEvent("error", new { message = "无权访问该会话" });
                    return;
                }
            }
            var isNew = session == null;
            if (session == null)
            {
                session = new ChannelTraceDiagnoseSession
                {
                    Title = message.Length > 30 ? message[..30] + "…" : message,
                    CreatedBy = userId,
                    CreatedByName = GetDisplayName(),
                };
            }

            session.Messages.Add(new ChannelTraceDiagnoseMessage { Role = "user", Content = message });
            await writeEvent("session", new { sessionId = session.Id, isNew });

            // 2. 历史案例召回（用全部用户轮次的描述做召回，信息越补越准）
            var problemText = string.Join("\n", session.Messages.Where(m => m.Role == "user").Select(m => m.Content));
            var allCases = await _db.ChannelTraceCases.Find(Builders<ChannelTraceCase>.Filter.Empty)
                .SortByDescending(x => x.UpdatedAt)
                .Limit(500)
                .ToListAsync(CancellationToken.None);
            var ranked = RankCasesByRelevance(allCases, problemText, 8);
            await writeEvent("relatedCases", new
            {
                items = ranked.Select(c => new { id = c.Id, title = c.Title, severity = c.Severity, tags = c.Tags }).ToList(),
            });
            var caseContext = BuildCaseContext(ranked, CaseContextBudget);

            // 3. 代码定位（best-effort：克隆+扫描内置仓库；无 token 或失败则跳过）
            var hits = new List<ChannelTraceCodeHit>();
            if (_codeScan.GetGitHubToken() != null)
            {
                try
                {
                    await writeEvent("phase", new { phase = "scanning", message = "正在到内置仓库定位相关代码…" });
                    var keywords = await ExtractKeywordsAsync(userId, problemText);
                    var repoResults = await _codeScan.EnsureReposAsync(CancellationToken.None);
                    foreach (var r in repoResults.Where(r => r.Dir != null))
                        hits.AddRange(_codeScan.SearchRepo(r.Name, r.Dir!, keywords));
                    hits = hits.OrderByDescending(h => h.Score).Take(12).ToList();
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "[ChannelTraceAgent] diagnose code scan skipped");
                }
            }
            if (hits.Count > 0)
            {
                await writeEvent("codeHits", new
                {
                    items = hits.Select(h => new { repo = h.Repo, path = h.Path, score = h.Score }).ToList(),
                });
            }

            // 4. 组装多轮消息
            var systemPrompt =
                "你是「商品溯源智能体」中的防窜物流线上问题诊断助手，采用多轮对话逐步定位问题。每轮请遵循：\n" +
                " 1. 先看「历史案例库」是否命中相似问题（命中就标注是哪条案例标题）；\n" +
                " 2. 结合「命中代码」分析可能原因，给出初步判断 + 可执行的排查建议；\n" +
                " 3. 若现有信息不足以确定根因，**只问 1~2 个最关键的澄清问题**（如复现步骤、报错原文、涉及的码/批次/环境、时间点），用「## 还需要你补充」小节列出，引导用户逐步补齐信息链条；\n" +
                " 4. 信息足够时，给出「## 定位结论」+ 根因 + 修复建议（涉及代码时标注仓库/文件路径）。\n" +
                "严禁编造历史案例或代码里不存在的内容；不确定就明说并继续追问。全程中文 Markdown。";

            var contextNote = new StringBuilder();
            contextNote.AppendLine("【本轮检索到的上下文，仅供你参考，不要原样复述】");
            contextNote.AppendLine("== 历史案例库召回 ==");
            contextNote.AppendLine(string.IsNullOrWhiteSpace(caseContext) ? "（无命中）" : caseContext);
            contextNote.AppendLine();
            contextNote.AppendLine("== 内置仓库命中代码 ==");
            contextNote.AppendLine(hits.Count == 0 ? "（未扫描到相关代码或未配置仓库访问）" : BuildCodeContext(hits, CodeDiffInputBudget));

            var messages = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "system", ["content"] = contextNote.ToString() },
            };
            foreach (var m in session.Messages)
                messages.Add(new JsonObject { ["role"] = m.Role == "assistant" ? "assistant" : "user", ["content"] = m.Content });

            await writeEvent("phase", new { phase = "diagnosing", message = "AI 正在分析并定位问题…" });

            try
            {
                var (fullText, model, platform) = await StreamChatMessagesAsync(
                    writeEvent, userId, messages, AppCallerRegistry.ChannelTraceAgent.Diagnose.Chat);

                session.Messages.Add(new ChannelTraceDiagnoseMessage
                {
                    Role = "assistant",
                    Content = fullText,
                    RelatedCaseIds = ranked.Select(c => c.Id).ToList(),
                    CodeHits = hits,
                    Model = model,
                    ModelPlatform = platform,
                });
                session.UpdatedAt = DateTime.UtcNow;

                if (isNew)
                    await _db.ChannelTraceDiagnoseSessions.InsertOneAsync(session, cancellationToken: CancellationToken.None);
                else
                    await _db.ChannelTraceDiagnoseSessions.ReplaceOneAsync(x => x.Id == session.Id, session, cancellationToken: CancellationToken.None);

                await writeEvent("done", new { sessionId = session.Id, model, platform });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[ChannelTraceAgent] diagnose ask failed");
                await writeEvent("error", new { message = "诊断失败：" + ex.Message });
            }
        });
    }

    // ──────────────────────────────────────────────────────────────
    // 能力 3：业务规则 vs 代码实现差异对比（CRUD + SSE 对比）
    // ──────────────────────────────────────────────────────────────

    [HttpGet("diffs")]
    public async Task<IActionResult> ListDiffs([FromQuery] int page = 1, [FromQuery] int pageSize = 50, CancellationToken ct = default)
    {
        var userId = GetUserId();
        var filter = HasManagePermission()
            ? Builders<ChannelTraceDiff>.Filter.Empty
            : Builders<ChannelTraceDiff>.Filter.Eq(x => x.CreatedBy, userId);
        var total = await _db.ChannelTraceDiffs.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.ChannelTraceDiffs.Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);
        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    [HttpGet("diffs/{id}")]
    public async Task<IActionResult> GetDiff(string id, CancellationToken ct)
    {
        var diff = await _db.ChannelTraceDiffs.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (diff == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "对比记录不存在"));
        if (diff.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权访问"));
        return Ok(ApiResponse<object>.Ok(new { item = diff }));
    }

    [HttpDelete("diffs/{id}")]
    public async Task<IActionResult> DeleteDiff(string id, CancellationToken ct)
    {
        var diff = await _db.ChannelTraceDiffs.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (diff == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "对比记录不存在"));
        if (diff.CreatedBy != GetUserId() && !HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权删除"));

        await _db.ChannelTraceDiffs.DeleteOneAsync(x => x.Id == id, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    public class CompareDiffRequest
    {
        public string? Title { get; set; }
        /// <summary>用户对功能的具体描述（新版主输入）。</summary>
        public string? FeatureDescription { get; set; }
        /// <summary>兼容旧字段名。</summary>
        public string? BusinessRule { get; set; }
    }

    /// <summary>查看内置仓库配置（前端展示「将扫描哪些仓库」）。</summary>
    [HttpGet("diffs/repos")]
    public IActionResult GetCodeScanRepos()
    {
        var repos = _codeScan.GetConfiguredRepos()
            .Select(r => new { name = r.Name, branch = string.IsNullOrWhiteSpace(r.Branch) ? "master" : r.Branch })
            .ToList();
        return Ok(ApiResponse<object>.Ok(new { repos, tokenConfigured = _codeScan.GetGitHubToken() != null }));
    }

    /// <summary>
    /// 描述驱动的「业务功能 vs 代码实现」异同分析（SSE 流式 + 落库）。
    /// 子 agent 流程：抽关键词 → 克隆并扫描内置两个仓库 → 命中代码 → AI 对比描述与代码异同。
    /// 事件：diff / keywords / repos / codeHits / model / typing / done / error。
    /// </summary>
    [HttpPost("diffs/compare")]
    [Produces("text/event-stream")]
    public async Task CompareDiff([FromBody] CompareDiffRequest req)
    {
        var userId = GetUserId();
        await RunSseAsync(async writeEvent =>
        {
            var description = (req?.FeatureDescription ?? req?.BusinessRule ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(description))
            {
                await writeEvent("error", new { message = "请具体描述要对比的功能" });
                return;
            }
            description = Truncate(description, CodeDiffInputBudget);

            var diff = new ChannelTraceDiff
            {
                Title = string.IsNullOrWhiteSpace(req?.Title) ? "未命名对比" : req!.Title!.Trim(),
                BusinessRule = description,
                Status = ChannelTraceDiffStatuses.Running,
                CreatedBy = userId,
                CreatedByName = GetDisplayName(),
                CreatedAt = DateTime.UtcNow,
            };
            await _db.ChannelTraceDiffs.InsertOneAsync(diff, cancellationToken: CancellationToken.None);
            await writeEvent("diff", new { id = diff.Id, title = diff.Title });

            try
            {
                // ===== 1. 抽取检索关键词 =====
                await writeEvent("phase", new { phase = "keywords", message = "子 agent 正在从描述中抽取检索关键词…" });
                var keywords = await ExtractKeywordsAsync(userId, description);
                diff.Keywords = keywords;
                await writeEvent("keywords", new { keywords });

                // ===== 2. 克隆并扫描内置仓库 =====
                await writeEvent("phase", new { phase = "scanning", message = "子 agent 正在克隆并扫描内置仓库…" });
                var repoResults = await _codeScan.EnsureReposAsync(CancellationToken.None);
                await writeEvent("repos", new
                {
                    items = repoResults.Select(r => new
                    {
                        name = r.Name,
                        branch = r.Branch,
                        ok = r.Dir != null,
                        error = r.Error,
                    }).ToList(),
                });

                var usableRepos = repoResults.Where(r => r.Dir != null).ToList();
                if (usableRepos.Count == 0)
                {
                    var errs = string.Join("；", repoResults.Select(r => $"{r.Name}: {r.Error}"));
                    var hint = _codeScan.GetGitHubToken() == null
                        ? "（未配置服务级 GitHub PAT，请在部署环境注入密钥 ChannelTrace__GitHubToken）"
                        : "（请确认该 PAT 有 MiDouTech 组织仓库访问权限）";
                    throw new InvalidOperationException($"内置仓库克隆失败{hint}：{errs}");
                }

                var hits = new List<ChannelTraceCodeHit>();
                foreach (var r in usableRepos)
                    hits.AddRange(_codeScan.SearchRepo(r.Name, r.Dir!, keywords));
                hits = hits.OrderByDescending(h => h.Score).Take(16).ToList();

                diff.ScannedRepos = usableRepos.Select(r => $"{r.Name}@{r.Branch}").ToList();
                diff.CodeHits = hits;
                await writeEvent("codeHits", new
                {
                    items = hits.Select(h => new { repo = h.Repo, path = h.Path, score = h.Score }).ToList(),
                });

                // ===== 3. 组装代码上下文 + AI 异同分析 =====
                var codeContext = BuildCodeContext(hits, CodeDiffInputBudget);
                diff.CodeContent = codeContext;

                var systemPrompt =
                    "你是「商品溯源智能体」中的防窜物流业务/代码一致性审计助手。用户描述了一个功能的期望行为，子 agent 已从内置仓库（" +
                    string.Join(", ", diff.ScannedRepos) +
                    "）按关键词扫描出相关代码片段。请对比「用户描述的功能」与「实际代码实现」的异同。\n" +
                    "输出结构（中文 Markdown）：\n" +
                    " ## 总体结论\n 一句话判断（高度一致 / 部分偏差 / 严重不一致 / 代码中未找到相关实现）。\n" +
                    " ## 代码中的实现\n 根据命中片段，概述代码实际是怎么做的（标注涉及的仓库/文件路径）。\n" +
                    " ## 与描述一致的点\n 逐条。\n" +
                    " ## 差异 / 缺失\n 描述要求但代码未实现或实现不同的点（指出文件路径 + 差在哪 + 可能后果）。\n" +
                    " ## 代码额外行为\n 代码做了但描述未提及的逻辑。\n" +
                    " ## 建议\n 按优先级排序。\n" +
                    "严格基于给定代码片段判断；片段不足以判断时明确写「命中代码不足，无法确认」，不要编造未出现的代码逻辑。";

                var userPrompt = new StringBuilder();
                userPrompt.AppendLine("===== 用户描述的功能（期望行为）=====");
                userPrompt.AppendLine(description);
                userPrompt.AppendLine();
                userPrompt.AppendLine("===== 子 agent 扫描命中的代码片段 =====");
                userPrompt.AppendLine(string.IsNullOrWhiteSpace(codeContext) ? "（未命中相关代码）" : codeContext);

                await writeEvent("phase", new { phase = "comparing", message = "AI 正在对比功能描述与代码实现…" });
                var (fullText, model, platform) = await StreamChatAsync(
                    writeEvent, userId, systemPrompt, userPrompt.ToString(),
                    AppCallerRegistry.ChannelTraceAgent.CodeDiff.Chat);

                diff.DiffReport = fullText;
                diff.Model = model;
                diff.ModelPlatform = platform;
                diff.Status = ChannelTraceDiffStatuses.Done;
                diff.CompletedAt = DateTime.UtcNow;
                await _db.ChannelTraceDiffs.ReplaceOneAsync(x => x.Id == diff.Id, diff, cancellationToken: CancellationToken.None);
                await writeEvent("done", new { id = diff.Id, model = diff.Model, platform = diff.ModelPlatform });
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[ChannelTraceAgent] code diff failed: {DiffId}", diff.Id);
                diff.Status = ChannelTraceDiffStatuses.Error;
                diff.ErrorMessage = ex.Message;
                diff.CompletedAt = DateTime.UtcNow;
                await _db.ChannelTraceDiffs.ReplaceOneAsync(x => x.Id == diff.Id, diff, cancellationToken: CancellationToken.None);
                await writeEvent("error", new { message = "对比失败：" + ex.Message });
            }
        });
    }

    /// <summary>调用 LLM 从功能描述中抽取代码检索关键词（非流式 + JSON 解析），失败时回退到本地分词。</summary>
    private async Task<List<string>> ExtractKeywordsAsync(string userId, string description)
    {
        try
        {
            using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
                RequestId: Guid.NewGuid().ToString("N"),
                GroupId: null, SessionId: null, UserId: userId, ViewRole: null,
                DocumentChars: description.Length, DocumentHash: null,
                SystemPromptRedacted: AppCallerRegistry.ChannelTraceAgent.CodeDiff.Keywords,
                RequestType: "chat",
                AppCallerCode: AppCallerRegistry.ChannelTraceAgent.CodeDiff.Keywords));

            var resp = await _gateway.SendAsync(new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.ChannelTraceAgent.CodeDiff.Keywords,
                ModelType = ModelTypes.Chat,
                RequestBody = new JsonObject
                {
                    ["messages"] = new JsonArray
                    {
                        new JsonObject
                        {
                            ["role"] = "system",
                            ["content"] = "从用户的功能描述中抽取 5~12 个用于在代码仓库里检索的关键词（类名/方法名/表名/业务术语/英文标识符优先，中文术语也可）。" +
                                          "严格只输出 JSON：{\"keywords\":[\"...\"]}，不要解释，不要 markdown 围栏。",
                        },
                        new JsonObject { ["role"] = "user", ["content"] = description },
                    },
                    ["temperature"] = 0.1,
                    ["max_tokens"] = 400,
                },
                TimeoutSeconds = 60,
            }, CancellationToken.None);

            if (resp.Success && !string.IsNullOrWhiteSpace(resp.Content))
            {
                var parsed = JsonNode.Parse(StripCodeFence(resp.Content!));
                if (parsed is JsonObject obj && obj["keywords"] is JsonArray arr)
                {
                    var kws = arr.Where(n => n != null)
                        .Select(n => n!.ToString().Trim())
                        .Where(s => s.Length >= 2)
                        .Distinct()
                        .Take(12)
                        .ToList();
                    if (kws.Count > 0) return kws;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ChannelTraceAgent] keyword extraction failed, fallback to local tokenize");
        }
        return Tokenize(description).Take(12).ToList();
    }

    private static string BuildCodeContext(IReadOnlyList<ChannelTraceCodeHit> hits, int budget)
    {
        var sb = new StringBuilder();
        foreach (var h in hits)
        {
            var block = $"--- [{h.Repo}] {h.Path} (score={h.Score}) ---\n{h.Snippet}\n\n";
            if (sb.Length + block.Length > budget) break;
            sb.Append(block);
        }
        return sb.ToString().TrimEnd();
    }

    private static string StripExtension(string fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName)) return "导入知识";
        var dot = fileName.LastIndexOf('.');
        return dot > 0 ? fileName[..dot] : fileName;
    }

    private static string StripCodeFence(string s)
    {
        var t = s.Trim();
        if (t.StartsWith("```"))
        {
            var nl = t.IndexOf('\n');
            if (nl > 0) t = t[(nl + 1)..];
            if (t.EndsWith("```")) t = t[..^3];
        }
        return t.Trim();
    }

    /// <summary>从可能含前后噪声的文本中截取第一个 '{' 到最后一个 '}' 的 JSON 对象子串。</summary>
    private static string ExtractJsonObject(string s)
    {
        var start = s.IndexOf('{');
        var end = s.LastIndexOf('}');
        return start >= 0 && end > start ? s.Substring(start, end - start + 1) : s;
    }

    /// <summary>
    /// 把长文本按目标字符数切分成若干段，优先在 Markdown 标题 / 空行 / 换行边界断开，
    /// 避免把一条问题切成两半。用于大文件导入时分段喂给 LLM。
    /// </summary>
    private static List<string> SplitIntoChunks(string text, int targetChars)
    {
        var lines = text.Replace("\r\n", "\n").Split('\n');
        var chunks = new List<string>();
        var sb = new StringBuilder();
        foreach (var line in lines)
        {
            // 已积累到目标长度，且当前行是新的标题/分隔，则在此切段（保证段落完整）
            if (sb.Length >= targetChars &&
                (line.StartsWith("#") || line.StartsWith("---") || line.Trim().Length == 0))
            {
                if (sb.Length > 0) { chunks.Add(sb.ToString()); sb.Clear(); }
            }
            sb.Append(line).Append('\n');
            // 硬上限兜底：单行极长或一直没遇到边界时强制切，防止单段超模型上下文
            if (sb.Length >= targetChars * 2)
            {
                chunks.Add(sb.ToString());
                sb.Clear();
            }
        }
        if (sb.Length > 0) chunks.Add(sb.ToString());
        return chunks.Count == 0 ? new List<string> { text } : chunks;
    }

    private List<ChannelTraceCase> ParseCasesJson(string content)
    {
        var result = new List<ChannelTraceCase>();
        try
        {
            var stripped = StripCodeFence(content);
            JsonNode? parsed;
            try { parsed = JsonNode.Parse(stripped); }
            catch { parsed = JsonNode.Parse(ExtractJsonObject(stripped)); } // 容错：截取首尾花括号内的 JSON
            if (parsed is JsonObject obj && obj["cases"] is JsonArray arr)
            {
                foreach (var node in arr)
                {
                    if (node is not JsonObject c) continue;
                    var title = c["title"]?.GetValue<string>()?.Trim();
                    var symptom = c["symptom"]?.GetValue<string>()?.Trim();
                    if (string.IsNullOrWhiteSpace(title) || string.IsNullOrWhiteSpace(symptom)) continue;
                    var tags = new List<string>();
                    if (c["tags"] is JsonArray ta)
                        tags = ta.Where(n => n != null).Select(n => n!.ToString().Trim()).Where(s => s.Length > 0).ToList();
                    result.Add(new ChannelTraceCase
                    {
                        Title = title,
                        Symptom = symptom,
                        RootCause = c["rootCause"]?.GetValue<string>()?.Trim(),
                        Resolution = c["resolution"]?.GetValue<string>()?.Trim(),
                        Tags = tags,
                        Severity = c["severity"]?.GetValue<string>()?.Trim() ?? ChannelTraceCaseSeverities.Medium,
                    });
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "[ChannelTraceAgent] parse cases json failed");
        }
        return result;
    }

    // ──────────────────────────────────────────────────────────────
    // SSE + LLM 公共逻辑
    // ──────────────────────────────────────────────────────────────

    /// <summary>
    /// 通用 SSE 包装：设置响应头 + keepalive 心跳 + 串行写锁，把 WriteEvent 委托交给业务回调。
    /// </summary>
    private async Task RunSseAsync(Func<Func<string, object, Task>, Task> body)
    {
        Response.Headers["Content-Type"] = "text/event-stream; charset=utf-8";
        Response.Headers["Cache-Control"] = "no-cache, no-transform";
        Response.Headers["X-Accel-Buffering"] = "no";

        using var writeLock = new SemaphoreSlim(1, 1);

        async Task WriteEvent(string evt, object data)
        {
            await writeLock.WaitAsync(CancellationToken.None);
            try
            {
                var json = JsonSerializer.Serialize(data, JsonOpts);
                var bytes = Encoding.UTF8.GetBytes($"event: {evt}\ndata: {json}\n\n");
                await Response.Body.WriteAsync(bytes, CancellationToken.None);
                await Response.Body.FlushAsync(CancellationToken.None);
            }
            catch (OperationCanceledException) { /* 客户端断开 */ }
            catch (ObjectDisposedException) { /* response 已关闭 */ }
            catch (IOException) { /* 客户端断开 */ }
            finally
            {
                try { writeLock.Release(); } catch { /* disposed */ }
            }
        }

        using var heartbeatCts = new CancellationTokenSource();
        var heartbeatTask = Task.Run(async () =>
        {
            var beat = Encoding.UTF8.GetBytes(": keepalive\n\n");
            while (!heartbeatCts.IsCancellationRequested)
            {
                try { await Task.Delay(TimeSpan.FromSeconds(8), heartbeatCts.Token); }
                catch (OperationCanceledException) { break; }

                await writeLock.WaitAsync(CancellationToken.None);
                try
                {
                    await Response.Body.WriteAsync(beat, CancellationToken.None);
                    await Response.Body.FlushAsync(CancellationToken.None);
                }
                catch (OperationCanceledException) { break; }
                catch (ObjectDisposedException) { break; }
                catch (IOException) { break; }
                catch (Exception) { break; }
                finally
                {
                    try { writeLock.Release(); } catch { /* disposed */ }
                }
            }
        }, heartbeatCts.Token);

        try
        {
            await body(WriteEvent);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[ChannelTraceAgent] SSE body failed");
            try { await WriteEvent("error", new { message = ex.Message }); } catch { /* ignore */ }
        }
        finally
        {
            heartbeatCts.Cancel();
            try { await heartbeatTask; }
            catch (OperationCanceledException) { /* 预期 */ }
            catch (Exception ex) { _logger.LogDebug(ex, "[ChannelTraceAgent] heartbeat ended with error"); }
        }
    }

    /// <summary>
    /// 调用 LLM Gateway 做一次流式对话：推送 model + typing 事件，返回累计全文 + 实际模型信息。
    /// 异常向上抛给调用方处理（如更新落库状态）。
    /// </summary>
    private async Task<(string Text, string? Model, string? Platform)> StreamChatAsync(
        Func<string, object, Task> writeEvent,
        string userId,
        string systemPrompt,
        string userPrompt,
        string appCallerCode)
    {
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: systemPrompt.Length + userPrompt.Length,
            DocumentHash: null,
            SystemPromptRedacted: appCallerCode,
            RequestType: "chat",
            AppCallerCode: appCallerCode));

        var messages = new JsonArray
        {
            new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
            new JsonObject { ["role"] = "user", ["content"] = userPrompt },
        };
        return await StreamChatMessagesAsync(writeEvent, userId, messages, appCallerCode);
    }

    /// <summary>
    /// 多轮消息版流式对话：直接传入完整 messages 数组（用于对话式诊断）。
    /// 推送 model + typing 事件，返回累计全文 + 实际模型信息；异常向上抛。
    /// </summary>
    private async Task<(string Text, string? Model, string? Platform)> StreamChatMessagesAsync(
        Func<string, object, Task> writeEvent,
        string userId,
        JsonArray messages,
        string appCallerCode)
    {
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: messages.Count,
            DocumentHash: null,
            SystemPromptRedacted: appCallerCode,
            RequestType: "chat",
            AppCallerCode: appCallerCode));

        var body = new JsonObject
        {
            ["messages"] = messages,
            ["temperature"] = 0.3,
        };

        var sb = new StringBuilder();
        string? model = null;
        string? platform = null;
        var sentModel = false;

        await foreach (var chunk in _gateway.StreamAsync(new GatewayRequest
        {
            AppCallerCode = appCallerCode,
            ModelType = ModelTypes.Chat,
            Stream = true,
            RequestBody = body,
            TimeoutSeconds = 180,
        }, CancellationToken.None))
        {
            if (chunk.Type == GatewayChunkType.Start && !sentModel && chunk.Resolution != null)
            {
                sentModel = true;
                model = chunk.Resolution.ActualModel;
                platform = chunk.Resolution.ActualPlatformName;
                await writeEvent("model", new { model, platform });
            }
            else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
            {
                sb.Append(chunk.Content);
                await writeEvent("typing", new { text = chunk.Content });
            }
            else if (chunk.Type == GatewayChunkType.Error)
            {
                throw new InvalidOperationException(chunk.Error ?? chunk.Content ?? "LLM 网关返回未知错误");
            }
        }

        return (sb.ToString(), model, platform);
    }

    // ──────────────────────────────────────────────────────────────
    // 工具方法
    // ──────────────────────────────────────────────────────────────

    private static List<string> NormalizeTags(List<string>? tags)
        => (tags ?? new List<string>())
            .Where(t => !string.IsNullOrWhiteSpace(t))
            .Select(t => t.Trim())
            .Distinct()
            .Take(20)
            .ToList();

    private static string NormalizeSeverity(string? severity)
        => severity?.Trim().ToLowerInvariant() switch
        {
            "low" => ChannelTraceCaseSeverities.Low,
            "high" => ChannelTraceCaseSeverities.High,
            _ => ChannelTraceCaseSeverities.Medium,
        };

    private static string Truncate(string value, int limit)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        return value.Length <= limit ? value : value[..limit] + "\n…(内容过长已截断)";
    }

    private static string BuildKnowledgeContext(List<ChannelTraceKnowledge> entries, int budget)
    {
        var sb = new StringBuilder();
        foreach (var e in entries)
        {
            var block = $"### {e.Title}" +
                        (e.Tags.Count > 0 ? $"  [标签: {string.Join(", ", e.Tags)}]" : "") +
                        "\n" + e.Content + "\n\n";
            if (sb.Length + block.Length > budget) break;
            sb.Append(block);
        }
        return sb.ToString().TrimEnd();
    }

    private static string BuildCaseContext(List<ChannelTraceCase> cases, int budget)
    {
        var sb = new StringBuilder();
        foreach (var c in cases)
        {
            var block = new StringBuilder();
            block.AppendLine($"### 案例：{c.Title}（严重度: {c.Severity}{(c.Tags.Count > 0 ? ", 标签: " + string.Join(", ", c.Tags) : "")}）");
            block.AppendLine($"- 现象：{c.Symptom}");
            if (!string.IsNullOrWhiteSpace(c.RootCause)) block.AppendLine($"- 根因：{c.RootCause}");
            if (!string.IsNullOrWhiteSpace(c.Resolution)) block.AppendLine($"- 排查/解决：{c.Resolution}");
            block.AppendLine();
            if (sb.Length + block.Length > budget) break;
            sb.Append(block);
        }
        return sb.ToString().TrimEnd();
    }

    /// <summary>朴素中文/英文词重合度召回：统计 query 中 2-gram 在案例文本中的命中数量排序。</summary>
    private static List<ChannelTraceCase> RankCasesByRelevance(List<ChannelTraceCase> cases, string query, int topN)
    {
        var tokens = Tokenize(query);
        if (tokens.Count == 0)
            return cases.Take(topN).ToList();

        return cases
            .Select(c =>
            {
                var haystack = (c.Title + " " + c.Symptom + " " + (c.RootCause ?? "") + " " + string.Join(" ", c.Tags)).ToLowerInvariant();
                var score = tokens.Count(t => haystack.Contains(t));
                return (Case: c, Score: score);
            })
            .Where(x => x.Score > 0)
            .OrderByDescending(x => x.Score)
            .ThenByDescending(x => x.Case.UpdatedAt)
            .Take(topN)
            .Select(x => x.Case)
            .ToList();
    }

    private static List<string> Tokenize(string text)
    {
        var lower = text.ToLowerInvariant();
        var result = new HashSet<string>();
        // 英文/数字按空白与标点分词
        var ascii = new StringBuilder();
        foreach (var ch in lower)
        {
            if (char.IsLetterOrDigit(ch) && ch < 128) ascii.Append(ch);
            else { if (ascii.Length >= 2) result.Add(ascii.ToString()); ascii.Clear(); }
        }
        if (ascii.Length >= 2) result.Add(ascii.ToString());

        // 中文按 2-gram 切分
        var cjk = lower.Where(c => c >= 0x4e00 && c <= 0x9fff).ToArray();
        for (var i = 0; i + 1 < cjk.Length; i++)
            result.Add(new string(new[] { cjk[i], cjk[i + 1] }));

        return result.ToList();
    }
}
