using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
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
    private readonly ILogger<ChannelTraceAgentController> _logger;

    public ChannelTraceAgentController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILLMRequestContextAccessor llmRequestContext,
        ILogger<ChannelTraceAgentController> logger)
    {
        _db = db;
        _gateway = gateway;
        _llmRequestContext = llmRequestContext;
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

    public class DiagnoseRequest
    {
        public string? Problem { get; set; }
    }

    /// <summary>
    /// 线上问题智能排查（SSE 流式）。先召回相似历史案例，再基于案例给出排查路径。
    /// 事件：relatedCases / model / typing / done / error。
    /// </summary>
    [HttpPost("cases/diagnose")]
    [Produces("text/event-stream")]
    public async Task DiagnoseProblem([FromBody] DiagnoseRequest req)
    {
        var userId = GetUserId();
        await RunSseAsync(async writeEvent =>
        {
            if (req == null || string.IsNullOrWhiteSpace(req.Problem))
            {
                await writeEvent("error", new { message = "请描述线上问题现象" });
                return;
            }

            var problem = req.Problem.Trim();
            var allCases = await _db.ChannelTraceCases.Find(Builders<ChannelTraceCase>.Filter.Empty)
                .SortByDescending(x => x.UpdatedAt)
                .Limit(500)
                .ToListAsync(CancellationToken.None);

            // 朴素关键词召回：按问题描述与案例标题/现象/标签的词重合度排序，取 Top N。
            var ranked = RankCasesByRelevance(allCases, problem, 8);

            await writeEvent("relatedCases", new
            {
                items = ranked.Select(c => new
                {
                    id = c.Id,
                    title = c.Title,
                    severity = c.Severity,
                    tags = c.Tags,
                }).ToList(),
            });

            var caseContext = BuildCaseContext(ranked, CaseContextBudget);

            var systemPrompt =
                "你是「商品溯源智能体」中的防窜物流线上问题排查助手。给定一个新线上问题，请基于「历史案例库」给出快速排查路径。\n" +
                "输出结构（中文 Markdown）：\n" +
                " 1. **最可能的方向**：结合历史案例，列 1~3 个最可能根因方向（标注命中了哪条历史案例标题）\n" +
                " 2. **排查步骤**：给出有序、可立即执行的排查 checklist（从最快验证、影响最小的查起）\n" +
                " 3. **需要确认的信息**：列出还需向用户/日志/DB 补充确认的关键信息\n" +
                " 4. **若无相似案例**：明确说明历史案例库未命中，转为依据防窜物流通用链路（上码/关联/出入库/流通/窜货判定）给出通用排查建议\n" +
                "不要编造历史案例里不存在的结论。";

            var userPrompt = new StringBuilder();
            if (!string.IsNullOrWhiteSpace(caseContext))
            {
                userPrompt.AppendLine("===== 召回的历史案例（按相关度排序）=====");
                userPrompt.AppendLine(caseContext);
                userPrompt.AppendLine();
            }
            else
            {
                userPrompt.AppendLine("（历史案例库为空或未召回到相关案例）");
                userPrompt.AppendLine();
            }
            userPrompt.AppendLine("===== 新线上问题 =====");
            userPrompt.AppendLine(problem);

            await writeEvent("phase", new { phase = "diagnosing", message = "AI 正在召回相似案例并给出排查路径…" });
            await StreamChatAsync(writeEvent, userId, systemPrompt, userPrompt.ToString(),
                AppCallerRegistry.ChannelTraceAgent.Diagnose.Chat);
            await writeEvent("done", new { });
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
        public string? BusinessRule { get; set; }
        public string? CodeContent { get; set; }
        public string? CodeLocation { get; set; }
    }

    /// <summary>
    /// 业务规则 vs 代码实现差异对比（SSE 流式 + 落库）。
    /// 事件：diff（记录已创建）/ model / typing / done / error。
    /// </summary>
    [HttpPost("diffs/compare")]
    [Produces("text/event-stream")]
    public async Task CompareDiff([FromBody] CompareDiffRequest req)
    {
        var userId = GetUserId();
        await RunSseAsync(async writeEvent =>
        {
            if (req == null || string.IsNullOrWhiteSpace(req.BusinessRule))
            {
                await writeEvent("error", new { message = "请填写防窜物流业务规则描述" });
                return;
            }
            if (string.IsNullOrWhiteSpace(req.CodeContent))
            {
                await writeEvent("error", new { message = "请粘贴需要对比的代码实现" });
                return;
            }

            var businessRule = Truncate(req.BusinessRule.Trim(), CodeDiffInputBudget);
            var codeContent = Truncate(req.CodeContent.Trim(), CodeDiffInputBudget);

            var diff = new ChannelTraceDiff
            {
                Title = string.IsNullOrWhiteSpace(req.Title) ? "未命名对比" : req.Title.Trim(),
                BusinessRule = businessRule,
                CodeContent = codeContent,
                CodeLocation = string.IsNullOrWhiteSpace(req.CodeLocation) ? null : req.CodeLocation.Trim(),
                Status = ChannelTraceDiffStatuses.Running,
                CreatedBy = userId,
                CreatedByName = GetDisplayName(),
                CreatedAt = DateTime.UtcNow,
            };
            await _db.ChannelTraceDiffs.InsertOneAsync(diff, cancellationToken: CancellationToken.None);
            await writeEvent("diff", new { id = diff.Id, title = diff.Title });

            var systemPrompt =
                "你是「商品溯源智能体」中的防窜物流业务/代码一致性审计助手。给定一份「业务规则描述（期望行为）」和一份「当前代码实现」，请定向对比两者的逻辑差异。\n" +
                "输出结构（中文 Markdown）：\n" +
                " ## 一致性结论\n 一句话总体判断（高度一致 / 部分偏差 / 严重不一致）。\n" +
                " ## 已正确实现\n 业务规则中已被代码正确覆盖的点（逐条）。\n" +
                " ## 缺失 / 未实现\n 业务规则要求但代码里看不到对应实现的点（逐条，指出对应业务条款）。\n" +
                " ## 实现有偏差\n 代码实现与业务规则不一致 / 边界处理不同的点（说明差在哪、可能后果）。\n" +
                " ## 代码额外行为\n 代码做了但业务规则未提及的逻辑（可能是历史包袱或隐藏规则）。\n" +
                " ## 建议\n 给出按优先级排序的修正建议。\n" +
                "严格基于给定材料判断，材料不足以判断时明确写「材料不足，无法判断」，不要编造业务条款或代码行为。";

            var userPrompt = new StringBuilder();
            if (!string.IsNullOrWhiteSpace(diff.CodeLocation))
            {
                userPrompt.AppendLine($"代码位置：{diff.CodeLocation}");
                userPrompt.AppendLine();
            }
            userPrompt.AppendLine("===== 业务规则描述（期望行为）=====");
            userPrompt.AppendLine(businessRule);
            userPrompt.AppendLine();
            userPrompt.AppendLine("===== 当前代码实现 =====");
            userPrompt.AppendLine(codeContent);

            await writeEvent("phase", new { phase = "comparing", message = "AI 正在对比业务规则与代码实现…" });

            try
            {
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

        var body = new JsonObject
        {
            ["messages"] = new JsonArray
            {
                new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                new JsonObject { ["role"] = "user", ["content"] = userPrompt },
            },
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
