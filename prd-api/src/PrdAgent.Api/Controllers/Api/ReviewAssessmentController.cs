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

    /// <summary>并发评分批次数：3 路同跑约把总耗时压到串行的 1/3</summary>
    private const int MaxConcurrentBatches = 3;

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
    /// 列映射由启发式 + LLM 自动综合完成（前五因子以产品经理评论为最高优先级证据，
    /// 后三因子以需求详情为准），不需要用户逐列确认；任务创建后即 Queued，前端连接 stream 开始评估。
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

        // 上传阶段只做关键词启发式映射，保证秒级返回；LLM 精化挪到评估流第一阶段执行
        var mapping = BuildHeuristicMapping(table.Headers);

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
            CommentColumnIndexes = mapping.CommentColumns,
            AnchorScale = RequirementFactorCatalog.AnchorMax,
            MappingRefined = false,
            WeightsSnapshot = RequirementFactorCatalog.BuildWeightsSnapshot(),
            Status = RequirementAssessmentStatuses.Queued,
        };

        if (run.Rows.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "需求表中没有可评估的数据行"));

        // 条目在评估流内经 LLM 精化列映射后再物化（保证名称列识别更准），此处仅记条数
        run.ItemCount = run.Rows.Count;
        await _db.RequirementAssessmentRuns.InsertOneAsync(run, cancellationToken: CancellationToken.None);

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

        // 剩余状态为 Queued 或旧版 Draft，两者统一进入评估（映射精化 + 条目物化在 RunAssessmentAsync 内完成）
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

        // 1) 列映射 LLM 精化（仅首次；失败保留启发式结果，不阻塞评估）
        if (!run.MappingRefined)
        {
            await WriteSseEventAsync("phase", new { phase = "mapping", message = "正在识别表格结构与关键列..." });
            try
            {
                using var _ = BeginLlmScope(userId, AppCallerRegistry.ReviewAgent.RequirementAssessment.ColumnMapping);
                var table = new ParsedRequirementTable
                {
                    SheetName = run.SheetName,
                    Headers = run.Headers,
                    Rows = run.Rows,
                    TotalRowCount = run.TotalRowCount,
                    Truncated = run.Truncated,
                };
                var heuristic = new ColumnMappingResult
                {
                    NameColumnIndex = run.NameColumnIndex,
                    DescColumnIndex = run.DescColumnIndex,
                    CommentColumns = run.CommentColumnIndexes,
                };
                var refined = await RefineMappingWithLlmAsync(table, heuristic);
                run.NameColumnIndex = refined.NameColumnIndex ?? run.NameColumnIndex ?? 0;
                run.DescColumnIndex = refined.DescColumnIndex;
                run.CommentColumnIndexes = refined.CommentColumns;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "需求评估列映射 LLM 精化失败，使用启发式映射: {RunId}", run.Id);
            }

            run.MappingRefined = true;
            await _db.RequirementAssessmentRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<RequirementAssessmentRun>.Update
                    .Set(x => x.NameColumnIndex, run.NameColumnIndex)
                    .Set(x => x.DescColumnIndex, run.DescColumnIndex)
                    .Set(x => x.CommentColumnIndexes, run.CommentColumnIndexes)
                    .Set(x => x.MappingRefined, true),
                cancellationToken: CancellationToken.None);
        }

        // 2) 物化条目（首次；重试/断点续评时已存在则跳过）
        var allItems = await _db.RequirementAssessmentItems
            .Find(x => x.RunId == run.Id)
            .SortBy(x => x.RowIndex)
            .ToListAsync(CancellationToken.None);

        if (allItems.Count == 0)
        {
            allItems = MaterializeItems(run);
            if (allItems.Count == 0)
                throw new InvalidOperationException("需求表中没有可评估的数据行");
            await _db.RequirementAssessmentItems.InsertManyAsync(allItems, cancellationToken: CancellationToken.None);
            await _db.RequirementAssessmentRuns.UpdateOneAsync(
                x => x.Id == run.Id,
                Builders<RequirementAssessmentRun>.Update.Set(x => x.ItemCount, allItems.Count),
                cancellationToken: CancellationToken.None);
        }

        var pending = allItems.Where(x => x.Status != RequirementItemStatuses.Scored).ToList();
        int scoredCount = allItems.Count - pending.Count;

        await WriteSseEventAsync("phase", new { phase = "preparing", message = $"共 {allItems.Count} 条需求，开始并行评估..." });
        await WriteSseEventAsync("progress", new { done = scoredCount, total = allItems.Count });

        var systemPrompt = BuildScoringSystemPrompt(run);
        var baseSeed = DeriveSeed(run.Id);

        // 模型可见性：首个 Start chunk 的解析结果推给前端展示（ai-model-visibility 规则）
        int modelAnnounced = 0;
        Func<string, string?, Task> onModel = async (model, platform) =>
        {
            if (Interlocked.Exchange(ref modelAnnounced, 1) == 1) return;
            await WriteSseEventAsync("model", new { model, platform });
        };

        // 3) 分批并发评分：批间最多 MaxConcurrentBatches 路同跑，缩短总耗时
        var batches = pending.Chunk(ScoreBatchSize).ToList();
        var throttle = new SemaphoreSlim(MaxConcurrentBatches);
        string? fatalError = null;

        var batchTasks = batches.Select(async (batch, batchIdx) =>
        {
            await throttle.WaitAsync();
            try
            {
                // 网关级错误已发生时不再发起新批次，条目保持 Pending 供重试续评
                if (Volatile.Read(ref fatalError) != null) return;

                var (scored, batchError) = await ScoreBatchAsync(run, batch, systemPrompt, baseSeed + batchIdx + 1, userId, onModel);

                if (batchError != null)
                {
                    // 网关级错误（配额/上游）：置全局熔断，本批条目保持 Pending 待重试
                    if (batchError.StartsWith("LLM 网关错误"))
                    {
                        Interlocked.CompareExchange(ref fatalError, batchError, null);
                        return;
                    }

                    // 解析类失败：仅标记本批条目失败，其余批次继续
                    var batchIds = batch.Select(b => b.Id).ToList();
                    await _db.RequirementAssessmentItems.UpdateManyAsync(
                        x => batchIds.Contains(x.Id),
                        Builders<RequirementAssessmentItem>.Update
                            .Set(x => x.Status, RequirementItemStatuses.Error)
                            .Set(x => x.ErrorMessage, batchError),
                        cancellationToken: CancellationToken.None);
                    return;
                }

                foreach (var item in scored)
                {
                    RequirementScoringEngine.NormalizeAndScore(item);
                    item.Status = RequirementItemStatuses.Scored;
                    item.ScoredAt = DateTime.UtcNow;
                    await _db.RequirementAssessmentItems.ReplaceOneAsync(
                        x => x.Id == item.Id, item, cancellationToken: CancellationToken.None);

                    var done = Interlocked.Increment(ref scoredCount);
                    await WriteSseEventAsync("item_scored", new { item, done, total = allItems.Count });
                    await _db.RequirementAssessmentRuns.UpdateOneAsync(
                        x => x.Id == run.Id,
                        Builders<RequirementAssessmentRun>.Update.Set(x => x.ScoredCount, done),
                        cancellationToken: CancellationToken.None);
                }
            }
            finally
            {
                throttle.Release();
            }
        }).ToList();

        await Task.WhenAll(batchTasks);

        if (fatalError != null)
            throw new InvalidOperationException(fatalError);

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
        var userPromptBase = BuildScoringUserPrompt(run, batch);
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

            // 合理性判定（评论驱动）：仅接受明确的 合理/不合理，其余视为未判定
            item.ReasonablenessVerdict = null;
            item.ReasonablenessEvidence = null;
            if (node["reasonableness"] is JsonObject rn)
            {
                var verdict = ReadString(rn["verdict"]).Trim();
                if (verdict is RequirementReasonableness.Reasonable or RequirementReasonableness.Unreasonable)
                {
                    item.ReasonablenessVerdict = verdict;
                    var evidence = TrimTo(ReadString(rn["evidence"]), 200);
                    item.ReasonablenessEvidence = string.IsNullOrWhiteSpace(evidence) ? null : evidence;
                }
            }
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

    /// <summary>Run 中评论列对应的表头集合（前五因子的最高优先级证据源）</summary>
    private static List<string> CommentHeadersOf(RequirementAssessmentRun run)
        => run.CommentColumnIndexes
            .Where(c => c >= 0 && c < run.Headers.Count)
            .Select(c => run.Headers[c])
            .ToList();

    private static string BuildScoringSystemPrompt(RequirementAssessmentRun run)
    {
        var commentHeaders = CommentHeadersOf(run);
        var commentDriven = RequirementFactorCatalog.CommentDrivenFactorKeys
            .Select(k => RequirementFactorCatalog.Find(k)!.Name).ToList();
        var detailDriven = RequirementFactorCatalog.All
            .Where(f => !RequirementFactorCatalog.IsCommentDriven(f.Key))
            .Select(f => f.Name).ToList();

        var sb = new StringBuilder();
        sb.AppendLine("你是资深产品需求评估专家，依据《产品研发管理规范》的需求价值评估规则，对需求逐条打分。");
        sb.AppendLine();
        sb.AppendLine("## 评估规则模型（八因子，锚点 0-10 分制）");
        sb.AppendLine("| 因子 key | 因子 | 权重 | 规范条款 | 打分锚点 |");
        sb.AppendLine("|---|---|---|---|---|");
        foreach (var f in RequirementFactorCatalog.All)
            sb.AppendLine($"| {f.Key} | {f.Name} | {f.Weight} | 第({f.RuleRef})条 | {f.AnchorGuide} |");
        sb.AppendLine();

        sb.AppendLine("## 证据来源（仅限需求名称、详细描述、产品经理评论三类，其它字段一律不作为证据）");
        sb.AppendLine($"1. 前五维度（{string.Join("/", commentDriven)}）：**产品经理评论是最高优先级证据**。" +
            (commentHeaders.Count > 0 ? $"评论列为「{string.Join("」「", commentHeaders)}」。" : string.Empty) +
            "评论中给出的明确评估意见或分值（如「通用性 8 分」「不合理」）应高权重采纳；评论与需求详情冲突时以评论为准，可结合详情做小幅微调；同一需求有多条评论时以最新一条为准。评论未覆盖的维度再回退用详细描述推断。");
        if (run.DescColumnIndex is int dc && dc >= 0 && dc < run.Headers.Count)
            sb.AppendLine($"2. 后三维度（{string.Join("/", detailDriven)}）：以需求详细描述（列「{run.Headers[dc]}」）与需求名称为准，评论仅作辅助参考。");
        else
            sb.AppendLine($"2. 后三维度（{string.Join("/", detailDriven)}）：以需求详细描述与需求名称为准，评论仅作辅助参考。");
        sb.AppendLine("3. 除需求名称、详细描述、评论之外的字段信息均不列入评估参考数据范围，禁止引用或推断。");
        sb.AppendLine("4. 结合行业通用优先级实践（WSJF 延迟成本思想、RICE 触达/影响/置信度）辅助判断锚点档位，但每个因子的打分依据必须落到上述证据原文，禁止凭空判断。");
        sb.AppendLine();

        sb.AppendLine("## 合理性判定（评论驱动，独立于八因子打分）");
        sb.AppendLine("1. 仅当产品经理评论中给出了明确的合理性意见（如「合理」「不合理」「不建议做」「伪需求」）时，输出 reasonableness.verdict = \"合理\" 或 \"不合理\"，并在 reasonableness.evidence 引用评论原文。");
        sb.AppendLine("2. 评论未提及合理性时 verdict 输出 null，禁止自行推断。");
        sb.AppendLine("3. 判定「不合理」必须给出评论原文依据，否则系统会作废该判定。");
        sb.AppendLine();

        sb.AppendLine("## 打分要求（硬约束）");
        sb.AppendLine("1. 每个因子输出 score（0-10 整数）、hasEvidence（布尔）、evidence（不超过 60 字）。");
        sb.AppendLine("2. evidence 必须引用需求字段的原文（格式：字段名=\"原文\" → 判断），禁止编造字段中不存在的信息；来自评论的证据同样须原文引用。");
        sb.AppendLine("3. 字段中找不到该因子的依据时：hasEvidence=false，score 给出你的合理推测（系统会按保守规则处理）。");
        sb.AppendLine("4. 需求描述文本中隐含的信息（如提到 KA 客户、签约时间）也算证据，须原文引用。");
        sb.AppendLine("5. conclusion：一句话评估结论（不超过 50 字），概括该需求的核心价值与建议。");
        sb.AppendLine("6. 不做总分计算与排序 —— 加权与排序由系统完成。");
        sb.AppendLine();
        sb.AppendLine("## 输出 JSON schema（只输出 JSON，无其他文字）");
        sb.AppendLine("""{"items":[{"row":1,"reasonableness":{"verdict":"合理","evidence":"评论=\"...\""},"factors":{"universality":{"score":8,"hasEvidence":true,"evidence":"..."},"frequency":{...},"impactScope":{...},"customerVoice":{...},"roadmapFit":{...},"customerTier":{...},"dealLeverage":{...},"contractUrgency":{...}},"conclusion":"..."}]}""");
        sb.AppendLine("说明：reasonableness.verdict 取值 \"合理\" / \"不合理\" / null（评论未提及合理性）。");
        return sb.ToString();
    }

    /// <summary>
    /// 评分 user prompt：只投喂需求名称 + 详细描述 + 产品经理评论三类信息，
    /// 表格其它字段一律不进入评估参考范围（2026-08-06 用户核定）。
    /// </summary>
    private static string BuildScoringUserPrompt(RequirementAssessmentRun run, RequirementAssessmentItem[] batch)
    {
        var commentHeaders = new HashSet<string>(CommentHeadersOf(run), StringComparer.Ordinal);
        var descHeader = run.DescColumnIndex is int dc && dc >= 0 && dc < run.Headers.Count ? run.Headers[dc] : null;

        var sb = new StringBuilder();
        sb.AppendLine($"请评估以下 {batch.Length} 条需求（row 为行号标识，输出时原样带回）：");
        foreach (var item in batch)
        {
            sb.AppendLine();
            sb.AppendLine($"### 需求 row={item.RowIndex}：{item.Name}");

            if (descHeader != null && item.RawFields.TryGetValue(descHeader, out var desc) && !string.IsNullOrWhiteSpace(desc))
                sb.AppendLine($"- 详细描述: {TrimTo(desc, 1500)}");

            // 评论单独成块醒目展示（前五维度的最高优先级证据源）
            var comments = item.RawFields
                .Where(kv => commentHeaders.Contains(kv.Key) && !string.IsNullOrWhiteSpace(kv.Value))
                .ToList();
            if (comments.Count > 0)
            {
                sb.AppendLine("【产品经理评论】");
                foreach (var (header, value) in comments)
                    sb.AppendLine($"- {header}: {TrimTo(value, 800)}");
            }
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
        public List<int> CommentColumns { get; set; } = new();
    }

    private static readonly string[] NameHeaderKeywords = { "需求名称", "需求标题", "标题", "需求点", "功能名称", "需求" };
    private static readonly string[] DescHeaderKeywords = { "需求描述", "描述", "详细说明", "说明", "详情", "内容" };
    private static readonly string[] CommentHeaderKeywords = { "评论", "评审意见", "审核意见", "评审建议", "评估意见", "意见", "回复", "comment" };

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

        for (int i = 0; i < headers.Count; i++)
        {
            if (i == nameIdx || i == descIdx) continue;
            if (CommentHeaderKeywords.Any(kw => headers[i].Contains(kw, StringComparison.OrdinalIgnoreCase)))
                result.CommentColumns.Add(i);
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
        sb.AppendLine("请输出 JSON（只输出 JSON）：");
        sb.AppendLine("""{"nameColumn":0,"descColumn":1,"commentColumns":[7]}""");
        sb.AppendLine("规则：nameColumn 必填（最能代表需求名称的列）。");
        sb.AppendLine("descColumn：需求详细描述列（评估的核心证据源）。字段名可能有差异（如「详细描述」「需求描述」「需求说明」「需求内容」等），按语义智能判断；确实没有则给 null。");
        sb.AppendLine("commentColumns：产品经理评论/评审意见类列的 index 数组（评论中通常含合理性判断与维度打分意见）。字段名可能有差异（如「评论」「评审意见」「PM 意见」「审核回复」等），按语义智能判断；没有就给空数组。");
        sb.AppendLine("只识别以上三类列，其它字段不参与评估，无需标注。");

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

            if (root["commentColumns"] is JsonArray cc)
            {
                result.CommentColumns = cc.Select(n => ReadInt(n, -1))
                    .Where(i => i >= 0 && i < table.Headers.Count && i != result.NameColumnIndex && i != result.DescColumnIndex)
                    .Distinct()
                    .ToList();
            }

            // LLM 未识别出评论列时回退启发式（避免 LLM 偷懒输出全空）
            if (result.CommentColumns.Count == 0) result.CommentColumns = heuristic.CommentColumns;
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
                hints.Add($"「{def.Name}」维度证据普遍缺失（{missing}/{items.Count} 条无证据，已按保守值计分），建议在需求详细描述或评论中补充该维度信息");
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
        var unreasonable = ordered.Count(RequirementScoringEngine.IsUnreasonable);
        if (unreasonable > 0)
        {
            sb.AppendLine();
            sb.AppendLine($"另有 {unreasonable} 条被产品经理评论判定「不合理」，已强制分档 P3 并排序置于所有合理需求之后。");
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
        sb.AppendLine("| 优先级 | 需求 | 合理性 | 总分 | 分档 | 签约置顶 | 证据齐全度 | 一句话结论 |");
        sb.AppendLine("|---|---|---|---|---|---|---|---|");
        foreach (var item in ordered)
        {
            var esc = item.Name.Replace("|", "\\|");
            var conclusion = item.Conclusion.Replace("|", "\\|").Replace("\n", " ");
            var reasonableness = item.ReasonablenessVerdict ?? "-";
            sb.AppendLine($"| {item.Priority} | {esc} | {reasonableness} | {item.TotalScore} | {item.Tier} | {(item.IsContractualOverride ? "是" : "-")} | {item.ConfidencePercent}% | {conclusion} |");
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
        sb.AppendLine("1. 因子得分 = 锚点分（0-10）x 权重 / 10，需求总分 = 八因子得分之和（满分 100）。");
        sb.AppendLine("2. 证据范围：评估仅参考需求名称、详细描述与产品经理评论，表格其它字段不列入评估参考。");
        sb.AppendLine("3. 评论权重：通用性/使用频次/影响范围/客户反馈量/产品主线契合度五个维度以产品经理评论为最高优先级证据，评论与需求详情冲突时以评论为准；客户重要度/成交助力/签约紧迫度三个维度以需求详情内容为准。");
        sb.AppendLine("4. 合理性判定：产品经理评论明确判定「不合理」的需求（须有评论原文依据），强制分档 P3 并排序置于所有合理需求之后。");
        sb.AppendLine($"5. 证据兜底：详细描述与评论中均无证据的因子按保守锚点 {RequirementFactorCatalog.ConservativeAnchor} 分计，并在明细中标注，杜绝 AI 凭空判断。");
        sb.AppendLine($"6. 签约强制置顶：已签约且承诺期限 ≤30 天（签约紧迫度 ≥{RequirementFactorCatalog.ContractOverrideAnchorMin} 分且有证据）的需求排在所有普通需求之前（评论判定不合理的除外）。");
        sb.AppendLine("7. 同分决胜链：签约紧迫度 → 客户反馈量 → 主线契合度 → 成交助力 → 通用性 → 原始行号。");
        sb.AppendLine($"8. 分档：置顶或 ≥{RequirementFactorCatalog.TierP0Threshold} 为 P0；≥{RequirementFactorCatalog.TierP1Threshold} 为 P1；≥{RequirementFactorCatalog.TierP2Threshold} 为 P2；其余 P3。");
        sb.AppendLine();

        // 四、逐条评估明细
        sb.AppendLine("## 四、逐条评估明细");
        foreach (var item in ordered)
        {
            sb.AppendLine();
            sb.AppendLine($"### 优先级 {item.Priority}：{item.Name}");
            sb.AppendLine();
            sb.AppendLine($"总分 **{item.TotalScore}** ｜ 分档 **{item.Tier}**{(item.IsContractualOverride ? " ｜ 签约强制置顶" : string.Empty)}{(RequirementScoringEngine.IsUnreasonable(item) ? " ｜ **评论判定不合理**" : string.Empty)} ｜ 证据齐全度 {item.ConfidencePercent}%");
            if (!string.IsNullOrEmpty(item.ReasonablenessVerdict))
            {
                var basis = string.IsNullOrWhiteSpace(item.ReasonablenessEvidence) ? string.Empty : $"（依据：{item.ReasonablenessEvidence.Replace("\n", " ")}）";
                sb.AppendLine($"合理性：{item.ReasonablenessVerdict}{basis}");
            }
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
                sb.AppendLine($"| {f.Name} | {f.Anchor}/{run.AnchorScale} | {f.WeightedScore} | {evidence} |");
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
        run.CommentColumnIndexes,
        run.AnchorScale,
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

    private readonly SemaphoreSlim _sseWriteLock = new(1, 1);
    private bool _sseClientGone;

    /// <summary>
    /// SSE 写出：串行化并发批次的写入；客户端断开后静默跳过后续写入
    /// （服务器权威：断开不取消评估，结果照常落库，前端重进页面轮询兜底）。
    /// </summary>
    private async Task WriteSseEventAsync(string eventType, object data)
    {
        if (_sseClientGone) return;
        await _sseWriteLock.WaitAsync();
        try
        {
            if (_sseClientGone) return;
            var json = JsonSerializer.Serialize(data, new JsonSerializerOptions
            {
                PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            });
            await Response.WriteAsync($"event: {eventType}\n");
            await Response.WriteAsync($"data: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { _sseClientGone = true; }
        catch (OperationCanceledException) { _sseClientGone = true; }
        catch (IOException) { _sseClientGone = true; }
        finally
        {
            _sseWriteLock.Release();
        }
    }

}
