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

    public ReviewAgentController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILogger<ReviewAgentController> logger)
    {
        _db = db;
        _gateway = gateway;
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
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = GetUserId();
        var filter = Builders<ReviewSubmission>.Filter.Eq(x => x.SubmitterId, userId);

        var total = await _db.ReviewSubmissions.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.ReviewSubmissions.Find(filter)
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
        [FromQuery] string? status = null,
        CancellationToken ct = default)
    {
        if (!HasViewAllPermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看全部提交记录"));

        var filterBuilder = Builders<ReviewSubmission>.Filter;
        var filter = filterBuilder.Empty;

        if (!string.IsNullOrWhiteSpace(submitterId))
            filter &= filterBuilder.Eq(x => x.SubmitterId, submitterId);

        if (!string.IsNullOrWhiteSpace(status))
            filter &= filterBuilder.Eq(x => x.Status, status);

        var total = await _db.ReviewSubmissions.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.ReviewSubmissions.Find(filter)
            .SortByDescending(x => x.SubmittedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
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

        return Ok(ApiResponse<object>.Ok(new { submission, result }));
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
                ["max_tokens"] = 4000,
            },
        };

        var fullContent = new StringBuilder();

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
        }

        // 解析 LLM 输出
        var llmOutput = fullContent.ToString();
        var (dimensionScores, summary) = ParseReviewOutput(llmOutput, dims);

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
        };

        await _db.ReviewResults.InsertOneAsync(result, cancellationToken: CancellationToken.None);

        // 更新提交状态
        await _db.ReviewSubmissions.UpdateOneAsync(
            x => x.Id == submissionId,
            Builders<ReviewSubmission>.Update
                .Set(x => x.Status, ReviewStatuses.Done)
                .Set(x => x.ResultId, result.Id)
                .Set(x => x.CompletedAt, DateTime.UtcNow),
            cancellationToken: CancellationToken.None);

        // 发送完成通知给提交人
        var actionUrl = $"/review-agent/submissions/{submissionId}";
        var passText = isPassed ? "通过" : "不通过";
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
        sb.AppendLine("你是一位资深产品评审专家，负责对产品方案进行专业评审和打分。");
        sb.AppendLine();
        sb.AppendLine("## 评审维度与评分标准");
        sb.AppendLine();
        foreach (var dim in dims)
        {
            sb.AppendLine($"### {dim.Name}（满分 {dim.MaxScore} 分）");
            sb.AppendLine(dim.Description);
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
            sb.AppendLine($"    {{ \"key\": \"{dim.Key}\", \"score\": <0-{dim.MaxScore}的整数>, \"comment\": \"<该维度的具体评价，50字以内>\" }}{comma}");
        }
        sb.AppendLine("  ],");
        sb.AppendLine("  \"summary\": \"<100字以内的总体评语，指出最主要的优点和不足>\"");
        sb.AppendLine("}");
        sb.AppendLine("```");
        return sb.ToString();
    }

    private static string BuildReviewUserPrompt(string title, string content, List<ReviewDimensionConfig> dims)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"请对以下产品方案《{title}》进行评审打分：");
        sb.AppendLine();
        sb.AppendLine("---");
        sb.AppendLine(content);
        sb.AppendLine("---");
        sb.AppendLine();
        sb.AppendLine("请按照系统提示中的评审维度逐项评分，输出 JSON 格式结果。");
        return sb.ToString();
    }

    private static (List<ReviewDimensionScore> scores, string summary) ParseReviewOutput(
        string llmOutput, List<ReviewDimensionConfig> dims)
    {
        var scores = new List<ReviewDimensionScore>();
        var summary = string.Empty;

        try
        {
            // 提取 JSON 块（优先从代码块中提取，其次找最外层 {}）
            var jsonStr = TryExtractJsonBlock(llmOutput);
            if (jsonStr != null)
            {
                var doc = JsonDocument.Parse(jsonStr, new JsonDocumentOptions
                {
                    AllowTrailingCommas = true,
                    CommentHandling = JsonCommentHandling.Skip,
                });

                if (doc.RootElement.TryGetProperty("summary", out var summaryEl))
                    summary = summaryEl.GetString() ?? string.Empty;

                if (doc.RootElement.TryGetProperty("dimensions", out var dimsEl))
                {
                    var dimMap = dims.ToDictionary(d => d.Key);
                    foreach (var dimEl in dimsEl.EnumerateArray())
                    {
                        var key = dimEl.TryGetProperty("key", out var keyEl) ? keyEl.GetString() ?? "" : "";
                        var score = dimEl.TryGetProperty("score", out var scoreEl) ? ParseScore(scoreEl) : 0;
                        var comment = dimEl.TryGetProperty("comment", out var commentEl) ? commentEl.GetString() ?? "" : "";

                        if (dimMap.TryGetValue(key, out var dimConfig))
                        {
                            score = Math.Clamp(score, 0, dimConfig.MaxScore);
                            scores.Add(new ReviewDimensionScore
                            {
                                Key = key,
                                Name = dimConfig.Name,
                                Score = score,
                                MaxScore = dimConfig.MaxScore,
                                Comment = comment,
                            });
                        }
                    }
                }
            }
        }
        catch (Exception)
        {
            // 解析失败时给所有维度 0 分，并保留原始输出作为 summary
            summary = "评审结果解析失败，请查看原始评审内容。";
        }

        // 补全未解析到的维度
        var parsedKeys = scores.Select(s => s.Key).ToHashSet();
        foreach (var dim in dims.Where(d => !parsedKeys.Contains(d.Key)))
        {
            scores.Add(new ReviewDimensionScore
            {
                Key = dim.Key,
                Name = dim.Name,
                Score = 0,
                MaxScore = dim.MaxScore,
                Comment = "未能解析",
            });
        }

        return (scores, summary);
    }

    private static int ParseScore(JsonElement scoreEl) => scoreEl.ValueKind switch
    {
        JsonValueKind.Number => (int)Math.Round(scoreEl.GetDouble()),
        JsonValueKind.String => int.TryParse(scoreEl.GetString(), out var v) ? v :
                                double.TryParse(scoreEl.GetString(), out var d) ? (int)Math.Round(d) : 0,
        _ => 0,
    };

    private static string? TryExtractJsonBlock(string output)
    {
        // 优先提取 ```json ... ``` 或 ``` ... ``` 代码块中的 JSON
        var codeBlockMatch = System.Text.RegularExpressions.Regex.Match(
            output, @"```(?:json)?\s*(\{[\s\S]*?\})\s*```",
            System.Text.RegularExpressions.RegexOptions.Singleline);
        if (codeBlockMatch.Success) return codeBlockMatch.Groups[1].Value;

        // 回退：找最外层 { ... }
        var start = output.IndexOf('{');
        var end = output.LastIndexOf('}');
        return (start >= 0 && end > start) ? output[start..(end + 1)] : null;
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
}

// ──────────────────────────────────────────────
// 请求模型
// ──────────────────────────────────────────────

public record CreateReviewSubmissionRequest(string Title, string AttachmentId);
