using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 产品评审员 Agent：需求评估（Excel 需求表批量评估 + 优先级排序报告）。
/// 与 ReviewAgentController 同属 review-agent 应用，按功能拆独立 Controller 控制文件体量。
/// </summary>
[ApiController]
[Route("api/review-agent/assessments")]
[Authorize]
[AdminController("review-agent", AdminPermissionCatalog.ReviewAgentUse)]
public class ReviewAssessmentController : ControllerBase
{
    private const long MaxExcelBytes = 10 * 1024 * 1024;
    private const int ScoreBatchSize = 5;

    private static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase) { ".xls", ".xlsx" };

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly IRequirementExcelParser _excelParser;
    private readonly ILLMRequestContextAccessor _llmContext;
    private readonly ILogger<ReviewAssessmentController> _logger;

    public ReviewAssessmentController(
        MongoDbContext db,
        ILlmGateway gateway,
        IRequirementExcelParser excelParser,
        ILLMRequestContextAccessor llmContext,
        ILogger<ReviewAssessmentController> logger)
    {
        _db = db;
        _gateway = gateway;
        _excelParser = excelParser;
        _llmContext = llmContext;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private string? GetDisplayName()
        => User.FindFirst("displayName")?.Value
           ?? User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value;

    private bool HasViewAllPermission()
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(AdminPermissionCatalog.ReviewAgentViewAll)
               || permissions.Contains(AdminPermissionCatalog.Super);
    }

    private IDisposable BeginLlmScope(string userId, string appCallerCode) =>
        _llmContext.BeginScope(new LlmRequestContext(
            RequestId: Guid.NewGuid().ToString("N"),
            GroupId: null,
            SessionId: null,
            UserId: userId,
            ViewRole: null,
            DocumentChars: null,
            DocumentHash: null,
            SystemPromptRedacted: null,
            RequestType: "chat",
            AppCallerCode: appCallerCode));

    // ──────────────────────────────────────────────
    // 上传即建任务（列映射全自动，无需用户确认）
    // ──────────────────────────────────────────────

    /// <summary>
    /// 上传需求表（.xls / .xlsx）并直接创建评估任务。
    /// 列映射由启发式 + LLM 自动综合完成（核心证据源是需求详细描述，评论等其他字段辅助参考），
    /// 不需要用户逐列确认；任务创建后即 Queued，前端连接 stream 开始评估。
    /// </summary>
    [HttpPost("")]
    [RequestSizeLimit(MaxExcelBytes + 1024 * 1024)]
    public async Task<IActionResult> CreateAssessment([FromForm] IFormFile file, [FromForm] string? title, CancellationToken ct)
    {
        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请上传需求表文件"));

        if (file.Length > MaxExcelBytes)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "文件超过 10MB 上限"));

        var ext = Path.GetExtension(file.FileName ?? string.Empty);
        if (!AllowedExtensions.Contains(ext))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅支持 .xls / .xlsx 格式的需求表"));

        byte[] bytes;
        using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        ParsedRequirementTable table;
        try
        {
            table = _excelParser.Parse(bytes, file.FileName ?? "需求表");
        }
        catch (InvalidDataException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }

        var userId = GetUserId();

        // 列映射：先关键词启发式，再用 LLM 精化（LLM 失败不阻塞，保留启发式结果）
        var mapping = BuildHeuristicMapping(table.Headers);
        try
        {
            using var _ = BeginLlmScope(userId, AppCallerRegistry.ReviewAgent.RequirementAssessment.ColumnMapping);
            mapping = await RefineMappingWithLlmAsync(table, mapping);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "需求评估列映射 LLM 精化失败，使用启发式映射");
        }

        var run = new RequirementAssessmentRun
        {
            OwnerUserId = userId,
            OwnerName = GetDisplayName() ?? userId,
            Title = string.IsNullOrWhiteSpace(title)
                ? Path.GetFileNameWithoutExtension(file.FileName ?? "需求评估")
                : title.Trim(),
            FileName = file.FileName ?? string.Empty,
            SheetName = table.SheetName,
            Headers = table.Headers,
            Rows = table.Rows,
            TotalRowCount = table.TotalRowCount,
            Truncated = table.Truncated,
            NameColumnIndex = mapping.NameColumnIndex ?? 0,
            DescColumnIndex = mapping.DescColumnIndex,
            FactorColumnMapping = mapping.FactorColumns,
            WeightsSnapshot = RequirementFactorCatalog.BuildWeightsSnapshot(),
            Status = RequirementAssessmentStatuses.Queued,
        };

        var items = MaterializeItems(run);
        if (items.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "需求表中没有可评估的数据行"));

        run.ItemCount = items.Count;
        await _db.RequirementAssessmentRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);
        await _db.RequirementAssessmentItems.InsertManyAsync(items, cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { run = ToRunView(run) }));
    }

    /// <summary>按名称列把数据行物化为待评估条目</summary>
    private static List<RequirementAssessmentItem> MaterializeItems(RequirementAssessmentRun run)
    {
        var nameCol = run.NameColumnIndex is int n && n >= 0 && n < run.Headers.Count ? n : 0;
        var items = new List<RequirementAssessmentItem>();
        for (int r = 0; r < run.Rows.Count; r++)
        {
            var row = run.Rows[r];
            var name = nameCol < row.Count ? row[nameCol].Trim() : string.Empty;
            if (string.IsNullOrEmpty(name)) name = $"第 {r + 1} 行需求";

            var rawFields = new Dictionary<string, string>();
            for (int c = 0; c < run.Headers.Count && c < row.Count; c++)
            {
                if (!string.IsNullOrWhiteSpace(row[c]))
                    rawFields[run.Headers[c]] = row[c];
            }

            items.Add(new RequirementAssessmentItem
            {
                RunId = run.Id,
                RowIndex = r + 1,
                Name = name.Length > 200 ? name[..200] : name,
                RawFields = rawFields,
            });
        }
        return items;
    }

    // ──────────────────────────────────────────────
    // 查询
    // ──────────────────────────────────────────────

    /// <summary>我的评估任务列表（view-all 权限可看全部）</summary>
    [HttpGet("")]
    public async Task<IActionResult> ListRuns(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] bool all = false,
        CancellationToken ct = default)
    {
        var filterBuilder = Builders<RequirementAssessmentRun>.Filter;
        var filter = all && HasViewAllPermission()
            ? filterBuilder.Empty
            : filterBuilder.Eq(x => x.OwnerUserId, GetUserId());

        var total = await _db.RequirementAssessmentRuns.CountDocumentsAsync(filter, cancellationToken: ct);
        var runs = await _db.RequirementAssessmentRuns.Find(filter)
            .SortByDescending(x => x.CreatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items = runs.Select(ToRunView).ToList(), total, page, pageSize }));
    }

    /// <summary>评估任务详情 + 全部条目（Done 后按优先级排序）</summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> GetRun(string id, CancellationToken ct)
    {
        var run = await _db.RequirementAssessmentRuns.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "评估任务不存在"));

        if (run.OwnerUserId != GetUserId() && !HasViewAllPermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看该评估任务"));

        var items = await _db.RequirementAssessmentItems.Find(x => x.RunId == id).ToListAsync(ct);
        var ordered = run.Status == RequirementAssessmentStatuses.Done
            ? items.OrderBy(x => x.Priority ?? int.MaxValue).ThenBy(x => x.RowIndex).ToList()
            : items.OrderBy(x => x.RowIndex).ToList();

        return Ok(ApiResponse<object>.Ok(new
        {
            run = ToRunView(run),
            reportMarkdown = run.ReportMarkdown,
            items = ordered,
            factors = RequirementFactorCatalog.All.Select(f => new { f.Key, f.Name, f.Weight, f.RuleRef, f.AnchorGuide }),
        }));
    }

    /// <summary>失败后重试（已评分条目保留，断点续评）</summary>
    [HttpPost("{id}/rerun")]
    public async Task<IActionResult> RerunAssessment(string id, CancellationToken ct)
    {
        var run = await _db.RequirementAssessmentRuns.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "评估任务不存在"));

        if (run.OwnerUserId != GetUserId())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "只有发起人可以重试"));

        if (run.Status != RequirementAssessmentStatuses.Error)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅评估失败的任务可以重试"));

        // 评分失败的条目重置为待评估，已评分条目保留（断点续评）
        await _db.RequirementAssessmentItems.UpdateManyAsync(
            x => x.RunId == id && x.Status == RequirementItemStatuses.Error,
            Builders<RequirementAssessmentItem>.Update
                .Set(x => x.Status, RequirementItemStatuses.Pending)
                .Set(x => x.ErrorMessage, null),
            cancellationToken: CancellationToken.None);

        await _db.RequirementAssessmentRuns.UpdateOneAsync(
            x => x.Id == id,
            Builders<RequirementAssessmentRun>.Update
                .Set(x => x.Status, RequirementAssessmentStatuses.Queued)
                .Set(x => x.ErrorMessage, null),
            cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { message = "已重新排队，请重新连接评估流" }));
    }

    /// <summary>导出评估报告 Markdown</summary>
    [HttpGet("{id}/export")]
    public async Task<IActionResult> ExportReport(string id, CancellationToken ct)
    {
        var run = await _db.RequirementAssessmentRuns.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (run == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "评估任务不存在"));

        if (run.OwnerUserId != GetUserId() && !HasViewAllPermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限导出该报告"));

        if (run.Status != RequirementAssessmentStatuses.Done || string.IsNullOrEmpty(run.ReportMarkdown))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "评估尚未完成，暂无报告可导出"));

        var bytes = Encoding.UTF8.GetBytes(run.ReportMarkdown);
        var downloadName = $"需求评估报告-{run.Title}-{run.CompletedAt:yyyyMMdd}.md";
        return File(bytes, "text/markdown; charset=utf-8", downloadName);
    }

    // ──────────────────────────────────────────────
    // SSE 评估执行流
    // ──────────────────────────────────────────────

    /// <summary>
    /// 评估执行流：Queued 任务在此连接内逐批评估并实时推送；
    /// Done 任务重放结果摘要；Running 拒绝重复连接（沿用 review 流并发防护模式）。
    /// </summary>
    [HttpGet("{id}/stream")]
    [Produces("text/event-stream")]
    public async Task StreamAssessment(string id, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();
        var run = await _db.RequirementAssessmentRuns.Find(x => x.Id == id).FirstOrDefaultAsync(CancellationToken.None);
        if (run == null)
        {
            await WriteSseEventAsync("error", new { message = "评估任务不存在" });
            return;
        }

        if (run.OwnerUserId != userId && !HasViewAllPermission())
        {
            await WriteSseEventAsync("error", new { message = "无权限查看该评估任务" });
            return;
        }

        if (run.Status == RequirementAssessmentStatuses.Done)
        {
            await WriteSseEventAsync("phase", new { phase = "completed", message = "评估已完成" });
            await WriteSseEventAsync("done", new { });
            return;
        }

        if (run.Status == RequirementAssessmentStatuses.Error)
        {
            await WriteSseEventAsync("error", new { message = run.ErrorMessage ?? "评估失败" });
            return;
        }

        if (run.Status == RequirementAssessmentStatuses.Running)
        {
            await WriteSseEventAsync("error", new { message = "该任务正在评估中，请勿重复连接" });
            return;
        }

        if (run.Status == RequirementAssessmentStatuses.Draft)
        {
            // 兼容旧版「待确认映射」任务：映射已改全自动，直接补齐条目进入评估
            var existingCount = await _db.RequirementAssessmentItems
                .CountDocumentsAsync(x => x.RunId == id, cancellationToken: CancellationToken.None);
            if (existingCount == 0)
            {
                var legacyItems = MaterializeItems(run);
                if (legacyItems.Count == 0)
                {
                    await WriteSseEventAsync("error", new { message = "需求表中没有可评估的数据行" });
                    return;
                }
                await _db.RequirementAssessmentItems.InsertManyAsync(legacyItems, cancellationToken: CancellationToken.None);
                await _db.RequirementAssessmentRuns.UpdateOneAsync(
                    x => x.Id == id,
                    Builders<RequirementAssessmentRun>.Update.Set(x => x.ItemCount, legacyItems.Count),
                    cancellationToken: CancellationToken.None);
            }
        }

        await _db.RequirementAssessmentRuns.UpdateOneAsync(
            x => x.Id == id,
            Builders<RequirementAssessmentRun>.Update
                .Set(x => x.Status, RequirementAssessmentStatuses.Running)
                .Set(x => x.StartedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        try
        {
            await RunAssessmentAsync(run);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "需求评估执行失败: {RunId}", id);
            try
            {
                await _db.RequirementAssessmentRuns.UpdateOneAsync(
                    x => x.Id == id,
                    Builders<RequirementAssessmentRun>.Update
                        .Set(x => x.Status, RequirementAssessmentStatuses.Error)
                        .Set(x => x.ErrorMessage, ex.Message),
                    cancellationToken: CancellationToken.None);
                await WriteSseEventAsync("error", new { message = "评估过程发生错误，可点击重试继续（已评分条目会保留）" });
            }
            catch { /* 客户端已断开 */ }
        }
    }

    private async Task RunAssessmentAsync(RequirementAssessmentRun run)
    {
        var userId = run.OwnerUserId;
        var allItems = await _db.RequirementAssessmentItems
            .Find(x => x.RunId == run.Id)
            .SortBy(x => x.RowIndex)
            .ToListAsync(CancellationToken.None);

        if (allItems.Count == 0)
            throw new InvalidOperationException("评估任务没有待评估条目");

        var pending = allItems.Where(x => x.Status != RequirementItemStatuses.Scored).ToList();
        var scoredCount = allItems.Count - pending.Count;

        await WriteSseEventAsync("phase", new { phase = "preparing", message = $"共 {allItems.Count} 条需求，开始评估..." });

        var systemPrompt = BuildScoringSystemPrompt(run);
        var baseSeed = DeriveSeed(run.Id);
        int batchNo = 0;

        // 模型可见性：首个 Start chunk 的解析结果推给前端展示（ai-model-visibility 规则）
        bool modelAnnounced = false;
        Func<string, string?, Task> onModel = async (model, platform) =>
        {
            if (modelAnnounced) return;
            modelAnnounced = true;
            try { await WriteSseEventAsync("model", new { model, platform }); }
            catch { /* 客户端断开不影响评估 */ }
        };

        foreach (var batch in pending.Chunk(ScoreBatchSize))
        {
            batchNo++;
            var firstName = batch[0].Name;
            await WriteSseEventAsync("progress", new
            {
                done = scoredCount,
                total = allItems.Count,
                message = $"正在评估第 {scoredCount + 1}-{Math.Min(scoredCount + batch.Length, allItems.Count)}/{allItems.Count} 条：{firstName} 等",
            });

            var (scored, batchError) = await ScoreBatchAsync(run, batch, systemPrompt, baseSeed + batchNo, userId, onModel);

            if (batchError != null)
            {
                // 单批失败不终止整个任务：标记该批条目失败，继续后续批次
                var batchIds = batch.Select(b => b.Id).ToList();
                await _db.RequirementAssessmentItems.UpdateManyAsync(
                    x => batchIds.Contains(x.Id),
                    Builders<RequirementAssessmentItem>.Update
                        .Set(x => x.Status, RequirementItemStatuses.Error)
                        .Set(x => x.ErrorMessage, batchError),
                    cancellationToken: CancellationToken.None);

                // 网关级错误（配额/上游）继续跑下一批大概率还是失败，直接中断
                if (batchError.StartsWith("LLM 网关错误"))
                    throw new InvalidOperationException(batchError);
                continue;
            }

            foreach (var item in scored)
            {
                RequirementScoringEngine.NormalizeAndScore(item);
                item.Status = RequirementItemStatuses.Scored;
                item.ScoredAt = DateTime.UtcNow;
                await _db.RequirementAssessmentItems.ReplaceOneAsync(
                    x => x.Id == item.Id, item, cancellationToken: CancellationToken.None);

                scoredCount++;
                try
                {
                    await WriteSseEventAsync("item_scored", new { item, done = scoredCount, total = allItems.Count });
                }
                catch (ObjectDisposedException) { /* 客户端断开，继续后台评估 */ }
                catch (OperationCanceledException) { /* 同上 */ }
            }

            await _db.RequirementAssessmentRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<RequirementAssessmentRun>.Update.Set(x => x.ScoredCount, scoredCount),
                cancellationToken: CancellationToken.None);
        }

        // 全量重新加载，计算全局排序（含历史已评分条目）
        var finalItems = await _db.RequirementAssessmentItems
            .Find(x => x.RunId == run.Id)
            .ToListAsync(CancellationToken.None);

        var scoredItems = finalItems.Where(x => x.Status == RequirementItemStatuses.Scored).ToList();
        var failedItems = finalItems.Where(x => x.Status != RequirementItemStatuses.Scored).ToList();

        if (scoredItems.Count == 0)
            throw new InvalidOperationException("所有需求评估均失败，请重试");

        await WriteSseEventAsync("phase", new { phase = "ranking", message = "评分完成，正在计算优先级排序..." });

        RequirementScoringEngine.RankAndTier(scoredItems);
        foreach (var item in scoredItems)
        {
            await _db.RequirementAssessmentItems.UpdateOneAsync(
                x => x.Id == item.Id,
                Builders<RequirementAssessmentItem>.Update
                    .Set(x => x.Priority, item.Priority)
                    .Set(x => x.Tier, item.Tier),
                cancellationToken: CancellationToken.None);
        }

        var globalHints = BuildGlobalMissingHints(scoredItems);
        var report = BuildReportMarkdown(run, scoredItems, failedItems, globalHints);

        await _db.RequirementAssessmentRuns.UpdateOneAsync(
            x => x.Id == run.Id,
            Builders<RequirementAssessmentRun>.Update
                .Set(x => x.Status, RequirementAssessmentStatuses.Done)
                .Set(x => x.ScoredCount, scoredItems.Count)
                .Set(x => x.ReportMarkdown, report)
                .Set(x => x.GlobalMissingHints, globalHints)
                .Set(x => x.CompletedAt, DateTime.UtcNow)
                .Set(x => x.ErrorMessage, failedItems.Count > 0 ? $"{failedItems.Count} 条需求评估失败，未纳入排序" : null),
            cancellationToken: CancellationToken.None);

        try
        {
            await WriteSseEventAsync("ranking", new
            {
                items = scoredItems.OrderBy(x => x.Priority).Select(x => new { x.Id, x.RowIndex, x.Name, x.Priority, x.Tier, x.TotalScore, x.IsContractualOverride }),
            });
            await WriteSseEventAsync("phase", new { phase = "completed", message = "评估完成" });
            await WriteSseEventAsync("done", new { failedCount = failedItems.Count });
        }
        catch { /* 客户端已断开，结果已落库 */ }
    }

    /// <summary>单批评分：LLM 打锚点分 + 证据，解析失败自动重试一次</summary>
    private async Task<(List<RequirementAssessmentItem> scored, string? error)> ScoreBatchAsync(
        RequirementAssessmentRun run,
        RequirementAssessmentItem[] batch,
        string systemPrompt,
        int seed,
        string userId,
        Func<string, string?, Task>? onModel = null)
    {
        var userPromptBase = BuildScoringUserPrompt(batch);
        const int MaxAttempts = 2;

        for (int attempt = 1; attempt <= MaxAttempts; attempt++)
        {
            var userPrompt = attempt == 1
                ? userPromptBase
                : userPromptBase + "\n\n## 严格输出要求（重试）\n上一轮输出未通过 JSON 解析。请严格按 JSON schema 输出，不要包裹任何额外说明文字或代码块标记。";

            var gatewayRequest = new GatewayRequest
            {
                AppCallerCode = AppCallerRegistry.ReviewAgent.RequirementAssessment.Chat,
                ModelType = ModelTypes.Chat,
                Stream = true,
                RequestBody = new JsonObject
                {
                    ["messages"] = new JsonArray
                    {
                        new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                        new JsonObject { ["role"] = "user", ["content"] = userPrompt }
                    },
                    ["temperature"] = 0,
                    ["seed"] = seed + (attempt - 1) * 1000,
                    ["max_tokens"] = 8192,
                },
            };

            var fullContent = new StringBuilder();
            string? gatewayError = null;

            using (BeginLlmScope(userId, AppCallerRegistry.ReviewAgent.RequirementAssessment.Chat))
            {
                await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
                {
                    if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                    {
                        fullContent.Append(chunk.Content);
                    }
                    else if (chunk.Type == GatewayChunkType.Start && chunk.Resolution != null && onModel != null)
                    {
                        await onModel(chunk.Resolution.ActualModel, chunk.Resolution.ActualPlatformName);
                    }
                    else if (chunk.Type == GatewayChunkType.Error)
                    {
                        gatewayError = chunk.Error ?? chunk.Content ?? "网关返回未知错误";
                        break;
                    }
                }
            }

            if (gatewayError != null)
                return (new List<RequirementAssessmentItem>(), $"LLM 网关错误: {gatewayError}");

            var parsed = TryParseBatchOutput(fullContent.ToString(), batch);
            if (parsed != null) return (parsed, null);

            _logger.LogWarning("需求评估批次输出解析失败 Run={RunId} attempt={Attempt}", run.Id, attempt);
        }

        return (new List<RequirementAssessmentItem>(), "AI 输出格式异常，已重试仍无法解析");
    }

    /// <summary>解析批次输出 JSON，写回 batch 内条目的因子分（总分由引擎另行计算）</summary>
    private static List<RequirementAssessmentItem>? TryParseBatchOutput(string output, RequirementAssessmentItem[] batch)
    {
        var start = output.IndexOf('{');
        var end = output.LastIndexOf('}');
        if (start < 0 || end <= start) return null;

        JsonNode? root;
        try { root = JsonNode.Parse(output[start..(end + 1)]); }
        catch { return null; }

        if (root?["items"] is not JsonArray itemsNode || itemsNode.Count == 0) return null;

        var byRow = batch.ToDictionary(b => b.RowIndex);
        var scored = new List<RequirementAssessmentItem>();

        foreach (var node in itemsNode)
        {
            if (node == null) continue;
            var row = ReadInt(node["row"], -1);
            if (!byRow.TryGetValue(row, out var item)) continue;

            var factorScores = new List<RequirementFactorScore>();
            if (node["factors"] is JsonObject factorsNode)
            {
                foreach (var def in RequirementFactorCatalog.All)
                {
                    if (factorsNode[def.Key] is not JsonObject f) continue;
                    factorScores.Add(new RequirementFactorScore
                    {
                        Key = def.Key,
                        Anchor = ReadInt(f["score"], RequirementFactorCatalog.ConservativeAnchor),
                        HasEvidence = ReadBool(f["hasEvidence"]),
                        Evidence = TrimTo(ReadString(f["evidence"]), 200),
                    });
                }
            }

            // 因子全缺视为该条解析失败（不接受空评分）
            if (factorScores.Count == 0) continue;

            item.FactorScores = factorScores;
            item.Conclusion = TrimTo(ReadString(node["conclusion"]), 200);
            item.AdjustmentLog = new List<string>();
            item.MissingInfo = new List<string>();
            scored.Add(item);
        }

        // 至少一半条目解析成功才接受本轮输出，否则触发重试
        return scored.Count * 2 >= batch.Length ? scored : null;
    }

    private static int ReadInt(JsonNode? node, int fallback)
    {
        if (node == null) return fallback;
        try { return node.GetValue<int>(); }
        catch
        {
            try { return (int)Math.Round(node.GetValue<double>()); }
            catch { return fallback; }
        }
    }

    private static bool ReadBool(JsonNode? node)
    {
        if (node == null) return false;
        try { return node.GetValue<bool>(); }
        catch
        {
            var s = ReadString(node).Trim();
            return s.Equals("true", StringComparison.OrdinalIgnoreCase) || s == "1" || s == "是";
        }
    }

    private static string ReadString(JsonNode? node)
    {
        if (node == null) return string.Empty;
        try { return node.GetValue<string>() ?? string.Empty; }
        catch { return node.ToString(); }
    }

    private static string TrimTo(string value, int max)
        => value.Length <= max ? value : value[..max];

    // ──────────────────────────────────────────────
    // 提示词构建
    // ──────────────────────────────────────────────

    private static string BuildScoringSystemPrompt(RequirementAssessmentRun run)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是资深产品需求评估专家，依据《产品研发管理规范》的需求价值评估规则，对需求逐条打分。");
        sb.AppendLine();
        sb.AppendLine("## 评估规则模型（八因子，锚点 1-5 分制）");
        sb.AppendLine("| 因子 key | 因子 | 权重 | 规范条款 | 打分锚点 |");
        sb.AppendLine("|---|---|---|---|---|");
        foreach (var f in RequirementFactorCatalog.All)
            sb.AppendLine($"| {f.Key} | {f.Name} | {f.Weight} | 第({f.RuleRef})条 | {f.AnchorGuide} |");
        sb.AppendLine();

        sb.AppendLine("## 证据来源优先级（自动综合，无需用户指定）");
        if (run.DescColumnIndex is int dc && dc >= 0 && dc < run.Headers.Count)
            sb.AppendLine($"1. 核心证据源：需求详细描述（列「{run.Headers[dc]}」）与需求名称，逐条通读理解需求本质后再打分。");
        else
            sb.AppendLine("1. 核心证据源：需求描述/名称类字段，逐条通读理解需求本质后再打分。");
        sb.AppendLine("2. 辅助参考：评论、客户名称、需求来源、需求类型、关联缺陷数、时间等其余全部字段，任何字段中的线索都可作为证据。");
        if (run.FactorColumnMapping.Count > 0)
        {
            var hints = run.FactorColumnMapping
                .Select(kv => (def: RequirementFactorCatalog.Find(kv.Key), cols: kv.Value))
                .Where(x => x.def != null && x.cols.Count > 0)
                .Select(x => $"{x.def!.Name} → {string.Join("、", x.cols.Where(c => c >= 0 && c < run.Headers.Count).Select(c => run.Headers[c]))}")
                .ToList();
            if (hints.Count > 0)
                sb.AppendLine($"3. 系统自动识别的因子相关列（仅提示，不限制）：{string.Join("；", hints)}。");
        }
        sb.AppendLine("4. 结合行业通用优先级实践（WSJF 延迟成本思想、RICE 触达/影响/置信度）辅助判断锚点档位，但每个因子的打分依据必须落到表格字段原文，禁止脱离表格凭空判断。");
        sb.AppendLine();

        sb.AppendLine("## 打分要求（硬约束）");
        sb.AppendLine("1. 每个因子输出 score（1-5 整数）、hasEvidence（布尔）、evidence（不超过 60 字）。");
        sb.AppendLine("2. evidence 必须引用需求字段的原文（格式：字段名=\"原文\" → 判断），禁止编造字段中不存在的信息。");
        sb.AppendLine("3. 字段中找不到该因子的依据时：hasEvidence=false，score 给出你的合理推测（系统会按保守规则处理）。");
        sb.AppendLine("4. 需求描述文本中隐含的信息（如提到 KA 客户、签约时间）也算证据，须原文引用。");
        sb.AppendLine("5. conclusion：一句话评估结论（不超过 50 字），概括该需求的核心价值与建议。");
        sb.AppendLine("6. 不做总分计算与排序 —— 加权与排序由系统完成。");
        sb.AppendLine();
        sb.AppendLine("## 输出 JSON schema（只输出 JSON，无其他文字）");
        sb.AppendLine("""{"items":[{"row":1,"factors":{"universality":{"score":4,"hasEvidence":true,"evidence":"..."},"frequency":{...},"impactScope":{...},"customerVoice":{...},"roadmapFit":{...},"customerTier":{...},"dealLeverage":{...},"contractUrgency":{...}},"conclusion":"..."}]}""");
        return sb.ToString();
    }

    private static string BuildScoringUserPrompt(RequirementAssessmentItem[] batch)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"请评估以下 {batch.Length} 条需求（row 为行号标识，输出时原样带回）：");
        foreach (var item in batch)
        {
            sb.AppendLine();
            sb.AppendLine($"### 需求 row={item.RowIndex}：{item.Name}");
            foreach (var (header, value) in item.RawFields)
                sb.AppendLine($"- {header}: {TrimTo(value, 500)}");
        }
        return sb.ToString();
    }

    // ──────────────────────────────────────────────
    // 列映射（启发式 + LLM 精化）
    // ──────────────────────────────────────────────

    private sealed class ColumnMappingResult
    {
        public int? NameColumnIndex { get; set; }
        public int? DescColumnIndex { get; set; }
        public Dictionary<string, List<int>> FactorColumns { get; set; } = new();
    }

    private static readonly string[] NameHeaderKeywords = { "需求名称", "需求标题", "标题", "需求点", "功能名称", "需求" };
    private static readonly string[] DescHeaderKeywords = { "需求描述", "描述", "详细说明", "说明", "详情", "内容" };

    private static ColumnMappingResult BuildHeuristicMapping(List<string> headers)
    {
        var result = new ColumnMappingResult();

        int FindFirst(string[] keywords)
        {
            foreach (var kw in keywords)
                for (int i = 0; i < headers.Count; i++)
                    if (headers[i].Contains(kw, StringComparison.OrdinalIgnoreCase))
                        return i;
            return -1;
        }

        var nameIdx = FindFirst(NameHeaderKeywords);
        if (nameIdx >= 0) result.NameColumnIndex = nameIdx;
        var descIdx = FindFirst(DescHeaderKeywords);
        if (descIdx >= 0 && descIdx != nameIdx) result.DescColumnIndex = descIdx;

        foreach (var def in RequirementFactorCatalog.All)
        {
            var cols = new List<int>();
            for (int i = 0; i < headers.Count; i++)
            {
                if (i == nameIdx) continue;
                if (def.HeaderKeywords.Any(kw => headers[i].Contains(kw, StringComparison.OrdinalIgnoreCase)))
                    cols.Add(i);
            }
            if (cols.Count > 0) result.FactorColumns[def.Key] = cols;
        }

        return result;
    }

    private async Task<ColumnMappingResult> RefineMappingWithLlmAsync(ParsedRequirementTable table, ColumnMappingResult heuristic)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你负责识别需求表的列结构。表头（index 从 0 开始）：");
        for (int i = 0; i < table.Headers.Count; i++)
            sb.AppendLine($"- [{i}] {table.Headers[i]}");
        sb.AppendLine();
        sb.AppendLine("样例数据（前 3 行）：");
        foreach (var row in table.Rows.Take(3))
            sb.AppendLine(string.Join(" | ", row.Select(c => TrimTo(c, 40))));
        sb.AppendLine();
        sb.AppendLine("评估因子（key 与含义）：");
        foreach (var f in RequirementFactorCatalog.All)
            sb.AppendLine($"- {f.Key}: {f.Name}（规范第{f.RuleRef}条）");
        sb.AppendLine();
        sb.AppendLine("请输出 JSON（只输出 JSON）：");
        sb.AppendLine("""{"nameColumn":0,"descColumn":1,"factorColumns":{"universality":[2],"frequency":[],"impactScope":[],"customerVoice":[3,4],"roadmapFit":[],"customerTier":[5],"dealLeverage":[],"contractUrgency":[6]}}""");
        sb.AppendLine("规则：nameColumn 必填（最能代表需求名称的列）；descColumn 可为 null；");
        sb.AppendLine("factorColumns 中每个因子给出可作为评估证据的列 index 数组，没有对应列就给空数组，禁止猜测无关列。");

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ReviewAgent.RequirementAssessment.ColumnMapping,
            ModelType = ModelTypes.Chat,
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "user", ["content"] = sb.ToString() }
                },
                ["temperature"] = 0,
                ["max_tokens"] = 2048,
            },
        };

        var fullContent = new StringBuilder();
        await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
        {
            if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
                fullContent.Append(chunk.Content);
            else if (chunk.Type == GatewayChunkType.Error)
                return heuristic; // 网关错误 → 保留启发式结果
        }

        var output = fullContent.ToString();
        var start = output.IndexOf('{');
        var end = output.LastIndexOf('}');
        if (start < 0 || end <= start) return heuristic;

        try
        {
            var root = JsonNode.Parse(output[start..(end + 1)]);
            if (root == null) return heuristic;

            var result = new ColumnMappingResult();
            var nameCol = ReadInt(root["nameColumn"], -1);
            result.NameColumnIndex = nameCol >= 0 && nameCol < table.Headers.Count ? nameCol : heuristic.NameColumnIndex;

            var descCol = ReadInt(root["descColumn"], -1);
            result.DescColumnIndex = descCol >= 0 && descCol < table.Headers.Count && descCol != result.NameColumnIndex
                ? descCol : heuristic.DescColumnIndex;

            if (root["factorColumns"] is JsonObject fc)
            {
                foreach (var def in RequirementFactorCatalog.All)
                {
                    if (fc[def.Key] is not JsonArray arr) continue;
                    var cols = arr.Select(n => ReadInt(n, -1))
                        .Where(i => i >= 0 && i < table.Headers.Count)
                        .Distinct()
                        .ToList();
                    if (cols.Count > 0) result.FactorColumns[def.Key] = cols;
                }
            }

            // LLM 一列未映射时回退启发式（避免 LLM 偷懒输出全空）
            if (result.FactorColumns.Count == 0) result.FactorColumns = heuristic.FactorColumns;
            return result;
        }
        catch
        {
            return heuristic;
        }
    }

    // ──────────────────────────────────────────────
    // 报告生成
    // ──────────────────────────────────────────────

    private static List<string> BuildGlobalMissingHints(List<RequirementAssessmentItem> items)
    {
        var hints = new List<string>();
        if (items.Count == 0) return hints;

        foreach (var def in RequirementFactorCatalog.All)
        {
            var missing = items.Count(i => i.FactorScores.Any(f => f.Key == def.Key && !f.HasEvidence));
            if (missing * 2 > items.Count)
                hints.Add($"「{def.Name}」维度证据普遍缺失（{missing}/{items.Count} 条无证据，已按保守值计分），建议需求表补充相关信息列");
        }
        return hints;
    }

    private static string BuildReportMarkdown(
        RequirementAssessmentRun run,
        List<RequirementAssessmentItem> scoredItems,
        List<RequirementAssessmentItem> failedItems,
        List<string> globalHints)
    {
        var ordered = scoredItems.OrderBy(x => x.Priority ?? int.MaxValue).ToList();
        var sb = new StringBuilder();

        sb.AppendLine($"# 需求评估报告：{run.Title}");
        sb.AppendLine();
        sb.AppendLine($"- 来源文件：{run.FileName}（工作表：{run.SheetName}）");
        sb.AppendLine($"- 评估需求数：{scoredItems.Count} 条" + (failedItems.Count > 0 ? $"（另有 {failedItems.Count} 条评估失败未纳入排序）" : string.Empty));
        sb.AppendLine($"- 评估时间：{DateTime.UtcNow.AddHours(8):yyyy-MM-dd HH:mm}（UTC+8）");
        sb.AppendLine();

        // 一、结论概览
        sb.AppendLine("## 一、结论概览");
        sb.AppendLine();
        var tierGroups = ordered.GroupBy(x => x.Tier ?? "P3").OrderBy(g => g.Key).ToList();
        sb.AppendLine("| 分档 | 说明 | 条数 |");
        sb.AppendLine("|---|---|---|");
        foreach (var g in tierGroups)
        {
            var desc = g.Key switch
            {
                "P0" => "核心优先（强制置顶或总分 ≥80）",
                "P1" => "重要（总分 65-79）",
                "P2" => "一般（总分 50-64）",
                _ => "待议（总分 <50）",
            };
            sb.AppendLine($"| {g.Key} | {desc} | {g.Count()} |");
        }
        var overrides = ordered.Count(x => x.IsContractualOverride);
        if (overrides > 0)
        {
            sb.AppendLine();
            sb.AppendLine($"其中 {overrides} 条触发「签约强制置顶」（已签约且承诺期限临近，商业承诺优先于评分排序）。");
        }
        if (globalHints.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("**全表数据缺口提醒：**");
            foreach (var hint in globalHints) sb.AppendLine($"- {hint}");
        }
        sb.AppendLine();

        // 二、优先级排序总表
        sb.AppendLine("## 二、需求优先级排序总表");
        sb.AppendLine();
        sb.AppendLine("| 优先级 | 需求 | 总分 | 分档 | 签约置顶 | 证据齐全度 | 一句话结论 |");
        sb.AppendLine("|---|---|---|---|---|---|---|");
        foreach (var item in ordered)
        {
            var esc = item.Name.Replace("|", "\\|");
            var conclusion = item.Conclusion.Replace("|", "\\|").Replace("\n", " ");
            sb.AppendLine($"| {item.Priority} | {esc} | {item.TotalScore} | {item.Tier} | {(item.IsContractualOverride ? "是" : "-")} | {item.ConfidencePercent}% | {conclusion} |");
        }
        sb.AppendLine();

        // 三、评估规则模型
        sb.AppendLine("## 三、评估规则模型（打分与排序依据）");
        sb.AppendLine();
        sb.AppendLine("| 因子 | 权重 | 规范条款 | 打分锚点 |");
        sb.AppendLine("|---|---|---|---|");
        foreach (var f in RequirementFactorCatalog.All)
            sb.AppendLine($"| {f.Name} | {f.Weight} | 第({f.RuleRef})条 | {f.AnchorGuide} |");
        sb.AppendLine();
        sb.AppendLine("计分与排序规则：");
        sb.AppendLine("1. 因子得分 = 锚点分（1-5）x 权重 / 5，需求总分 = 八因子得分之和（满分 100）。");
        sb.AppendLine($"2. 证据兜底：表格中无证据的因子按保守锚点 {RequirementFactorCatalog.ConservativeAnchor} 分计，并在明细中标注，杜绝 AI 凭空判断。");
        sb.AppendLine("3. 签约强制置顶：已签约且承诺期限 ≤30 天（签约紧迫度 5 分且有证据）的需求排在所有普通需求之前。");
        sb.AppendLine("4. 同分决胜链：签约紧迫度 → 客户反馈量 → 主线契合度 → 成交助力 → 通用性 → 原始行号。");
        sb.AppendLine($"5. 分档：置顶或 ≥{RequirementFactorCatalog.TierP0Threshold} 为 P0；≥{RequirementFactorCatalog.TierP1Threshold} 为 P1；≥{RequirementFactorCatalog.TierP2Threshold} 为 P2；其余 P3。");
        sb.AppendLine();

        // 四、逐条评估明细
        sb.AppendLine("## 四、逐条评估明细");
        foreach (var item in ordered)
        {
            sb.AppendLine();
            sb.AppendLine($"### 优先级 {item.Priority}：{item.Name}");
            sb.AppendLine();
            sb.AppendLine($"总分 **{item.TotalScore}** ｜ 分档 **{item.Tier}**{(item.IsContractualOverride ? " ｜ 签约强制置顶" : string.Empty)} ｜ 证据齐全度 {item.ConfidencePercent}%");
            if (!string.IsNullOrWhiteSpace(item.Conclusion))
                sb.AppendLine($"结论：{item.Conclusion}");
            sb.AppendLine();
            sb.AppendLine("| 因子 | 锚点 | 得分 | 评估依据 |");
            sb.AppendLine("|---|---|---|---|");
            foreach (var f in item.FactorScores)
            {
                var evidence = f.HasEvidence
                    ? f.Evidence.Replace("|", "\\|").Replace("\n", " ")
                    : "表格中无证据，按保守值计";
                sb.AppendLine($"| {f.Name} | {f.Anchor}/5 | {f.WeightedScore} | {evidence} |");
            }
            if (item.MissingInfo.Count > 0)
                sb.AppendLine($"\n建议补充信息：{string.Join("、", item.MissingInfo)}");
            if (item.AdjustmentLog.Count > 0)
            {
                sb.AppendLine("\n系统调整记录：");
                foreach (var log in item.AdjustmentLog) sb.AppendLine($"- {log}");
            }
        }

        // 五、未能评估的需求
        if (failedItems.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("## 五、未能评估的需求");
            sb.AppendLine();
            foreach (var item in failedItems.OrderBy(x => x.RowIndex))
                sb.AppendLine($"- 第 {item.RowIndex} 行「{item.Name}」：{item.ErrorMessage ?? "评估失败"}");
            sb.AppendLine();
            sb.AppendLine("可在任务页点击「重试」继续评估上述需求（已评分条目不会重复评估）。");
        }

        return sb.ToString();
    }

    // ──────────────────────────────────────────────
    // 工具
    // ──────────────────────────────────────────────

    /// <summary>列表/详情返回的 Run 视图（剥离全量 Rows，避免响应体过大）</summary>
    private static object ToRunView(RequirementAssessmentRun run) => new
    {
        run.Id,
        run.OwnerUserId,
        run.OwnerName,
        run.Title,
        run.FileName,
        run.SheetName,
        run.Headers,
        run.TotalRowCount,
        run.Truncated,
        run.NameColumnIndex,
        run.DescColumnIndex,
        run.FactorColumnMapping,
        run.WeightsSnapshot,
        run.Status,
        run.ScoredCount,
        run.ItemCount,
        run.GlobalMissingHints,
        run.ErrorMessage,
        run.CreatedAt,
        run.StartedAt,
        run.CompletedAt,
    };

    private static int DeriveSeed(string id)
    {
        using var sha = System.Security.Cryptography.SHA256.Create();
        var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(id));
        var raw = BitConverter.ToInt32(hash, 0);
        return raw & 0x7FFFFFFF;
    }

    private async Task WriteSseEventAsync(string eventType, object data)
    {
        var json = JsonSerializer.Serialize(data, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        });
        await Response.WriteAsync($"event: {eventType}\n");
        await Response.WriteAsync($"data: {json}\n\n");
        await Response.Body.FlushAsync();
    }

}
