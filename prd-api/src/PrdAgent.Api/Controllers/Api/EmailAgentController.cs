using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 邮件模板智能体（email-agent）
/// 核心：把常用流程（审批 / 申请 / 汇报 / 通知 / 交接）的邮件写法沉淀成模板库，
/// 每个模板含内容描述（审批对象 + 正文）、发送对象、抄送对象、可微调的占位符变量。
/// 一键复制成品后填几个变量即可发送，省去每次咨询相关人员 / 翻历史邮件 / 问 AI 的时间。
/// 另提供 AI 起草 / 润色两个 SSE 流式能力（基于现有模板库上下文生成）。
/// </summary>
[ApiController]
[Route("api/email-agent")]
[Authorize]
[AdminController("email-agent", AdminPermissionCatalog.EmailAgentUse)]
public class EmailAgentController : ControllerBase
{
    private const string AppKey = "email-agent";
    private const string AuthorName = "魏喜胜";

    /// <summary>系统预置模板 Id 前缀（区分 DB 里的用户模板）</summary>
    private const string SystemIdPrefix = "sys:";

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILLMRequestContextAccessor _llmRequestContext;
    private readonly ILogger<EmailAgentController> _logger;

    public EmailAgentController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<EmailAgentController> logger)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    /// <summary>从 JWT claims 中尽力取一个可读的用户名（找不到返回 null，仅用于展示快照）。</summary>
    private string? GetUserDisplayName()
    {
        var name = User.FindFirst("displayName")?.Value
            ?? User.FindFirst("name")?.Value
            ?? User.FindFirst("username")?.Value
            ?? User.FindFirst(System.Security.Claims.ClaimTypes.Name)?.Value;
        return string.IsNullOrWhiteSpace(name) ? null : name.Trim();
    }

    // ──────────────────────────────────────────────
    // 元数据：分类清单 + 作者 + 系统模板数量
    // ──────────────────────────────────────────────

    [HttpGet("meta")]
    public IActionResult GetMeta()
    {
        return Ok(ApiResponse<object>.Ok(new
        {
            categories = EmailTemplateCategory.All
                .Select(k => new { key = k, label = EmailTemplateCategory.Labels[k] })
                .ToArray(),
            systemTemplateCount = SystemEmailTemplates.GetAll().Count,
            authorName = AuthorName,
        }));
    }

    // ──────────────────────────────────────────────
    // 模板库 CRUD
    // ──────────────────────────────────────────────

    /// <summary>
    /// 列出模板：系统预置（代码内置）+ 当前用户自建（DB），可按分类 / 关键词过滤。
    /// 排序：系统模板在前按复用量，用户模板按更新时间倒序。
    /// </summary>
    [HttpGet("templates")]
    public async Task<IActionResult> ListTemplates(
        [FromQuery] string? category,
        [FromQuery] string? keyword)
    {
        var userId = GetUserId();

        var mine = await _db.EmailTemplates
            .Find(t => t.CreatedBy == userId)
            .SortByDescending(t => t.UpdatedAt)
            .ToListAsync();

        var system = BuildSystemTemplates();

        var all = new List<EmailTemplate>();
        all.AddRange(system);
        all.AddRange(mine);

        IEnumerable<EmailTemplate> filtered = all;

        if (EmailTemplateCategory.IsValid(category))
        {
            filtered = filtered.Where(t => t.Category == category);
        }

        if (!string.IsNullOrWhiteSpace(keyword))
        {
            var kw = keyword.Trim();
            filtered = filtered.Where(t =>
                (t.Title?.Contains(kw, StringComparison.OrdinalIgnoreCase) ?? false) ||
                (t.Scenario?.Contains(kw, StringComparison.OrdinalIgnoreCase) ?? false) ||
                (t.Subject?.Contains(kw, StringComparison.OrdinalIgnoreCase) ?? false) ||
                (t.Body?.Contains(kw, StringComparison.OrdinalIgnoreCase) ?? false));
        }

        var items = filtered.ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            items,
            total = items.Count,
        }));
    }

    [HttpGet("templates/{id}")]
    public async Task<IActionResult> GetTemplate(string id)
    {
        var tpl = await ResolveTemplateAsync(id, GetUserId());
        if (tpl == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "模板不存在或无权访问"));
        }
        return Ok(ApiResponse<object>.Ok(new { template = tpl }));
    }

    public class UpsertTemplateRequest
    {
        public string Title { get; set; } = string.Empty;
        public string Category { get; set; } = EmailTemplateCategory.Other;
        public string? Scenario { get; set; }
        public string Subject { get; set; } = string.Empty;
        public string? ApprovalTarget { get; set; }
        public string Body { get; set; } = string.Empty;
        public List<EmailRecipient>? ToRecipients { get; set; }
        public List<EmailRecipient>? CcRecipients { get; set; }
        public List<EmailTemplateVariable>? Variables { get; set; }
    }

    [HttpPost("templates")]
    public async Task<IActionResult> CreateTemplate([FromBody] UpsertTemplateRequest req)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Title))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "模板名称不能为空"));
        }

        var userId = GetUserId();
        var displayName = GetUserDisplayName();

        var tpl = new EmailTemplate
        {
            Title = req.Title.Trim(),
            Category = EmailTemplateCategory.IsValid(req.Category) ? req.Category : EmailTemplateCategory.Other,
            Scenario = req.Scenario?.Trim(),
            Subject = req.Subject?.Trim() ?? string.Empty,
            ApprovalTarget = req.ApprovalTarget?.Trim(),
            Body = req.Body ?? string.Empty,
            ToRecipients = SanitizeRecipients(req.ToRecipients),
            CcRecipients = SanitizeRecipients(req.CcRecipients),
            Variables = SanitizeVariables(req.Variables),
            IsSystem = false,
            CreatedBy = userId,
            CreatedByName = displayName,
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };

        await _db.EmailTemplates.InsertOneAsync(tpl);
        return Ok(ApiResponse<object>.Ok(new { template = tpl }));
    }

    [HttpPut("templates/{id}")]
    public async Task<IActionResult> UpdateTemplate(string id, [FromBody] UpsertTemplateRequest req)
    {
        if (req == null || string.IsNullOrWhiteSpace(req.Title))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.CONTENT_EMPTY, "模板名称不能为空"));
        }
        if (IsSystemId(id))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "系统模板不可编辑，请先「另存为」生成你的副本"));
        }

        var userId = GetUserId();
        var existing = await _db.EmailTemplates.Find(t => t.Id == id && t.CreatedBy == userId).FirstOrDefaultAsync();
        if (existing == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "模板不存在或无权操作"));
        }

        var update = Builders<EmailTemplate>.Update
            .Set(t => t.Title, req.Title.Trim())
            .Set(t => t.Category, EmailTemplateCategory.IsValid(req.Category) ? req.Category : EmailTemplateCategory.Other)
            .Set(t => t.Scenario, req.Scenario?.Trim())
            .Set(t => t.Subject, req.Subject?.Trim() ?? string.Empty)
            .Set(t => t.ApprovalTarget, req.ApprovalTarget?.Trim())
            .Set(t => t.Body, req.Body ?? string.Empty)
            .Set(t => t.ToRecipients, SanitizeRecipients(req.ToRecipients))
            .Set(t => t.CcRecipients, SanitizeRecipients(req.CcRecipients))
            .Set(t => t.Variables, SanitizeVariables(req.Variables))
            .Set(t => t.UpdatedAt, DateTime.UtcNow);

        await _db.EmailTemplates.UpdateOneAsync(t => t.Id == id, update);
        var updated = await _db.EmailTemplates.Find(t => t.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { template = updated }));
    }

    [HttpDelete("templates/{id}")]
    public async Task<IActionResult> DeleteTemplate(string id)
    {
        if (IsSystemId(id))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "系统模板不可删除"));
        }
        var userId = GetUserId();
        var res = await _db.EmailTemplates.DeleteOneAsync(t => t.Id == id && t.CreatedBy == userId);
        if (res.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "模板不存在或无权操作"));
        }
        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 另存为副本：系统模板 / 他人以外的任意可读模板 → 复制成一份归属当前用户的可编辑模板。
    /// </summary>
    [HttpPost("templates/{id}/duplicate")]
    public async Task<IActionResult> DuplicateTemplate(string id)
    {
        var userId = GetUserId();
        var src = await ResolveTemplateAsync(id, userId);
        if (src == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "模板不存在或无权访问"));
        }

        var copy = new EmailTemplate
        {
            Title = src.Title + "（副本）",
            Category = src.Category,
            Scenario = src.Scenario,
            Subject = src.Subject,
            ApprovalTarget = src.ApprovalTarget,
            Body = src.Body,
            ToRecipients = src.ToRecipients ?? new(),
            CcRecipients = src.CcRecipients ?? new(),
            Variables = src.Variables ?? new(),
            IsSystem = false,
            CreatedBy = userId,
            CreatedByName = GetUserDisplayName(),
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow,
        };

        await _db.EmailTemplates.InsertOneAsync(copy);
        return Ok(ApiResponse<object>.Ok(new { template = copy }));
    }

    /// <summary>
    /// 复用打点：一键复制时调用，用户模板 usageCount +1（系统模板无副作用，直接返回）。
    /// </summary>
    [HttpPost("templates/{id}/use")]
    public async Task<IActionResult> MarkUsed(string id)
    {
        if (IsSystemId(id))
        {
            return Ok(ApiResponse<object>.Ok(new { usageCount = 0, system = true }));
        }
        var userId = GetUserId();
        var update = Builders<EmailTemplate>.Update.Inc(t => t.UsageCount, 1);
        var res = await _db.EmailTemplates.UpdateOneAsync(t => t.Id == id && t.CreatedBy == userId, update);
        if (res.MatchedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "模板不存在或无权操作"));
        }
        var updated = await _db.EmailTemplates.Find(t => t.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { usageCount = updated?.UsageCount ?? 0 }));
    }

    // ──────────────────────────────────────────────
    // AI 起草（SSE 流式）
    // ──────────────────────────────────────────────

    public class DraftRequest
    {
        /// <summary>场景描述（必填）：要写一封什么邮件、给谁、要点</summary>
        public string Scenario { get; set; } = string.Empty;

        /// <summary>可选：参考的模板 Id（系统或用户），会把该模板作为写法参考注入</summary>
        public string? BaseTemplateId { get; set; }

        /// <summary>可选：语气偏好（正式 / 简洁 / 委婉 等）</summary>
        public string? Tone { get; set; }

        /// <summary>会话 ID（日志关联）</summary>
        public string? SessionId { get; set; }
    }

    [HttpPost("draft/stream")]
    [Produces("text/event-stream")]
    public async Task DraftStream([FromBody] DraftRequest req, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();

        if (req == null || string.IsNullOrWhiteSpace(req.Scenario))
        {
            await WriteSseAsync("error", new { message = "请先描述要写的邮件场景（scenario 不能为空）" });
            return;
        }

        var systemPrompt = new StringBuilder();
        systemPrompt.AppendLine("你是一名资深职场邮件写作助手，服务中文办公场景。");
        systemPrompt.AppendLine("请根据用户描述的场景，起草一封结构完整、语气得体、可直接发送的邮件。");
        systemPrompt.AppendLine("严格按以下 Markdown 结构输出，不要输出任何多余解释：");
        systemPrompt.AppendLine("**主题**：<邮件主题>");
        systemPrompt.AppendLine("**收件人**：<建议的发送对象，用角色或姓名，逗号分隔>");
        systemPrompt.AppendLine("**抄送**：<建议的抄送对象；没有就写「无」>");
        systemPrompt.AppendLine("**正文**：");
        systemPrompt.AppendLine("<含称呼、正文、落款的完整正文；换行用真实换行>");
        systemPrompt.AppendLine();
        systemPrompt.AppendLine("要求：正文分段清晰、称呼与落款齐全、无 emoji、不杜撰具体数字或姓名（未知处用【】占位提示用户填写）。");
        if (!string.IsNullOrWhiteSpace(req.Tone))
        {
            systemPrompt.AppendLine($"语气偏好：{req.Tone.Trim()}。");
        }

        // 可选：注入一个参考模板，让 AI 贴合组织既有写法
        if (!string.IsNullOrWhiteSpace(req.BaseTemplateId))
        {
            var baseTpl = await ResolveTemplateAsync(req.BaseTemplateId.Trim(), userId);
            if (baseTpl != null)
            {
                systemPrompt.AppendLine();
                systemPrompt.AppendLine("以下是同类场景的参考模板（可借鉴其结构与措辞，但要贴合用户本次场景）：");
                systemPrompt.AppendLine("---");
                systemPrompt.AppendLine($"主题：{baseTpl.Subject}");
                if (!string.IsNullOrWhiteSpace(baseTpl.ApprovalTarget))
                    systemPrompt.AppendLine($"内容描述：{baseTpl.ApprovalTarget}");
                systemPrompt.AppendLine($"正文：\n{baseTpl.Body}");
                systemPrompt.AppendLine("---");
            }
        }

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.EmailAgent.Draft.Chat,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = false,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt.ToString() },
                    new JsonObject { ["role"] = "user", ["content"] = req.Scenario.Trim() },
                },
                ["temperature"] = 0.4,
                ["max_tokens"] = 4096,
            },
        };

        await StreamToClientAsync(gatewayRequest, userId, req.Scenario.Length, "[EMAIL_DRAFT]", AppCallerRegistry.EmailAgent.Draft.Chat);
    }

    // ──────────────────────────────────────────────
    // AI 润色（SSE 流式）
    // ──────────────────────────────────────────────

    public class PolishRequest
    {
        /// <summary>当前邮件正文 / 全文（必填）</summary>
        public string Content { get; set; } = string.Empty;

        /// <summary>润色指令（可空，默认整体润色）</summary>
        public string? Instruction { get; set; }

        /// <summary>会话 ID（日志关联）</summary>
        public string? SessionId { get; set; }
    }

    [HttpPost("polish/stream")]
    [Produces("text/event-stream")]
    public async Task PolishStream([FromBody] PolishRequest req, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();

        if (req == null || string.IsNullOrWhiteSpace(req.Content))
        {
            await WriteSseAsync("error", new { message = "请先填写要润色的邮件内容（content 不能为空）" });
            return;
        }

        var instruction = string.IsNullOrWhiteSpace(req.Instruction)
            ? "整体润色：让语气更得体、表达更专业清晰，保留原意与关键信息。"
            : req.Instruction.Trim();

        var systemPrompt = new StringBuilder();
        systemPrompt.AppendLine("你是一名资深职场邮件写作助手。请按用户指令润色下面这封邮件，直接输出润色后的完整邮件正文。");
        systemPrompt.AppendLine("要求：保留原有关键信息与占位符（如【】、{{}}），不新增杜撰的具体数字/姓名，不输出任何解释说明，无 emoji。");

        var userPrompt = new StringBuilder();
        userPrompt.AppendLine("# 润色指令");
        userPrompt.AppendLine(instruction);
        userPrompt.AppendLine();
        userPrompt.AppendLine("# 原邮件内容");
        userPrompt.AppendLine("---");
        userPrompt.AppendLine(req.Content.Trim());
        userPrompt.AppendLine("---");

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.EmailAgent.Polish.Chat,
            ModelType = ModelTypes.Chat,
            Stream = true,
            IncludeThinking = false,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt.ToString() },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt.ToString() },
                },
                ["temperature"] = 0.3,
                ["max_tokens"] = 4096,
            },
        };

        await StreamToClientAsync(gatewayRequest, userId, req.Content.Length, "[EMAIL_POLISH]", AppCallerRegistry.EmailAgent.Polish.Chat);
    }

    // ──────────────────────────────────────────────
    // 共用：LLM 流式转发到 SSE（model / phase / typing / done / error）
    // ──────────────────────────────────────────────

    private async Task StreamToClientAsync(
        GatewayRequest gatewayRequest,
        string userId,
        int documentChars,
        string promptTag,
        string appCallerCode)
    {
        using var _ = _llmRequestContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: documentChars,
            DocumentHash: null,
            SystemPromptRedacted: promptTag,
            RequestType: "chat",
            AppCallerCode: appCallerCode));

        await WriteSseAsync("phase", new { phase = "preparing", message = "准备中..." });

        var sentModelEvent = false;
        var startedAt = DateTime.UtcNow;

        try
        {
            await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
            {
                if (chunk.Type == GatewayChunkType.Start && !sentModelEvent && chunk.Resolution != null)
                {
                    sentModelEvent = true;
                    await WriteSseAsync("model", new
                    {
                        model = chunk.Resolution.ActualModel,
                        platform = chunk.Resolution.ActualPlatformName,
                    });
                    await WriteSseAsync("phase", new { phase = "generating", message = "AI 正在撰写..." });
                }
                else if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                {
                    try { await WriteSseAsync("typing", new { text = chunk.Content }); }
                    catch (ObjectDisposedException) { break; }
                }
                else if (chunk.Type == GatewayChunkType.Error)
                {
                    var err = chunk.Error ?? chunk.Content ?? "网关返回未知错误";
                    _logger.LogError("EmailAgent 网关错误 user={UserId}: {Error}", userId, err);
                    try { await WriteSseAsync("error", new { message = $"LLM 网关错误: {err}" }); }
                    catch { }
                    return;
                }
            }

            try
            {
                await WriteSseAsync("done", new { elapsedMs = (int)(DateTime.UtcNow - startedAt).TotalMilliseconds });
            }
            catch (ObjectDisposedException) { }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "EmailAgent 生成失败 user={UserId}", userId);
            try { await WriteSseAsync("error", new { message = "生成失败：" + ex.Message }); } catch { }
        }
    }

    // ──────────────────────────────────────────────
    // 辅助方法
    // ──────────────────────────────────────────────

    private static bool IsSystemId(string? id) =>
        !string.IsNullOrEmpty(id) && id.StartsWith(SystemIdPrefix, StringComparison.Ordinal);

    /// <summary>系统预置模板：给每个填上稳定的 sys: 前缀 Id + 作者名，供前端统一渲染。</summary>
    private static List<EmailTemplate> BuildSystemTemplates()
    {
        var list = SystemEmailTemplates.GetAll();
        foreach (var t in list)
        {
            t.Id = SystemIdPrefix + (t.TemplateKey ?? Guid.NewGuid().ToString("N"));
            t.CreatedByName = AuthorName;
        }
        return list;
    }

    /// <summary>按 Id 解析模板：sys: 前缀 → 系统模板；否则查当前用户的 DB 模板。</summary>
    private async Task<EmailTemplate?> ResolveTemplateAsync(string id, string userId)
    {
        if (IsSystemId(id))
        {
            var key = id.Substring(SystemIdPrefix.Length);
            return BuildSystemTemplates().FirstOrDefault(t => t.TemplateKey == key);
        }
        return await _db.EmailTemplates.Find(t => t.Id == id && t.CreatedBy == userId).FirstOrDefaultAsync();
    }

    private static List<EmailRecipient> SanitizeRecipients(List<EmailRecipient>? input)
    {
        if (input == null) return new();
        return input
            .Where(r => r != null && !string.IsNullOrWhiteSpace(r.Name))
            .Select(r => new EmailRecipient
            {
                Name = r.Name.Trim(),
                Email = string.IsNullOrWhiteSpace(r.Email) ? null : r.Email.Trim(),
                Note = string.IsNullOrWhiteSpace(r.Note) ? null : r.Note.Trim(),
            })
            .ToList();
    }

    private static List<EmailTemplateVariable> SanitizeVariables(List<EmailTemplateVariable>? input)
    {
        if (input == null) return new();
        return input
            .Where(v => v != null && !string.IsNullOrWhiteSpace(v.Key))
            .Select(v => new EmailTemplateVariable
            {
                Key = v.Key.Trim(),
                Label = string.IsNullOrWhiteSpace(v.Label) ? v.Key.Trim() : v.Label.Trim(),
                Placeholder = string.IsNullOrWhiteSpace(v.Placeholder) ? null : v.Placeholder.Trim(),
                DefaultValue = string.IsNullOrWhiteSpace(v.DefaultValue) ? null : v.DefaultValue,
                Multiline = v.Multiline,
            })
            .ToList();
    }

    private async Task WriteSseAsync(string eventType, object data)
    {
        try
        {
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            });
            await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
    }
}
