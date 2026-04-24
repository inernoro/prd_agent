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
/// 管理后台 - 产品评审员 Agent
/// </summary>
[ApiController]
[Route("api/review-agent")]
[Authorize]
[AdminController("review-agent", AdminPermissionCatalog.ReviewAgentUse)]
public class ReviewAgentController : ControllerBase
{
    private const string AppKey = "review-agent";
    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<ReviewAgentController> _logger;
    private readonly Services.ReviewAgent.ReviewWebhookService _webhookService;

    public ReviewAgentController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILogger<ReviewAgentController> logger,
        Services.ReviewAgent.ReviewWebhookService webhookService)
    {
        _db = db;
        _gateway = gateway;
        _logger = logger;
        _webhookService = webhookService;
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

    private bool HasManagePermission()
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(AdminPermissionCatalog.ReviewAgentManage)
               || permissions.Contains(AdminPermissionCatalog.Super);
    }

    // ──────────────────────────────────────────────
    // 评审维度配置
    // ──────────────────────────────────────────────

    /// <summary>
    /// 获取当前评审维度配置
    /// </summary>
    [HttpGet("dimensions")]
    public async Task<IActionResult> GetDimensions(CancellationToken ct)
    {
        var dims = await _db.ReviewDimensionConfigs
            .Find(x => x.IsActive)
            .SortBy(x => x.OrderIndex)
            .ToListAsync(ct);

        if (dims.Count == 0)
            dims = DefaultReviewDimensions.All;

        return Ok(ApiResponse<object>.Ok(new { dimensions = dims }));
    }

    /// <summary>
    /// 更新评审维度配置（管理员权限）
    /// </summary>
    [HttpPut("dimensions")]
    public async Task<IActionResult> UpdateDimensions([FromBody] List<ReviewDimensionConfig> dimensions, CancellationToken ct)
    {
        if (!HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限修改评审维度"));

        if (dimensions == null || dimensions.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "维度列表不能为空"));

        if (dimensions.Any(d => d.MaxScore <= 0))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "每个维度的满分必须大于 0"));

        var activeTotal = dimensions.Where(d => d.IsActive).Sum(d => d.MaxScore);
        if (activeTotal < 80)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"启用维度总分 {activeTotal} 分，低于通过线 80 分，请调整"));

        var userId = GetUserId();
        var now = DateTime.UtcNow;

        foreach (var dim in dimensions)
        {
            dim.UpdatedAt = now;
            dim.UpdatedBy = userId;
        }

        await _db.ReviewDimensionConfigs.DeleteManyAsync(_ => true, cancellationToken: CancellationToken.None);
        await _db.ReviewDimensionConfigs.InsertManyAsync(dimensions, cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { updated = dimensions.Count }));
    }

    // ──────────────────────────────────────────────
    // 提交管理
    // ──────────────────────────────────────────────

    /// <summary>
    /// 创建评审提交（上传方案后调用）
    /// </summary>
    [HttpPost("submissions")]
    public async Task<IActionResult> CreateSubmission([FromBody] CreateReviewSubmissionRequest req, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(req.Title))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "方案标题不能为空"));

        if (string.IsNullOrWhiteSpace(req.AttachmentId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "attachmentId 不能为空"));

        // 验证附件存在
        var attachment = await _db.Attachments.Find(x => x.AttachmentId == req.AttachmentId).FirstOrDefaultAsync(ct);
        if (attachment == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "附件不存在"));

        if (string.IsNullOrWhiteSpace(attachment.ExtractedText))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无法从文件中提取文本内容，请确认上传的是有效的 Markdown 文件"));

        var userId = GetUserId();
        var displayName = GetDisplayName() ?? userId;

        var submission = new ReviewSubmission
        {
            SubmitterId = userId,
            SubmitterName = displayName,
            Title = req.Title.Trim(),
            AttachmentId = req.AttachmentId,
            FileName = attachment.FileName,
            ExtractedContent = attachment.ExtractedText,
            Status = ReviewStatuses.Queued,
        };

        await _db.ReviewSubmissions.InsertOneAsync(submission, cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { submission }));
    }

    /// <summary>
    /// 我的提交列表（只能看自己的）
    /// </summary>
    [HttpGet("submissions")]
    public async Task<IActionResult> GetMySubmissions(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 50,
        [FromQuery] string? filter = null,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var filterBuilder = Builders<ReviewSubmission>.Filter;
        var dbFilter = filterBuilder.Eq(x => x.SubmitterId, userId);

        // "passed" 匹配前端显示逻辑：Done 且 IsPassed=true 或 IsPassed=null（历史数据）
        dbFilter = filter switch
        {
            "passed" => dbFilter & filterBuilder.Eq(x => x.Status, ReviewStatuses.Done)
                                 & (filterBuilder.Eq(x => x.IsPassed, true) | filterBuilder.Eq(x => x.IsPassed, (bool?)null)),
            "notPassed" => dbFilter & filterBuilder.Eq(x => x.IsPassed, false),
            "error" => dbFilter & filterBuilder.Eq(x => x.Status, ReviewStatuses.Error),
            _ => dbFilter,
        };

        var total = await _db.ReviewSubmissions.CountDocumentsAsync(dbFilter, cancellationToken: ct);
        var items = await _db.ReviewSubmissions.Find(dbFilter)
            .SortByDescending(x => x.SubmittedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>
    /// 全部提交列表（需要 review-agent.view-all 权限）
    /// </summary>
    [HttpGet("submissions/all")]
    public async Task<IActionResult> GetAllSubmissions(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? submitterId = null,
        [FromQuery] string? filter = null,
        CancellationToken ct = default)
    {
        if (!HasViewAllPermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看全部提交记录"));

        var filterBuilder = Builders<ReviewSubmission>.Filter;
        var dbFilter = filterBuilder.Empty;

        if (!string.IsNullOrWhiteSpace(submitterId))
            dbFilter &= filterBuilder.Eq(x => x.SubmitterId, submitterId);

        dbFilter = filter switch
        {
            "passed" => dbFilter & filterBuilder.Eq(x => x.Status, ReviewStatuses.Done)
                                 & (filterBuilder.Eq(x => x.IsPassed, true) | filterBuilder.Eq(x => x.IsPassed, (bool?)null)),
            "notPassed" => dbFilter & filterBuilder.Eq(x => x.IsPassed, false),
            "error" => dbFilter & filterBuilder.Eq(x => x.Status, ReviewStatuses.Error),
            _ => dbFilter,
        };

        var total = await _db.ReviewSubmissions.CountDocumentsAsync(dbFilter, cancellationToken: ct);
        var items = await _db.ReviewSubmissions.Find(dbFilter)
            .SortByDescending(x => x.SubmittedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>
    /// 获取曾经提交过的用户列表（需要 review-agent.view-all 权限），按最新提交时间倒序去重
    /// </summary>
    [HttpGet("submitters")]
    public async Task<IActionResult> GetSubmitters(CancellationToken ct)
    {
        if (!HasViewAllPermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限"));

        var items = await _db.ReviewSubmissions
            .Find(Builders<ReviewSubmission>.Filter.Empty)
            .SortByDescending(x => x.SubmittedAt)
            .Project(x => new { x.SubmitterId, x.SubmitterName })
            .ToListAsync(ct);

        // 按提交人去重，保留最近提交（已按时间倒序，first-seen 即为最近）
        var seen = new HashSet<string>();
        var submitters = new List<object>();
        foreach (var item in items)
        {
            if (seen.Add(item.SubmitterId))
                submitters.Add(new { id = item.SubmitterId, name = item.SubmitterName });
        }

        return Ok(ApiResponse<object>.Ok(new { submitters }));
    }

    /// <summary>
    /// 获取单个提交详情（提交人自己或 view-all 权限用户）
    /// </summary>
    [HttpGet("submissions/{id}")]
    public async Task<IActionResult> GetSubmission(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var submission = await _db.ReviewSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提交记录不存在"));

        if (submission.SubmitterId != userId && !HasViewAllPermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看该提交"));

        ReviewResult? result = null;
        if (!string.IsNullOrEmpty(submission.ResultId))
            result = await _db.ReviewResults.Find(x => x.Id == submission.ResultId).FirstOrDefaultAsync(ct);

        // 懒修复：Done 状态但 IsPassed 未写入（旧数据兼容）
        if (result != null && submission.Status == ReviewStatuses.Done && submission.IsPassed == null)
        {
            submission.IsPassed = result.IsPassed;
            await _db.ReviewSubmissions.UpdateOneAsync(
                x => x.Id == id,
                Builders<ReviewSubmission>.Update.Set(x => x.IsPassed, result.IsPassed),
                cancellationToken: CancellationToken.None);
        }

        return Ok(ApiResponse<object>.Ok(new { submission, result }));
    }

    /// <summary>
    /// 重新评审 — 清除旧结果，重置为 Queued 状态，触发重跑
    /// </summary>
    [HttpPost("submissions/{id}/rerun")]
    public async Task<IActionResult> RerunSubmission(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var submission = await _db.ReviewSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提交记录不存在"));

        if (submission.SubmitterId != userId && !HasViewAllPermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限操作该提交"));

        // 删除旧结果
        if (!string.IsNullOrEmpty(submission.ResultId))
            await _db.ReviewResults.DeleteOneAsync(x => x.Id == submission.ResultId, CancellationToken.None);

        // 重置状态
        await _db.ReviewSubmissions.UpdateOneAsync(
            x => x.Id == id,
            Builders<ReviewSubmission>.Update
                .Set(x => x.Status, ReviewStatuses.Queued)
                .Unset(x => x.ResultId)
                .Unset(x => x.IsPassed)
                .Unset(x => x.CompletedAt)
                .Unset(x => x.StartedAt)
                .Unset(x => x.ErrorMessage),
            cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { message = "已重置，请刷新页面重新评审" }));
    }

    // ──────────────────────────────────────────────
    // SSE 评审流
    // ──────────────────────────────────────────────

    /// <summary>
    /// 评审结果 SSE 流 — 实时推送评审进度和分项结果
    /// </summary>
    [HttpGet("submissions/{id}/result/stream")]
    [Produces("text/event-stream")]
    public async Task StreamReviewResult(string id, CancellationToken cancellationToken)
    {
        Response.ContentType = "text/event-stream";
        Response.Headers.CacheControl = "no-cache";
        Response.Headers.Connection = "keep-alive";

        var userId = GetUserId();

        var submission = await _db.ReviewSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(CancellationToken.None);
        if (submission == null)
        {
            await WriteSseEventAsync("error", new { message = "提交记录不存在" });
            return;
        }

        if (submission.SubmitterId != userId && !HasViewAllPermission())
        {
            await WriteSseEventAsync("error", new { message = "无权限查看该评审结果" });
            return;
        }

        // 如果已完成，直接推送缓存结果
        if (submission.Status == ReviewStatuses.Done && !string.IsNullOrEmpty(submission.ResultId))
        {
            var cached = await _db.ReviewResults.Find(x => x.Id == submission.ResultId).FirstOrDefaultAsync(CancellationToken.None);
            if (cached != null)
            {
                await WriteSseEventAsync("phase", new { phase = "completed", message = "评审已完成" });
                foreach (var dim in cached.DimensionScores)
                    await WriteSseEventAsync("dimension_score", dim);
                await WriteSseEventAsync("result", new { cached.TotalScore, cached.IsPassed, cached.Summary });
                await WriteSseEventAsync("done", new { });
                return;
            }
        }

        // 如果已失败
        if (submission.Status == ReviewStatuses.Error)
        {
            await WriteSseEventAsync("error", new { message = submission.ErrorMessage ?? "评审失败" });
            return;
        }

        // 防止并发：已在评审中则拒绝重复触发
        if (submission.Status == ReviewStatuses.Running)
        {
            await WriteSseEventAsync("error", new { message = "该方案正在评审中，请勿重复连接" });
            return;
        }

        // 标记为评审中
        await _db.ReviewSubmissions.UpdateOneAsync(
            x => x.Id == id,
            Builders<ReviewSubmission>.Update
                .Set(x => x.Status, ReviewStatuses.Running)
                .Set(x => x.StartedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        try
        {
            await RunReviewAsync(id, submission, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "ReviewAgent 评审失败: {SubmissionId}", id);
            try
            {
                await _db.ReviewSubmissions.UpdateOneAsync(
                    x => x.Id == id,
                    Builders<ReviewSubmission>.Update
                        .Set(x => x.Status, ReviewStatuses.Error)
                        .Set(x => x.ErrorMessage, ex.Message)
                        .Set(x => x.CompletedAt, DateTime.UtcNow),
                    cancellationToken: CancellationToken.None);

                await WriteSseEventAsync("error", new { message = "评审过程发生错误，请稍后重试" });
            }
            catch { /* 忽略写入错误 */ }
        }
    }

    private async Task RunReviewAsync(string submissionId, ReviewSubmission submission, CancellationToken cancellationToken)
    {
        // 获取评审维度配置
        var dims = await _db.ReviewDimensionConfigs
            .Find(x => x.IsActive)
            .SortBy(x => x.OrderIndex)
            .ToListAsync(CancellationToken.None);

        if (dims.Count == 0)
            dims = DefaultReviewDimensions.All;

        // 推送阶段：准备中
        await WriteSseEventAsync("phase", new { phase = "preparing", message = "正在准备评审..." });

        var content = submission.ExtractedContent;
        if (string.IsNullOrWhiteSpace(content))
        {
            await WriteSseEventAsync("error", new { message = "无法读取方案内容，请确认上传的文件包含文本内容" });
            await _db.ReviewSubmissions.UpdateOneAsync(
                x => x.Id == submissionId,
                Builders<ReviewSubmission>.Update
                    .Set(x => x.Status, ReviewStatuses.Error)
                    .Set(x => x.ErrorMessage, "文件内容为空"),
                cancellationToken: CancellationToken.None);
            return;
        }

        // 构建评审提示词
        var systemPrompt = BuildReviewSystemPrompt(dims);
        var userPrompt = BuildReviewUserPrompt(submission.Title, content, dims);

        // 推送阶段：分析中
        await WriteSseEventAsync("phase", new { phase = "analyzing", message = "AI 正在分析方案内容..." });

        var gatewayRequest = new GatewayRequest
        {
            AppCallerCode = AppCallerRegistry.ReviewAgent.Review.Chat,
            ModelType = ModelTypes.Chat,
            Stream = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray
                {
                    new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
                    new JsonObject { ["role"] = "user", ["content"] = userPrompt }
                },
                ["temperature"] = 0.3,
                ["max_tokens"] = 8192,
            },
        };

        var fullContent = new StringBuilder();
        string? gatewayError = null;

        await WriteSseEventAsync("phase", new { phase = "scoring", message = "正在逐维度评分..." });

        await foreach (var chunk in _gateway.StreamAsync(gatewayRequest, CancellationToken.None))
        {
            if (chunk.Type == GatewayChunkType.Text && !string.IsNullOrEmpty(chunk.Content))
            {
                fullContent.Append(chunk.Content);
                try
                {
                    await WriteSseEventAsync("typing", new { text = chunk.Content });
                }
                catch (ObjectDisposedException) { break; }
                catch (OperationCanceledException) { break; }
            }
            else if (chunk.Type == GatewayChunkType.Error)
            {
                gatewayError = chunk.Error ?? chunk.Content ?? "网关返回未知错误";
                _logger.LogError("ReviewAgent 网关错误 [{SubmissionId}]: {Error}", submissionId, gatewayError);
                break;
            }
        }

        // 网关错误：标记失败并返回
        if (gatewayError != null)
        {
            await _db.ReviewSubmissions.UpdateOneAsync(
                x => x.Id == submissionId,
                Builders<ReviewSubmission>.Update
                    .Set(x => x.Status, ReviewStatuses.Error)
                    .Set(x => x.ErrorMessage, $"LLM 网关错误: {gatewayError}"),
                cancellationToken: CancellationToken.None);
            try { await WriteSseEventAsync("error", new { message = $"LLM 网关错误: {gatewayError}" }); }
            catch { /* 客户端已断开 */ }
            return;
        }

        // 解析 LLM 输出
        var llmOutput = fullContent.ToString();
        var (dimensionScores, summary, parseError) = ParseReviewOutput(llmOutput, dims);

        var totalScore = dimensionScores.Sum(d => d.Score);
        var isPassed = totalScore >= 80;

        // 推送分项结果
        foreach (var dimScore in dimensionScores)
        {
            try
            {
                await WriteSseEventAsync("dimension_score", dimScore);
            }
            catch (ObjectDisposedException) { break; }
        }

        // 保存结果
        var result = new ReviewResult
        {
            SubmissionId = submissionId,
            DimensionScores = dimensionScores,
            TotalScore = totalScore,
            IsPassed = isPassed,
            Summary = summary,
            FullMarkdown = llmOutput,
            ParseError = parseError,
        };

        await _db.ReviewResults.InsertOneAsync(result, cancellationToken: CancellationToken.None);

        // 更新提交状态
        await _db.ReviewSubmissions.UpdateOneAsync(
            x => x.Id == submissionId,
            Builders<ReviewSubmission>.Update
                .Set(x => x.Status, ReviewStatuses.Done)
                .Set(x => x.ResultId, result.Id)
                .Set(x => x.IsPassed, isPassed)
                .Set(x => x.CompletedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        // 发送完成通知给提交人
        var actionUrl = $"/review-agent/submissions/{submissionId}";
        var passText = isPassed ? "已通过" : "未通过";
        var notification = new AdminNotification
        {
            TargetUserId = submission.SubmitterId,
            Title = $"方案《{submission.Title}》评审完成",
            Message = $"得分 {totalScore} 分，{passText}。点击查看详细评审报告。",
            Level = isPassed ? "success" : "warning",
            Source = AppKey,
            ActionLabel = "查看报告",
            ActionUrl = actionUrl,
            ActionKind = "navigate",
        };
        await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: CancellationToken.None);

        // 推送 Webhook 通知到企微/钉钉/飞书
        await _webhookService.NotifyReviewCompletedAsync(submission, totalScore, isPassed, summary);

        // 推送最终结果
        try
        {
            await WriteSseEventAsync("result", new { totalScore, isPassed, summary });
            await WriteSseEventAsync("done", new { });
        }
        catch (ObjectDisposedException) { /* 客户端已断开，忽略 */ }
    }

    // ──────────────────────────────────────────────
    // 私有工具方法
    // ──────────────────────────────────────────────

    private static string BuildReviewSystemPrompt(List<ReviewDimensionConfig> dims)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是一位严格的资深产品评审专家，负责对产品方案进行专业、客观、严格的评审打分。");
        sb.AppendLine();
        sb.AppendLine("## 评审原则（必须遵守）");
        sb.AppendLine();
        sb.AppendLine("1. **严格评分，宁可严格不宽松**：80分以上才算通过，代表方案质量较高。普通流水账式方案应在50-65分区间，有明显不足的在40-55分。");
        sb.AppendLine("2. **必须有证据支撑**：每项评分必须能在方案中找到具体对应内容。方案内容空洞、表述模糊、缺乏具体数据/标准的，必须严格扣分。");
        sb.AppendLine("3. **拒绝虚高分**：禁止给出\"意思意思\"的高分。如果某维度内容缺失或质量差，应给出0-60%的得分率，不得因为方案提交了就打高分。");
        sb.AppendLine("4. **评语要具体**：comment 必须指出方案中**具体缺失或不足的地方**（引用原文或点明缺少的章节/内容），而非泛泛而谈。");
        sb.AppendLine("5. **分级参考**：");
        sb.AppendLine("   - 90%+ 得分率：内容完整、质量优秀、逻辑严密，几乎无可挑剔");
        sb.AppendLine("   - 75-90% 得分率：内容基本完整，有小瑕疵但整体达标");
        sb.AppendLine("   - 60-75% 得分率：核心内容存在但不够充分，需改进");
        sb.AppendLine("   - 60% 以下得分率：内容明显缺失或质量低下，需重写");
        sb.AppendLine();
        sb.AppendLine("## 评审维度与评分标准");
        sb.AppendLine();
        foreach (var dim in dims)
        {
            sb.AppendLine($"### {dim.Name}（满分 {dim.MaxScore} 分）");
            sb.AppendLine(dim.Description);
            if (dim.Items != null && dim.Items.Count > 0)
            {
                sb.AppendLine();
                sb.AppendLine($"**该维度是清单类**，共 {dim.Items.Count} 项检查点。方案文档里**应有一张对应表格**，包含「检查项 / 是否涉及 / 方案是否包含」三列，用户在每一行的两个复选框列里勾选 `[√]是 / [√]否 / [ ]未勾`。");
                sb.AppendLine();
                sb.AppendLine("你的任务**不是自己判断涉及与否**，而是按下面三步操作：");
                sb.AppendLine();
                sb.AppendLine("**第 1 步：读出用户在表格里的实际勾选**");
                sb.AppendLine("- `involvedChecked`：用户在「是否涉及」列勾的是 `yes` / `no` / `none`（找不到这一行 或 两个框都没勾）");
                sb.AppendLine("- `coverageChecked`：用户在「方案是否包含」列勾的是 `yes` / `no` / `none`");
                sb.AppendLine("- 注意：表格可能用 `[√]`、`[x]`、`☑`、`✓`、`■`、`【是】`、`(是)`、加粗的「是/否」、单元格背景色、明确的「是/否」汉字 等任意方式表示勾选。多种线索都要识别。");
                sb.AppendLine("- 如果方案文档里**没有这张清单表格**，所有项的 involvedChecked 与 coverageChecked 都填 `none`。");
                sb.AppendLine();
                sb.AppendLine("**第 2 步：反作弊核查**（仅当 `involvedChecked=yes` 且 `coverageChecked=yes` 时执行）");
                sb.AppendLine("- 在方案正文（实现思路、设计章节等）里检索是否真的写出了对应规则的解决方案。");
                sb.AppendLine("- 找到对应内容 → `solutionFound=true`；找不到（用户勾了但正文未提）→ `solutionFound=false`。");
                sb.AppendLine("- 其他场景 `solutionFound=null`（不需要核查）。");
                sb.AppendLine();
                sb.AppendLine("**第 3 步：填写 evidence**（≤80 字）");
                sb.AppendLine("- 简述你看到了什么：「表格中此项勾选『涉及=是、包含=是』，正文 X 章节确实写明…」");
                sb.AppendLine("- 或失败原因：「表格未勾选」「表格勾涉及=是但未勾包含」「勾了已包含但正文未找到」「方案未提供检查清单表格」。");
                sb.AppendLine();
                sb.AppendLine("**通过判定由系统按 truth table 自动派生（你不需要也不应该自己判 passed）**：");
                sb.AppendLine("| involvedChecked | coverageChecked | solutionFound | 系统判定 |");
                sb.AppendLine("|---|---|---|---|");
                sb.AppendLine("| none | * | * | 不通过（未勾选视为未完成）|");
                sb.AppendLine("| no | * | * | 通过（用户声明不涉及）|");
                sb.AppendLine("| yes | none | * | 不通过（涉及但未声明是否包含）|");
                sb.AppendLine("| yes | no | * | 不通过（用户自认未包含）|");
                sb.AppendLine("| yes | yes | true | 通过（勾且方案确有写）|");
                sb.AppendLine("| yes | yes | false | 不通过（勾了但方案中找不到，作弊）|");
                sb.AppendLine();
                sb.AppendLine("**得分公式**：`MaxScore × 通过项数 / 总项数` 向下取整，由系统按上表自动计算（你仍需输出 score，系统会覆盖）。");
                sb.AppendLine();
                sb.AppendLine("检查项清单（id 必须原样回填）：");
                var byCategory = dim.Items.GroupBy(x => x.Category);
                foreach (var grp in byCategory)
                {
                    sb.AppendLine($"- **{grp.Key}**");
                    foreach (var item in grp)
                    {
                        var noteSuffix = string.IsNullOrWhiteSpace(item.Note) ? "" : $"（备注：{item.Note}）";
                        sb.AppendLine($"  - `{item.Id}`：{item.Text}{noteSuffix}");
                    }
                }
                sb.AppendLine();
            }
            sb.AppendLine();
        }
        sb.AppendLine("## 输出格式要求");
        sb.AppendLine();
        sb.AppendLine("请严格按照以下 JSON 格式输出评审结果，不要输出其他内容：");
        sb.AppendLine();
        sb.AppendLine("```json");
        sb.AppendLine("{");
        sb.AppendLine("  \"dimensions\": [");
        for (int i = 0; i < dims.Count; i++)
        {
            var dim = dims[i];
            var comma = i < dims.Count - 1 ? "," : "";
            if (dim.Items != null && dim.Items.Count > 0)
            {
                sb.AppendLine($"    {{");
                sb.AppendLine($"      \"key\": \"{dim.Key}\",");
                sb.AppendLine($"      \"score\": <0-{dim.MaxScore}的整数，系统会按 items 自动重算>,");
                sb.AppendLine($"      \"comment\": \"<对整份清单的综合点评：用户填表完整度、勾选作弊嫌疑、最关键的遗漏项，100字以内>\",");
                sb.AppendLine($"      \"items\": [");
                for (int j = 0; j < dim.Items.Count; j++)
                {
                    var item = dim.Items[j];
                    var itemComma = j < dim.Items.Count - 1 ? "," : "";
                    sb.AppendLine($"        {{ \"id\": \"{item.Id}\", \"involvedChecked\": \"<yes|no|none>\", \"coverageChecked\": \"<yes|no|none>\", \"solutionFound\": <true|false|null>, \"evidence\": \"<≤80字：用户勾选了什么 + 正文核查结果 / 失败原因>\" }}{itemComma}");
                }
                sb.AppendLine($"      ]");
                sb.AppendLine($"    }}{comma}");
            }
            else
            {
                sb.AppendLine($"    {{ \"key\": \"{dim.Key}\", \"score\": <0-{dim.MaxScore}的整数>, \"comment\": \"<该维度的具体评价，指出具体不足或亮点，100字以内>\" }}{comma}");
            }
        }
        sb.AppendLine("  ],");
        sb.AppendLine("  \"summary\": \"<总体评语，完整输出不限字数，先指出最主要的不足，再说优点，给出改进方向>\"");
        sb.AppendLine("}");
        sb.AppendLine("```");
        return sb.ToString();
    }

    private static string BuildReviewUserPrompt(string title, string content, List<ReviewDimensionConfig> dims)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"请严格评审以下产品方案《{title}》，按各维度评分标准客观打分：");
        sb.AppendLine();
        sb.AppendLine("---");
        sb.AppendLine(content);
        sb.AppendLine("---");
        sb.AppendLine();
        sb.AppendLine("注意：评审要严格，对内容不足、逻辑不清、描述空洞的地方必须扣分，comment 中要指出具体问题。输出 JSON 格式结果。");
        return sb.ToString();
    }

    private static (List<ReviewDimensionScore> scores, string summary, string? parseError) ParseReviewOutput(
        string llmOutput, List<ReviewDimensionConfig> dims)
    {
        var scores = new List<ReviewDimensionScore>();
        var summary = string.Empty;
        string? parseError = null;

        if (string.IsNullOrWhiteSpace(llmOutput))
        {
            parseError = "LLM 返回空内容（网关未输出任何文本）";
        }
        else
        {
            // ── 策略 1: JSON 解析（两次尝试：原始 → 修复换行后） ──
            parseError = TryParseJson(llmOutput, dims, scores, ref summary);

            // ── 策略 2: 如果 JSON 失败或没有解析到任何维度，用正则兜底 ──
            if (scores.Count == 0)
            {
                var regexError = TryParseWithRegex(llmOutput, dims, scores);
                if (scores.Count > 0)
                    parseError = null; // 正则成功，清除错误
                else
                    parseError = $"JSON解析: {parseError ?? "无JSON块"} | 正则解析: {regexError}";
            }
        }

        // 补全未解析到的维度（清单类维度的 items 按「未勾选」失败处理）
        var parsedKeys = scores.Select(s => s.Key).ToHashSet();
        foreach (var dim in dims.Where(d => !parsedKeys.Contains(d.Key)))
        {
            List<DimensionCheckItemResult>? missingItems = null;
            if (dim.Items != null && dim.Items.Count > 0)
            {
                missingItems = dim.Items.Select(it => new DimensionCheckItemResult
                {
                    Id = it.Id,
                    Category = it.Category,
                    Text = it.Text,
                    InvolvedChecked = "none",
                    CoverageChecked = "none",
                    SolutionFound = null,
                    Passed = false,
                    Evidence = "LLM 输出未涵盖该项，按「未勾选」处理",
                }).ToList();
            }
            scores.Add(new ReviewDimensionScore
            {
                Key = dim.Key,
                Name = dim.Name,
                Score = 0,
                MaxScore = dim.MaxScore,
                Comment = parseError != null ? "解析失败" : "未在输出中找到",
                Items = missingItems,
            });
        }

        // 为清单类维度补齐 items 中缺失的项（LLM 可能漏报某几项，按「未勾选」严格判失败）
        foreach (var score in scores)
        {
            var dimConfig = dims.FirstOrDefault(d => d.Key == score.Key);
            if (dimConfig?.Items == null || dimConfig.Items.Count == 0) continue;
            score.Items ??= new List<DimensionCheckItemResult>();

            var haveIds = score.Items.Select(i => i.Id).ToHashSet();
            foreach (var itemConfig in dimConfig.Items.Where(i => !haveIds.Contains(i.Id)))
            {
                score.Items.Add(new DimensionCheckItemResult
                {
                    Id = itemConfig.Id,
                    Category = itemConfig.Category,
                    Text = itemConfig.Text,
                    InvolvedChecked = "none",
                    CoverageChecked = "none",
                    SolutionFound = null,
                    Passed = false,
                    Evidence = "LLM 输出未涵盖该项，按「未勾选」处理",
                });
            }
            // 按配置顺序重排
            score.Items = dimConfig.Items
                .Select(cfg => score.Items.First(i => i.Id == cfg.Id))
                .ToList();
            // 重算最终分数（系统派生 Passed → 公式重算，避免 LLM 自填的 score 干扰）
            score.Score = ComputeChecklistScore(dimConfig.MaxScore, score.Items);
        }

        // ── summary 兜底提取（如果 JSON 解析没拿到或拿到空值） ──
        if (string.IsNullOrEmpty(summary) && !string.IsNullOrWhiteSpace(llmOutput))
        {
            summary = ExtractSummaryFromRawOutput(llmOutput);
        }

        // ── 不再做截断检测 ──
        // 之前的截断检测误判率太高（LLM 输出完整但结尾字符不在白名单中），
        // 导致正常 summary 被追加错误提示。如果 summary 确实不完整，用户可以重新评审。

        return (scores, summary, parseError);
    }

    /// <summary>
    /// 从原始 LLM 输出中提取 summary 字段值（纯字符串搜索，不依赖 JSON 解析）
    /// </summary>
    private static string ExtractSummaryFromRawOutput(string llmOutput)
    {
        // 找 "summary" 关键字位置
        var idx = llmOutput.IndexOf("\"summary\"", StringComparison.OrdinalIgnoreCase);
        if (idx < 0) return string.Empty;

        // 找冒号
        var colonIdx = llmOutput.IndexOf(':', idx + 9);
        if (colonIdx < 0) return string.Empty;

        // 找开始引号
        var quoteStart = llmOutput.IndexOf('"', colonIdx + 1);
        if (quoteStart < 0) return string.Empty;

        // 从开始引号后面，向前找关闭引号（跳过转义的 \"）
        var afterQuote = llmOutput[(quoteStart + 1)..];

        // 策略：从后往前找最后一个未转义的 "，这是 summary 值的结束
        // 但要排除 JSON 结构符号之后的内容（} 后面的 " 不算）
        // 先找 JSON 闭合的 }
        var lastBrace = afterQuote.LastIndexOf('}');
        var searchEnd = lastBrace >= 0 ? lastBrace : afterQuote.Length;

        var endIdx = -1;
        for (var i = searchEnd - 1; i >= 0; i--)
        {
            if (afterQuote[i] == '"' && (i == 0 || afterQuote[i - 1] != '\\'))
            {
                endIdx = i;
                break;
            }
        }

        if (endIdx <= 0) return string.Empty;

        return afterQuote[..endIdx]
            .Replace("\\n", "\n")
            .Replace("\\r", "")
            .Replace("\\\"", "\"")
            .Replace("\\t", "\t")
            .Replace("\\\\", "\\");
    }

    private static string? TryParseJson(string llmOutput, List<ReviewDimensionConfig> dims,
        List<ReviewDimensionScore> scores, ref string summary)
    {
        try
        {
            var jsonStr = TryExtractJsonBlock(llmOutput);
            if (jsonStr == null) return "未找到 JSON 块";

            // 预处理：修复 LLM 输出的 JSON 中字符串值内的未转义换行
            // JSON 规范要求字符串值内的换行必须转义为 \n，但 LLM 常输出字面换行
            jsonStr = FixUnescapedNewlinesInJsonStrings(jsonStr);

            var doc = JsonDocument.Parse(jsonStr, new JsonDocumentOptions
            {
                AllowTrailingCommas = true,
                CommentHandling = JsonCommentHandling.Skip,
            });

            if (doc.RootElement.TryGetProperty("summary", out var summaryEl))
                summary = summaryEl.GetString() ?? string.Empty;
            // 兜底：大小写不敏感查找 summary
            if (string.IsNullOrEmpty(summary))
            {
                foreach (var prop in doc.RootElement.EnumerateObject())
                {
                    if (string.Equals(prop.Name, "summary", StringComparison.OrdinalIgnoreCase))
                    {
                        summary = prop.Value.GetString() ?? string.Empty;
                        break;
                    }
                }
            }

            if (!doc.RootElement.TryGetProperty("dimensions", out var dimsEl))
                return $"JSON 解析成功但缺少 dimensions 字段，根节点字段: {string.Join(", ", doc.RootElement.EnumerateObject().Select(p => p.Name))}";

            var dimMap = dims.ToDictionary(d => d.Key);
            foreach (var dimEl in dimsEl.EnumerateArray())
            {
                var key = dimEl.TryGetProperty("key", out var keyEl) ? keyEl.GetString() ?? "" : "";
                var score = dimEl.TryGetProperty("score", out var scoreEl) ? ParseScore(scoreEl) : 0;
                var comment = dimEl.TryGetProperty("comment", out var commentEl) ? commentEl.GetString() ?? "" : "";

                if (dimMap.TryGetValue(key, out var dimConfig))
                {
                    List<DimensionCheckItemResult>? itemResults = null;
                    int finalScore = Math.Clamp(score, 0, dimConfig.MaxScore);

                    // 清单类维度：按 items[] 强制重算分数
                    if (dimConfig.Items != null && dimConfig.Items.Count > 0)
                    {
                        itemResults = BuildItemResults(dimEl, dimConfig.Items);
                        finalScore = ComputeChecklistScore(dimConfig.MaxScore, itemResults);
                    }

                    scores.Add(new ReviewDimensionScore
                    {
                        Key = key,
                        Name = dimConfig.Name,
                        Score = finalScore,
                        MaxScore = dimConfig.MaxScore,
                        Comment = comment,
                        Items = itemResults,
                    });
                }
            }
            return null; // 成功
        }
        catch (Exception ex)
        {
            return $"JSON 异常: {ex.Message}";
        }
    }

    private static string? TryParseWithRegex(string llmOutput, List<ReviewDimensionConfig> dims,
        List<ReviewDimensionScore> scores)
    {
        // 在原始文本中用正则提取 "key": "xxx", "score": 数字 配对
        var dimMap = dims.ToDictionary(d => d.Key);
        var keyPattern = new System.Text.RegularExpressions.Regex(
            @"""key""\s*:\s*""([^""]+)""\s*,\s*""score""\s*:\s*(\d+(?:\.\d+)?)",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        var commentPattern = new System.Text.RegularExpressions.Regex(
            @"""comment""\s*:\s*""([^""\\]*(?:\\.[^""\\]*)*)""");

        var matches = keyPattern.Matches(llmOutput);
        if (matches.Count == 0)
            return $"正则也未找到 key/score 对（输出前200字: {llmOutput[..Math.Min(200, llmOutput.Length)].Replace("\n", "\\n")})";

        // 按 key 找最近的 comment
        foreach (System.Text.RegularExpressions.Match m in matches)
        {
            var key = m.Groups[1].Value;
            var score = (int)Math.Round(double.Parse(m.Groups[2].Value));

            if (!dimMap.TryGetValue(key, out var dimConfig)) continue;
            if (scores.Any(s => s.Key == key)) continue;

            // 在 match 位置附近找 comment
            var segment = llmOutput[m.Index..Math.Min(m.Index + 300, llmOutput.Length)];
            var cm = commentPattern.Match(segment);
            var comment = cm.Success ? cm.Groups[1].Value : "";

            scores.Add(new ReviewDimensionScore
            {
                Key = key,
                Name = dimConfig.Name,
                Score = Math.Clamp(score, 0, dimConfig.MaxScore),
                MaxScore = dimConfig.MaxScore,
                Comment = comment,
            });
        }
        return scores.Count == 0 ? "找到 key/score 对但 key 不在维度列表中" : null;
    }

    private static int ParseScore(JsonElement scoreEl) => scoreEl.ValueKind switch
    {
        JsonValueKind.Number => (int)Math.Round(scoreEl.GetDouble()),
        JsonValueKind.String => int.TryParse(scoreEl.GetString(), out var v) ? v :
                                double.TryParse(scoreEl.GetString(), out var d) ? (int)Math.Round(d) : 0,
        _ => 0,
    };

    /// <summary>
    /// 从维度 JSON 元素中提取 items[] 并映射到配置中的检查项（按 id 匹配，遗漏项由上层兜底补齐）。
    /// 每项的 Passed 由系统按 truth table 派生，不取 LLM 自填值。
    /// </summary>
    private static List<DimensionCheckItemResult> BuildItemResults(
        JsonElement dimEl, List<DimensionCheckItem> configItems)
    {
        var results = new List<DimensionCheckItemResult>();
        if (!dimEl.TryGetProperty("items", out var itemsEl) || itemsEl.ValueKind != JsonValueKind.Array)
            return results;

        var cfgMap = configItems.ToDictionary(c => c.Id);
        foreach (var itemEl in itemsEl.EnumerateArray())
        {
            var id = itemEl.TryGetProperty("id", out var idEl) ? idEl.GetString() ?? "" : "";
            if (string.IsNullOrEmpty(id) || !cfgMap.TryGetValue(id, out var cfg)) continue;
            if (results.Any(r => r.Id == id)) continue; // 去重

            var involvedChecked = NormalizeCheckboxState(
                itemEl.TryGetProperty("involvedChecked", out var invEl) ? invEl.GetString() : null);
            var coverageChecked = NormalizeCheckboxState(
                itemEl.TryGetProperty("coverageChecked", out var covEl) ? covEl.GetString() : null);
            var solutionFound = ParseNullableBool(
                itemEl.TryGetProperty("solutionFound", out var solEl) ? solEl : default);
            var evidence = itemEl.TryGetProperty("evidence", out var evEl) ? evEl.GetString() : null;

            results.Add(new DimensionCheckItemResult
            {
                Id = id,
                Category = cfg.Category,
                Text = cfg.Text,
                InvolvedChecked = involvedChecked,
                CoverageChecked = coverageChecked,
                SolutionFound = solutionFound,
                Passed = DerivePassed(involvedChecked, coverageChecked, solutionFound),
                Evidence = evidence,
            });
        }
        return results;
    }

    /// <summary>
    /// 把 LLM 输出的勾选状态归一化为 "yes" / "no" / "none"，兼容多种写法。
    /// </summary>
    private static string NormalizeCheckboxState(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "none";
        var s = raw.Trim().ToLowerInvariant();
        if (s is "yes" or "y" or "true" or "1" or "是" or "✓" or "√") return "yes";
        if (s is "no" or "n" or "false" or "0" or "否" or "✗" or "x") return "no";
        return "none";
    }

    private static bool? ParseNullableBool(JsonElement el) => el.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.String when bool.TryParse(el.GetString(), out var b) => b,
        _ => null,
    };

    /// <summary>
    /// Truth table（系统派生 passed，不让 LLM 自己算）：
    ///   involvedChecked=none → 失败（用户未勾选）
    ///   involvedChecked=no   → 通过
    ///   involvedChecked=yes & coverageChecked=none → 失败
    ///   involvedChecked=yes & coverageChecked=no   → 失败（用户自认未包含）
    ///   involvedChecked=yes & coverageChecked=yes  → solutionFound==true 才通过（反作弊核查）
    /// </summary>
    private static bool DerivePassed(string involvedChecked, string coverageChecked, bool? solutionFound)
    {
        if (involvedChecked == "no") return true;
        if (involvedChecked != "yes") return false;
        if (coverageChecked != "yes") return false;
        return solutionFound == true;
    }

    /// <summary>
    /// 清单类维度得分公式：MaxScore × 通过项数 / 总项数，向下取整。
    /// </summary>
    private static int ComputeChecklistScore(int maxScore, List<DimensionCheckItemResult> items)
    {
        if (items.Count == 0) return 0;
        var passed = items.Count(i => i.Passed);
        return (int)Math.Floor((double)maxScore * passed / items.Count);
    }

    /// <summary>
    /// 修复 JSON 字符串值中未转义的换行符。
    /// LLM 常在 JSON 字符串值内输出字面换行（非法），需替换为 \n 转义。
    /// </summary>
    private static string FixUnescapedNewlinesInJsonStrings(string json)
    {
        var sb = new StringBuilder(json.Length);
        var inString = false;
        for (var i = 0; i < json.Length; i++)
        {
            var c = json[i];
            if (c == '"' && (i == 0 || json[i - 1] != '\\'))
            {
                inString = !inString;
                sb.Append(c);
            }
            else if (inString && c == '\n')
            {
                sb.Append("\\n");
            }
            else if (inString && c == '\r')
            {
                // skip \r (will be covered by \n in \r\n)
            }
            else
            {
                sb.Append(c);
            }
        }
        return sb.ToString();
    }

    private static string? TryExtractJsonBlock(string output)
    {
        // 先尝试从代码块中剥离 fence 标记，得到内层内容
        // 注意：用非贪婪 [\s\S]*? 匹配 fence 内容本身是正确的（找最近的结束 fence）
        // 但不能用非贪婪来找 {}，必须用 IndexOf/LastIndexOf 找最外层花括号
        string searchTarget = output;
        var fenceMatch = System.Text.RegularExpressions.Regex.Match(
            output, @"```(?:json)?\s*([\s\S]*?)\s*```",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        if (fenceMatch.Success)
            searchTarget = fenceMatch.Groups[1].Value;

        // 用 IndexOf / LastIndexOf 找最外层 { ... }，正确处理嵌套 JSON
        var start = searchTarget.IndexOf('{');
        var end = searchTarget.LastIndexOf('}');
        return (start >= 0 && end > start) ? searchTarget[start..(end + 1)] : null;
    }

    private async Task WriteSseEventAsync(string eventType, object data)
    {
        var json = JsonSerializer.Serialize(data, new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        });
        try
        {
            await Response.WriteAsync($"event: {eventType}\ndata: {json}\n\n");
            await Response.Body.FlushAsync();
        }
        catch (ObjectDisposedException) { }
        catch (OperationCanceledException) { }
    }
    // ──────────────────────────────────────────────
    // Webhook 配置（全局，manage 权限）
    // ──────────────────────────────────────────────

    /// <summary>获取 Webhook 配置列表</summary>
    [HttpGet("webhooks")]
    public async Task<IActionResult> ListWebhooks()
    {
        if (!HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "需要管理权限"));

        var items = await _db.ReviewWebhookConfigs
            .Find(_ => true)
            .SortByDescending(w => w.CreatedAt)
            .ToListAsync(CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>创建 Webhook 配置</summary>
    [HttpPost("webhooks")]
    public async Task<IActionResult> CreateWebhook([FromBody] CreateReviewWebhookRequest req)
    {
        if (!HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "需要管理权限"));

        if (string.IsNullOrWhiteSpace(req.WebhookUrl))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "Webhook URL 不能为空"));

        var validChannels = new[] { WebhookChannel.WeCom, WebhookChannel.DingTalk, WebhookChannel.Feishu, WebhookChannel.Custom };
        if (!validChannels.Contains(req.Channel))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", $"不支持的渠道: {req.Channel}"));

        var config = new ReviewWebhookConfig
        {
            Channel = req.Channel,
            WebhookUrl = req.WebhookUrl.Trim(),
            TriggerEvents = req.TriggerEvents ?? new List<string>(ReviewEventType.All),
            IsEnabled = req.IsEnabled ?? true,
            Name = req.Name?.Trim(),
            MentionAll = req.MentionAll ?? false,
            CreatedBy = GetUserId(),
        };

        await _db.ReviewWebhookConfigs.InsertOneAsync(config, cancellationToken: CancellationToken.None);
        return Created($"/api/review-agent/webhooks/{config.Id}",
            ApiResponse<object>.Ok(new { webhook = config }));
    }

    /// <summary>更新 Webhook 配置</summary>
    [HttpPut("webhooks/{webhookId}")]
    public async Task<IActionResult> UpdateWebhook(string webhookId, [FromBody] UpdateReviewWebhookRequest req)
    {
        if (!HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "需要管理权限"));

        var existing = await _db.ReviewWebhookConfigs.Find(w => w.Id == webhookId).FirstOrDefaultAsync();
        if (existing == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "Webhook 配置不存在"));

        var updates = new List<UpdateDefinition<ReviewWebhookConfig>>();

        if (req.WebhookUrl != null)
        {
            if (string.IsNullOrWhiteSpace(req.WebhookUrl))
                return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "Webhook URL 不能为空"));
            updates.Add(Builders<ReviewWebhookConfig>.Update.Set(w => w.WebhookUrl, req.WebhookUrl.Trim()));
        }
        if (req.Channel != null)
            updates.Add(Builders<ReviewWebhookConfig>.Update.Set(w => w.Channel, req.Channel));
        if (req.TriggerEvents != null)
            updates.Add(Builders<ReviewWebhookConfig>.Update.Set(w => w.TriggerEvents, req.TriggerEvents));
        if (req.IsEnabled.HasValue)
            updates.Add(Builders<ReviewWebhookConfig>.Update.Set(w => w.IsEnabled, req.IsEnabled.Value));
        if (req.Name != null)
            updates.Add(Builders<ReviewWebhookConfig>.Update.Set(w => w.Name, req.Name.Trim()));
        if (req.MentionAll.HasValue)
            updates.Add(Builders<ReviewWebhookConfig>.Update.Set(w => w.MentionAll, req.MentionAll.Value));

        if (updates.Count == 0)
            return Ok(ApiResponse<object>.Ok(new { webhook = existing }));

        updates.Add(Builders<ReviewWebhookConfig>.Update.Set(w => w.UpdatedAt, DateTime.UtcNow));
        await _db.ReviewWebhookConfigs.UpdateOneAsync(
            w => w.Id == webhookId,
            Builders<ReviewWebhookConfig>.Update.Combine(updates),
            cancellationToken: CancellationToken.None);

        var updated = await _db.ReviewWebhookConfigs.Find(w => w.Id == webhookId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { webhook = updated }));
    }

    /// <summary>删除 Webhook 配置</summary>
    [HttpDelete("webhooks/{webhookId}")]
    public async Task<IActionResult> DeleteWebhook(string webhookId)
    {
        if (!HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "需要管理权限"));

        var result = await _db.ReviewWebhookConfigs.DeleteOneAsync(
            w => w.Id == webhookId, cancellationToken: CancellationToken.None);

        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "Webhook 配置不存在"));

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>测试 Webhook 连通性</summary>
    [HttpPost("webhooks/test")]
    public async Task<IActionResult> TestWebhook([FromBody] TestReviewWebhookRequest req)
    {
        if (!HasManagePermission())
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "需要管理权限"));

        if (string.IsNullOrWhiteSpace(req.WebhookUrl))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "Webhook URL 不能为空"));

        var (success, error) = await _webhookService.SendTestAsync(req.WebhookUrl.Trim(), req.Channel ?? WebhookChannel.WeCom, req.MentionAll);
        return Ok(ApiResponse<object>.Ok(new { success, error }));
    }
}

// ──────────────────────────────────────────────
// 请求模型
// ──────────────────────────────────────────────

public record CreateReviewSubmissionRequest(string Title, string AttachmentId);

public class CreateReviewWebhookRequest
{
    public string Channel { get; set; } = WebhookChannel.WeCom;
    public string WebhookUrl { get; set; } = string.Empty;
    public List<string>? TriggerEvents { get; set; }
    public bool? IsEnabled { get; set; }
    public string? Name { get; set; }
    public bool? MentionAll { get; set; }
}

public class UpdateReviewWebhookRequest
{
    public string? Channel { get; set; }
    public string? WebhookUrl { get; set; }
    public List<string>? TriggerEvents { get; set; }
    public bool? IsEnabled { get; set; }
    public string? Name { get; set; }
    public bool? MentionAll { get; set; }
}

public class TestReviewWebhookRequest
{
    public string WebhookUrl { get; set; } = string.Empty;
    public string? Channel { get; set; }
    public bool MentionAll { get; set; }
}
