using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;
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
    // 申诉富文本图片上限 + 允许的 mime 类型（参考 ReportAgentController 同款配置）
    private const long MaxAppealImageBytes = 5 * 1024 * 1024;
    private static readonly HashSet<string> AllowedAppealImageMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"
    };
    // 申诉窗口（评审完成后多长时间内可申诉）
    private static readonly TimeSpan AppealWindow = TimeSpan.FromHours(3);

    private readonly MongoDbContext _db;
    private readonly ILlmGateway _gateway;
    private readonly ILogger<ReviewAgentController> _logger;
    private readonly Services.ReviewAgent.ReviewWebhookService _webhookService;
    private readonly IAssetStorage _assetStorage;

    public ReviewAgentController(
        MongoDbContext db,
        ILlmGateway gateway,
        ILogger<ReviewAgentController> logger,
        Services.ReviewAgent.ReviewWebhookService webhookService,
        IAssetStorage assetStorage)
    {
        _db = db;
        _gateway = gateway;
        _logger = logger;
        _webhookService = webhookService;
        _assetStorage = assetStorage;
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

    private bool HasAppealReviewPermission()
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(AdminPermissionCatalog.ReviewAgentAppealReview)
               || permissions.Contains(AdminPermissionCatalog.Super);
    }

    /// <summary>判断某条 submission 当前是否允许新发起申诉（已通过/已申诉过/已过期 均不允许）</summary>
    private static bool CanAppeal(ReviewSubmission s)
    {
        return s.Status == ReviewStatuses.Done
            && s.IsPassed == false                     // 已通过不允许申诉
            && s.AppealStatus != AppealStatuses.Pending // 没在审中
            && s.AppealStatus != AppealStatuses.Approved // 已成功未消费的不允许重复申诉
            && s.AppealStatus != AppealStatuses.Rejected // 被驳回的不允许再次申诉（一次性）
            && s.CompletedAt.HasValue
            && DateTime.UtcNow < s.CompletedAt.Value + AppealWindow;
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
    /// 排行榜 — 按自然月区间聚合，先把 submission 按 (SubmitterId, Title) 聚到「方案桶」，
    /// 再按 submitter / document 维度展示。
    /// 「一次性通过率」= 该用户的「一次过方案桶」/「方案桶总数」；
    /// 一次过 = 桶里只 1 条 sub + IsPassed=true + RerunCount=0（不含 ErrorRetryCount，系统故障重跑不归咎用户）。
    /// 「通过率」= 桶级最终通过的数量（桶内任一 sub IsPassed=true 视为通过） / 已落定的方案桶数。
    /// </summary>
    [HttpGet("leaderboard")]
    public async Task<IActionResult> GetLeaderboard(
        [FromQuery] string startMonth,
        [FromQuery] string endMonth,
        [FromQuery] string groupBy = "submitter",
        CancellationToken ct = default)
    {
        if (!HasViewAllPermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看排行榜"));

        if (groupBy != "submitter" && groupBy != "document")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "groupBy 仅支持 submitter / document"));

        DateTime startUtc, endUtcExclusive;
        try
        {
            (startUtc, endUtcExclusive) = ParseMonthRange(startMonth, endMonth);
        }
        catch (ArgumentException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, ex.Message));
        }

        // 仅统计 Done 且 CompletedAt 在区间内的提交
        var filter = Builders<ReviewSubmission>.Filter.And(
            Builders<ReviewSubmission>.Filter.Eq(x => x.Status, ReviewStatuses.Done),
            Builders<ReviewSubmission>.Filter.Gte(x => x.CompletedAt, startUtc),
            Builders<ReviewSubmission>.Filter.Lt(x => x.CompletedAt, endUtcExclusive)
        );

        var docs = await _db.ReviewSubmissions
            .Find(filter)
            .Project(x => new LeaderboardRow
            {
                SubmitterId = x.SubmitterId,
                SubmitterName = x.SubmitterName,
                Title = x.Title,
                IsPassed = x.IsPassed,
                RerunCount = x.RerunCount,
                AppealStatus = x.AppealStatus,
            })
            .ToListAsync(ct);

        var buckets = AggregateProposalBuckets(docs);

        IEnumerable<dynamic> items;
        if (groupBy == "document")
        {
            // 每个方案桶 = 一行
            items = buckets
                .OrderByDescending(b => b.SubmissionCount)
                .ThenByDescending(b => b.IsBucketPassed)
                .Select((b, i) => new
                {
                    rank = i + 1,
                    key = $"{b.SubmitterId}|{b.Title}",
                    name = b.Title,
                    submitterId = b.SubmitterId,
                    submitterName = b.SubmitterName,
                    totalCount = b.SubmissionCount,       // 该方案被提交了几次
                    passedCount = b.IsBucketPassed ? 1 : 0,
                    appealApprovedCount = b.IsBucketAppealApproved ? 1 : 0,
                    passRate = b.IsBucketPassed ? 1d : 0d,
                    firstTimePassedCount = b.IsFirstPass ? 1 : 0,
                    firstTimePassRate = (double?)(b.IsFirstPass ? 1d : 0d),
                });
        }
        else
        {
            // submitter 维度：把方案桶按 SubmitterId 二次聚合
            items = buckets
                .GroupBy(b => b.SubmitterId)
                .Select(g =>
                {
                    var total = g.Count();
                    var passed = g.Count(b => b.IsBucketPassed);
                    var failed = g.Count(b => b.IsBucketFailed);
                    var appealed = g.Count(b => b.IsBucketAppealApproved);
                    var ratedTotal = passed + failed;
                    var firstPassCount = g.Count(b => b.IsFirstPass);
                    return new
                    {
                        key = g.Key,
                        name = g.First().SubmitterName,
                        submitterId = g.Key,
                        submitterName = g.First().SubmitterName,
                        totalCount = total,        // 方案桶数（按标题去重）
                        passedCount = passed,
                        appealApprovedCount = appealed,
                        passRate = ratedTotal > 0 ? (double)passed / ratedTotal : 0d,
                        firstTimePassedCount = firstPassCount,
                        // 一次性通过率 = 一次过方案数 / 总方案数（用户给的口径）
                        firstTimePassRate = total > 0 ? (double?)firstPassCount / total : null,
                    };
                })
                .OrderByDescending(x => x.totalCount)
                .ThenByDescending(x => x.passRate)
                .Select((x, i) => new
                {
                    rank = i + 1,
                    x.key,
                    x.name,
                    x.submitterId,
                    x.submitterName,
                    x.totalCount,
                    x.passedCount,
                    x.appealApprovedCount,
                    x.passRate,
                    x.firstTimePassedCount,
                    x.firstTimePassRate,
                });
        }

        var itemsList = items.ToList();

        // 总览：所有方案桶聚合（不分 submitter）
        var summaryTotal = buckets.Count;
        var summaryPassed = buckets.Count(b => b.IsBucketPassed);
        var summaryFailed = buckets.Count(b => b.IsBucketFailed);
        var summaryAppealed = buckets.Count(b => b.IsBucketAppealApproved);
        var summaryRated = summaryPassed + summaryFailed;
        var summaryFirstPass = buckets.Count(b => b.IsFirstPass);
        var summary = new
        {
            totalCount = summaryTotal,
            totalPassedCount = summaryPassed,
            totalAppealApprovedCount = summaryAppealed,
            totalPassRate = summaryRated > 0 ? (double)summaryPassed / summaryRated : 0d,
            totalFirstTimePassedCount = summaryFirstPass,
            totalFirstTimePassRate = summaryTotal > 0 ? (double?)summaryFirstPass / summaryTotal : null,
        };

        return Ok(ApiResponse<object>.Ok(new
        {
            items = itemsList,
            summary,
            period = new { startMonth, endMonth },
            groupBy,
        }));
    }

    /// <summary>
    /// 把 submission 平表按 (SubmitterId, Title) 聚合到「方案桶」。
    /// 同一用户同标题的多次提交视为同一方案，反映 Z 口径"一次性通过率"语义。
    /// </summary>
    internal static List<ProposalBucket> AggregateProposalBuckets(IEnumerable<LeaderboardRow> docs)
    {
        return docs
            .GroupBy(x => $"{x.SubmitterId}|{x.Title}")
            .Select(g =>
            {
                var rows = g.ToList();
                var first = rows[0];
                var submissionCount = rows.Count;
                var hasAnyPass = rows.Any(r => r.IsPassed == true && r.AppealStatus != AppealStatuses.Approved);
                var hasAnyFail = rows.Any(r => r.IsPassed == false && r.AppealStatus != AppealStatuses.Approved);
                var hasAppealApproved = rows.Any(r => r.AppealStatus == AppealStatuses.Approved);

                return new ProposalBucket
                {
                    SubmitterId = first.SubmitterId,
                    SubmitterName = first.SubmitterName,
                    Title = first.Title,
                    SubmissionCount = submissionCount,
                    IsBucketPassed = hasAnyPass,
                    IsBucketFailed = !hasAnyPass && hasAnyFail,
                    IsBucketAppealApproved = !hasAnyPass && hasAppealApproved,
                    // 一次过：只 1 条 sub + IsPassed=true + RerunCount=0 + 非申诉成功
                    IsFirstPass = submissionCount == 1
                                  && first.IsPassed == true
                                  && first.RerunCount == 0
                                  && first.AppealStatus != AppealStatuses.Approved,
                };
            })
            .ToList();
    }

    /// <summary>排行榜方案桶：把同一用户同标题的多次提交聚合为一份方案的统计结果。</summary>
    internal class ProposalBucket
    {
        public string SubmitterId { get; set; } = string.Empty;
        public string SubmitterName { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public int SubmissionCount { get; set; }
        public bool IsBucketPassed { get; set; }
        public bool IsBucketFailed { get; set; }
        public bool IsBucketAppealApproved { get; set; }
        public bool IsFirstPass { get; set; }
    }

    /// <summary>解析 YYYY-MM 区间为 UTC 起止（end 为下个月 1 号 0 点，半开区间）</summary>
    private static (DateTime startUtc, DateTime endUtcExclusive) ParseMonthRange(string startMonth, string endMonth)
    {
        if (string.IsNullOrWhiteSpace(startMonth) || string.IsNullOrWhiteSpace(endMonth))
            throw new ArgumentException("startMonth 与 endMonth 必填，格式 YYYY-MM");

        var sParts = startMonth.Split('-');
        var eParts = endMonth.Split('-');
        if (sParts.Length != 2 || eParts.Length != 2
            || !int.TryParse(sParts[0], out var sy) || !int.TryParse(sParts[1], out var sm)
            || !int.TryParse(eParts[0], out var ey) || !int.TryParse(eParts[1], out var em)
            || sm < 1 || sm > 12 || em < 1 || em > 12)
            throw new ArgumentException("月份格式应为 YYYY-MM（如 2026-03）");

        var startUtc = new DateTime(sy, sm, 1, 0, 0, 0, DateTimeKind.Utc);
        var endUtcExclusive = new DateTime(ey, em, 1, 0, 0, 0, DateTimeKind.Utc).AddMonths(1);
        if (endUtcExclusive <= startUtc)
            throw new ArgumentException("结束月份必须 ≥ 开始月份");
        return (startUtc, endUtcExclusive);
    }

    /// <summary>排行榜聚合中间投影类型（避免匿名类型在 LINQ Project 表达式树中的限制）</summary>
    internal class LeaderboardRow
    {
        public string SubmitterId { get; set; } = string.Empty;
        public string SubmitterName { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public bool? IsPassed { get; set; }
        public int RerunCount { get; set; }
        public string? AppealStatus { get; set; }
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
    /// 系统故障重跑 — 仅限 Error 状态使用（LLM 网关失败等）。保留旧 ReviewResult 作为历史，仅累加 ErrorRetryCount。
    /// 不影响 RerunCount（系统故障不归咎用户，不计入一次性通过率统计）。
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

        // 仅允许 Error 状态触发"重新评审"（系统故障恢复）；未通过应走 reupload-on-failure
        if (submission.Status != ReviewStatuses.Error)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                "仅在评审过程出错时才能使用「重新评审」；如评审未通过，请使用「重新上传方案」（一次救机会）"));

        // 不删旧 ReviewResult（保留为历史，详情页会展示评审历史）
        await _db.ReviewSubmissions.UpdateOneAsync(
            x => x.Id == id,
            Builders<ReviewSubmission>.Update
                .Set(x => x.Status, ReviewStatuses.Queued)
                .Unset(x => x.ResultId)
                .Unset(x => x.IsPassed)
                .Unset(x => x.CompletedAt)
                .Unset(x => x.StartedAt)
                .Unset(x => x.ErrorMessage)
                .Inc(x => x.ErrorRetryCount, 1),
            cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { message = "已重置，请刷新页面重新评审" }));
    }

    /// <summary>
    /// 未通过救机会 — 仅在 Done + IsPassed=false + RerunCount=0 时可用。替换附件、累加 RerunCount=1、状态置 Queued。
    /// 保留旧 ReviewResult 作为历史。每个 submission 仅允许 1 次（RerunCount 上限 1）。
    /// </summary>
    [HttpPost("submissions/{id}/reupload-on-failure")]
    public async Task<IActionResult> ReuploadOnFailure(string id, [FromBody] ReuploadRequest req, CancellationToken ct)
    {
        var userId = GetUserId();
        var submission = await _db.ReviewSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提交记录不存在"));

        if (submission.SubmitterId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅本人可重新上传方案"));

        // 状态门槛：评审完成 + 未通过 + 没用过救机会
        if (submission.Status != ReviewStatuses.Done || submission.IsPassed != false)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅在评审完成且未通过时可使用救机会"));
        if (submission.RerunCount >= 1)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "本方案的救机会已用完（每个方案仅 1 次）"));

        if (string.IsNullOrWhiteSpace(req?.AttachmentId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "attachmentId 不能为空"));

        var attachment = await _db.Attachments.Find(x => x.AttachmentId == req.AttachmentId).FirstOrDefaultAsync(ct);
        if (attachment == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "附件不存在"));
        if (string.IsNullOrWhiteSpace(attachment.ExtractedText))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无法从文件中提取文本内容，请确认上传的是有效的 Markdown 文件"));

        // 不删旧 ReviewResult，保留为历史
        await _db.ReviewSubmissions.UpdateOneAsync(
            x => x.Id == id,
            Builders<ReviewSubmission>.Update
                .Set(x => x.AttachmentId, req.AttachmentId)
                .Set(x => x.FileName, attachment.FileName)
                .Set(x => x.ExtractedContent, attachment.ExtractedText)
                .Set(x => x.Status, ReviewStatuses.Queued)
                .Unset(x => x.ResultId)
                .Unset(x => x.IsPassed)
                .Unset(x => x.CompletedAt)
                .Unset(x => x.StartedAt)
                .Unset(x => x.ErrorMessage)
                .Inc(x => x.RerunCount, 1),
            cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { message = "已替换附件，请刷新页面重新评审" }));
    }

    /// <summary>
    /// 获取某 submission 的所有评审历史（含被 reupload-on-failure / Error 重跑覆盖前的历史结果），按时间倒序。
    /// </summary>
    [HttpGet("submissions/{id}/results")]
    public async Task<IActionResult> GetSubmissionResults(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var submission = await _db.ReviewSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提交记录不存在"));

        if (submission.SubmitterId != userId && !HasViewAllPermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看该提交"));

        var results = await _db.ReviewResults
            .Find(x => x.SubmissionId == id)
            .SortByDescending(x => x.ScoredAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { results }));
    }

    // ──────────────────────────────────────────────
    // 申诉
    // ──────────────────────────────────────────────

    public class CreateAppealRequest
    {
        public string ReasonHtml { get; set; } = string.Empty;
        public List<string>? ImageAttachmentIds { get; set; }
    }

    public class ResolveAppealRequest
    {
        public string Comment { get; set; } = string.Empty;
    }

    /// <summary>
    /// 提交申诉（仅提交人本人；评审完成后 3 小时内；未通过且无在审申诉）
    /// </summary>
    [HttpPost("submissions/{id}/appeal")]
    public async Task<IActionResult> CreateAppeal(string id, [FromBody] CreateAppealRequest req, CancellationToken ct)
    {
        var userId = GetUserId();
        var submission = await _db.ReviewSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提交记录不存在"));

        if (submission.SubmitterId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅本人可对自己的评审发起申诉"));

        if (!CanAppeal(submission))
        {
            string reason;
            if (submission.Status != ReviewStatuses.Done)
                reason = "评审尚未完成，无法申诉";
            else if (submission.IsPassed == true)
                reason = "已通过的评审无法申诉";
            else if (submission.AppealStatus == AppealStatuses.Pending)
                reason = "已有申诉在审理中，请勿重复提交";
            else if (submission.AppealStatus == AppealStatuses.Approved)
                reason = "申诉已通过，请上传新方案重新评审";
            else if (submission.AppealStatus == AppealStatuses.Rejected)
                reason = "申诉已被驳回，不可再次申诉";
            else if (submission.CompletedAt.HasValue && DateTime.UtcNow >= submission.CompletedAt.Value + AppealWindow)
                reason = $"已超过 {AppealWindow.TotalHours} 小时申诉窗口";
            else
                reason = "当前状态不允许申诉";
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, reason));
        }

        var reasonHtml = (req.ReasonHtml ?? string.Empty).Trim();
        // 简单纯文字长度校验：去 HTML 标签后须 ≥10 字（图片不算字数）
        var plainLen = System.Text.RegularExpressions.Regex.Replace(reasonHtml, @"<[^>]+>", "").Trim().Length;
        if (plainLen < 10)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "申诉理由过短，请至少填写 10 个字"));

        var appeal = new ReviewAppeal
        {
            SubmissionId = id,
            SubmitterId = userId,
            SubmitterName = submission.SubmitterName,
            ReasonHtml = reasonHtml,
            ImageAttachmentIds = req.ImageAttachmentIds ?? new List<string>(),
            Status = AppealStatuses.Pending,
        };
        await _db.ReviewAppeals.InsertOneAsync(appeal, cancellationToken: CancellationToken.None);

        await _db.ReviewSubmissions.UpdateOneAsync(
            x => x.Id == id,
            Builders<ReviewSubmission>.Update
                .Set(x => x.AppealStatus, AppealStatuses.Pending)
                .Set(x => x.LatestAppealId, appeal.Id),
            cancellationToken: CancellationToken.None);

        // 申诉提交时通过企微/钉钉/飞书 webhook 通知受理员群（AdminNotification 暂无按权限广播能力，
        // 管理员可订阅 AppealSubmitted 事件配置 webhook 接收即时提醒）
        await _webhookService.NotifyAppealEventAsync(ReviewEventType.AppealSubmitted, submission, appeal);

        return Ok(ApiResponse<object>.Ok(new { appeal }));
    }

    /// <summary>
    /// 列出某条 submission 的所有申诉记录（最新在前）
    /// </summary>
    [HttpGet("submissions/{id}/appeals")]
    public async Task<IActionResult> ListAppeals(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var submission = await _db.ReviewSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提交记录不存在"));

        // 本人 / 持有 ViewAll / 持有 AppealReview 均可查看
        if (submission.SubmitterId != userId
            && !HasViewAllPermission()
            && !HasAppealReviewPermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权限查看该申诉记录"));

        var appeals = await _db.ReviewAppeals
            .Find(x => x.SubmissionId == id)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items = appeals }));
    }

    /// <summary>
    /// 受理 — 通过申诉（需 ReviewAgentAppealReview 权限）
    /// </summary>
    [HttpPost("appeals/{appealId}/approve")]
    public async Task<IActionResult> ApproveAppeal(string appealId, [FromBody] ResolveAppealRequest req, CancellationToken ct)
    {
        return await ResolveAppealAsync(appealId, req, AppealStatuses.Approved, ct);
    }

    /// <summary>
    /// 受理 — 驳回申诉（需 ReviewAgentAppealReview 权限）
    /// </summary>
    [HttpPost("appeals/{appealId}/reject")]
    public async Task<IActionResult> RejectAppeal(string appealId, [FromBody] ResolveAppealRequest req, CancellationToken ct)
    {
        return await ResolveAppealAsync(appealId, req, AppealStatuses.Rejected, ct);
    }

    private async Task<IActionResult> ResolveAppealAsync(string appealId, ResolveAppealRequest req, string targetStatus, CancellationToken ct)
    {
        if (!HasAppealReviewPermission())
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无申诉受理权限"));

        var comment = (req?.Comment ?? string.Empty).Trim();
        if (comment.Length < 5)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "受理意见过短，请至少填写 5 个字"));

        var appeal = await _db.ReviewAppeals.Find(x => x.Id == appealId).FirstOrDefaultAsync(ct);
        if (appeal == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "申诉记录不存在"));

        if (appeal.Status != AppealStatuses.Pending)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, $"该申诉已是「{appeal.Status}」状态，无法再次受理"));

        var resolverId = GetUserId();
        var resolverName = GetDisplayName() ?? resolverId;
        var now = DateTime.UtcNow;

        // 乐观锁：以 Status==Pending 作为更新条件，防止并发受理
        var updateResult = await _db.ReviewAppeals.UpdateOneAsync(
            x => x.Id == appealId && x.Status == AppealStatuses.Pending,
            Builders<ReviewAppeal>.Update
                .Set(x => x.Status, targetStatus)
                .Set(x => x.ResolverId, resolverId)
                .Set(x => x.ResolverName, resolverName)
                .Set(x => x.ResolverComment, comment)
                .Set(x => x.ResolvedAt, now),
            cancellationToken: CancellationToken.None);

        if (updateResult.ModifiedCount == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "该申诉已被其他人受理"));

        // 同步更新 submission.AppealStatus
        await _db.ReviewSubmissions.UpdateOneAsync(
            x => x.Id == appeal.SubmissionId,
            Builders<ReviewSubmission>.Update
                .Set(x => x.AppealStatus, targetStatus)
                .Set(x => x.AppealResolvedAt, now),
            cancellationToken: CancellationToken.None);

        // 重新读出最新 appeal + submission 推 webhook
        appeal.Status = targetStatus;
        appeal.ResolverId = resolverId;
        appeal.ResolverName = resolverName;
        appeal.ResolverComment = comment;
        appeal.ResolvedAt = now;

        var submission = await _db.ReviewSubmissions.Find(x => x.Id == appeal.SubmissionId).FirstOrDefaultAsync(CancellationToken.None);
        if (submission != null)
        {
            // 给提交人发 AdminNotification
            var notification = new AdminNotification
            {
                TargetUserId = submission.SubmitterId,
                Title = targetStatus == AppealStatuses.Approved
                    ? $"申诉通过：{submission.Title}"
                    : $"申诉驳回：{submission.Title}",
                Message = targetStatus == AppealStatuses.Approved
                    ? $"您的申诉已通过，受理意见：{comment}。可重新上传方案进行评审。"
                    : $"您的申诉已被驳回，受理意见：{comment}。",
                Level = targetStatus == AppealStatuses.Approved ? "success" : "warning",
                Source = AppKey,
                ActionLabel = "查看详情",
                ActionUrl = $"/review-agent/submissions/{submission.Id}",
                ActionKind = "navigate",
            };
            await _db.AdminNotifications.InsertOneAsync(notification, cancellationToken: CancellationToken.None);

            await _webhookService.NotifyAppealEventAsync(
                targetStatus == AppealStatuses.Approved ? ReviewEventType.AppealApproved : ReviewEventType.AppealRejected,
                submission, appeal);
        }

        return Ok(ApiResponse<object>.Ok(new { appeal }));
    }

    /// <summary>
    /// 申诉成功后重新上传 md：替换原 submission 的附件并重置为 Queued 触发新评审。
    /// RerunCount 清零 —— 等同于"新方案的首次评审"，便于一次性通过率正确计算。
    /// </summary>
    [HttpPost("submissions/{id}/reupload")]
    public async Task<IActionResult> ReuploadSubmission(string id, [FromBody] ReuploadRequest req, CancellationToken ct)
    {
        var userId = GetUserId();
        var submission = await _db.ReviewSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (submission == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "提交记录不存在"));

        if (submission.SubmitterId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "仅本人可重新上传方案"));

        if (submission.AppealStatus != AppealStatuses.Approved)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅在「申诉成功」状态下可重新上传方案"));

        if (string.IsNullOrWhiteSpace(req?.AttachmentId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "attachmentId 不能为空"));

        var attachment = await _db.Attachments.Find(x => x.AttachmentId == req.AttachmentId).FirstOrDefaultAsync(ct);
        if (attachment == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.DOCUMENT_NOT_FOUND, "附件不存在"));
        if (string.IsNullOrWhiteSpace(attachment.ExtractedText))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "无法从文件中提取文本内容，请确认上传的是有效的 Markdown 文件"));

        // 不删旧 ReviewResult，保留为评审历史
        await _db.ReviewSubmissions.UpdateOneAsync(
            x => x.Id == id,
            Builders<ReviewSubmission>.Update
                .Set(x => x.AttachmentId, req.AttachmentId)
                .Set(x => x.FileName, attachment.FileName)
                .Set(x => x.ExtractedContent, attachment.ExtractedText)
                .Set(x => x.Status, ReviewStatuses.Queued)
                .Set(x => x.RerunCount, 0)  // 申诉成功后重新上传 = 该方案的"新一轮首次评审"，RerunCount 清零
                .Unset(x => x.ResultId)
                .Unset(x => x.IsPassed)
                .Unset(x => x.CompletedAt)
                .Unset(x => x.StartedAt)
                .Unset(x => x.ErrorMessage)
                .Unset(x => x.AppealStatus)
                .Unset(x => x.LatestAppealId)
                .Unset(x => x.AppealResolvedAt),
            cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { message = "已替换附件，请刷新页面重新评审" }));
    }

    public class ReuploadRequest
    {
        public string AttachmentId { get; set; } = string.Empty;
    }

    /// <summary>
    /// 申诉富文本图片上传（粘贴/拖拽即用）
    /// </summary>
    [HttpPost("appeals/upload-image")]
    [RequestSizeLimit(MaxAppealImageBytes)]
    public async Task<IActionResult> UploadAppealImage([FromForm] IFormFile file, CancellationToken ct)
    {
        var userId = GetUserId();

        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FILE", "请选择图片文件"));
        if (file.Length > MaxAppealImageBytes)
            return BadRequest(ApiResponse<object>.Fail("FILE_TOO_LARGE", "图片大小不能超过 5MB"));

        var mimeType = file.ContentType?.Trim().ToLowerInvariant() ?? "application/octet-stream";
        if (!AllowedAppealImageMimeTypes.Contains(mimeType))
            return BadRequest(ApiResponse<object>.Fail("UNSUPPORTED_TYPE", $"不支持的图片类型：{mimeType}"));

        byte[] bytes;
        await using (var ms = new MemoryStream())
        {
            await file.CopyToAsync(ms, ct);
            bytes = ms.ToArray();
        }

        var stored = await _assetStorage.SaveAsync(
            bytes,
            mimeType,
            ct,
            domain: AppDomainPaths.DomainPrdAgent,
            type: AppDomainPaths.TypeImg);

        var attachment = new Attachment
        {
            UploaderId = userId,
            FileName = file.FileName,
            MimeType = mimeType,
            Size = file.Length,
            Url = stored.Url,
            Type = AttachmentType.Image,
            UploadedAt = DateTime.UtcNow,
        };
        await _db.Attachments.InsertOneAsync(attachment, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            attachmentId = attachment.AttachmentId,
            url = attachment.Url,
            fileName = attachment.FileName,
            mimeType = attachment.MimeType,
            size = attachment.Size,
        }));
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
        var userPromptBase = BuildReviewUserPrompt(submission.Title, content, dims);

        // ── 确定性参数：temperature=0 + 由 submissionId 派生稳定 seed ──
        // 同一份方案重复评审应得到一致结果；解析失败重试时 seed+1 避免完全复现失败的输出。
        var baseSeed = DeriveSeed(submissionId);
        const int MaxAttempts = 2; // 总共最多 2 次 LLM 调用（首次 + 1 次重试）

        string llmOutput = string.Empty;
        List<ReviewDimensionScore> dimensionScores = new();
        string summary = string.Empty;
        string? parseError = null;

        for (int attempt = 1; attempt <= MaxAttempts; attempt++)
        {
            if (attempt == 1)
            {
                await WriteSseEventAsync("phase", new { phase = "analyzing", message = "AI 正在分析方案内容..." });
            }
            else
            {
                await WriteSseEventAsync("phase", new
                {
                    phase = "retrying",
                    message = $"AI 上一轮输出格式异常，正在自动重试（第 {attempt}/{MaxAttempts} 次）..."
                });
            }

            // 重试时在 prompt 末尾追加严格输出要求，提高 JSON 命中率
            var userPrompt = attempt == 1
                ? userPromptBase
                : userPromptBase + "\n\n## 严格输出要求（重试）\n上一轮输出未通过 JSON 解析。请严格按上方指定的 JSON schema 输出，不要包裹任何额外说明文字。";

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
                    ["temperature"] = 0,
                    ["seed"] = baseSeed + (attempt - 1),
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
                    _logger.LogError("ReviewAgent 网关错误 [{SubmissionId}] attempt={Attempt}: {Error}",
                        submissionId, attempt, gatewayError);
                    break;
                }
            }

            // 网关错误：直接标记失败（网关错误属上游/配额问题，不在解析重试范围内）
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

            llmOutput = fullContent.ToString();
            (dimensionScores, summary, parseError) = ParseReviewOutput(llmOutput, dims);

            // 解析成功（parseError == null 表示 JSON 或正则至少一条命中），跳出循环走落库
            if (parseError == null) break;

            // 达到重试上限仍失败：标记 Error 让用户手动重试，不写 ReviewResult、不补 0 分
            if (attempt == MaxAttempts)
            {
                _logger.LogWarning(
                    "ReviewAgent 解析失败已达重试上限 [{SubmissionId}] attempts={Attempts} parseError={Error}",
                    submissionId, attempt, parseError);
                const string userFacingMsg = "AI 输出格式异常，已自动重试 1 次仍失败，请点击「重新评审」";
                await _db.ReviewSubmissions.UpdateOneAsync(
                    x => x.Id == submissionId,
                    Builders<ReviewSubmission>.Update
                        .Set(x => x.Status, ReviewStatuses.Error)
                        .Set(x => x.ErrorMessage, userFacingMsg),
                    cancellationToken: CancellationToken.None);
                try { await WriteSseEventAsync("error", new { message = userFacingMsg }); }
                catch { /* 客户端已断开 */ }
                return;
            }
            // 否则进入下一轮重试
        }

        // ── 三层兜底（Guardrails）：抵御 LLM 把非清单维度全填满凑高分 + summary 自相矛盾的钻空子路径 ──
        var adjustmentLog = ApplyScoringGuardrails(dimensionScores, dims, content, summary);

        var totalScore = dimensionScores.Sum(d => d.Score);
        var isPassed = totalScore >= 80;

        // 在 summary 末尾追加权威结论，避免 LLM 文字与系统派生分数错位时误导用户
        // （企微/钉钉 webhook 通知也读这个 summary，保证三处文案对齐）
        var conclusionLine = $"[系统结论] 最终得分 {totalScore}/100，{(isPassed ? "已通过" : "未通过")}。";
        if (adjustmentLog.Count > 0)
        {
            conclusionLine += $" 系统兜底已触发 {adjustmentLog.Count} 项调整（详见报告）。";
        }
        summary = string.IsNullOrWhiteSpace(summary)
            ? conclusionLine
            : summary.TrimEnd() + "\n\n" + conclusionLine;

        // 推送分项结果（已应用 evidence gate）
        foreach (var dimScore in dimensionScores)
        {
            try
            {
                await WriteSseEventAsync("dimension_score", dimScore);
            }
            catch (ObjectDisposedException) { break; }
        }

        // 推送兜底调整日志（前端展示「系统调整记录」区）
        if (adjustmentLog.Count > 0)
        {
            try { await WriteSseEventAsync("adjustment_log", new { entries = adjustmentLog }); }
            catch (ObjectDisposedException) { /* 客户端已断开 */ }
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
            AdjustmentLog = adjustmentLog,
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
            await WriteSseEventAsync("result", new { totalScore, isPassed, summary, adjustmentLog });
            await WriteSseEventAsync("done", new { });
        }
        catch (ObjectDisposedException) { /* 客户端已断开，忽略 */ }
    }

    // ──────────────────────────────────────────────
    // 私有工具方法
    // ──────────────────────────────────────────────

    /// <summary>
    /// 由 submissionId 派生稳定 seed：同一 submission 多次评审使用相同 seed，
    /// 跨进程 / 跨平台一致（不依赖 string.GetHashCode 的运行时随机化）。
    /// </summary>
    private static int DeriveSeed(string submissionId)
    {
        using var sha = System.Security.Cryptography.SHA256.Create();
        var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(submissionId));
        var raw = BitConverter.ToInt32(hash, 0);
        // & 0x7FFFFFFF 保证非负，避免 Math.Abs(int.MinValue) 溢出
        return raw & 0x7FFFFFFF;
    }

    // ──────────────────────────────────────────────
    // 三层兜底（Guardrails）：抵御 LLM 钻空子的硬规则
    // ──────────────────────────────────────────────

    /// <summary>
    /// 应用系统级三层兜底，按顺序：
    /// L1 evidence gate：非清单维度若 LLM 给到 MaxScore × 0.9 以上，要求 Comment 必须 ≥ 15 字且含至少 1 个强标记（≥2 位数字/百分比/章节引用/书名号/直角引号/方括号/URL），否则该维度降至 floor(MaxScore × 0.89)。
    /// L2 数据密度封顶：方案原文「数字/百分比/链接/章节引用」总出现 &lt; 5 处时，整体高分维度（≥ 0.9 得分率）按 0.89 封顶。
    /// L3 summary 一致性闸：summary 出现明确降级关键词（"75-89"/"未达 90"/"合格区间"/"未达标杆"/"有改进空间"），但总分 ≥ 90 时，整体高分维度按 0.89 封顶。L1/L2 已把总分压到 90% 以下时本闸自动失效（设计正确：不重复打压）。
    /// 注意：清单类维度（Items != null）由系统按 truth table 强制重算，不在本兜底覆盖范围。
    /// </summary>
    /// <returns>触发的调整日志条目（≥ 0 条）</returns>
    internal static List<string> ApplyScoringGuardrails(
        List<ReviewDimensionScore> dimensionScores,
        List<ReviewDimensionConfig> dims,
        string proposalContent,
        string summary)
    {
        var log = new List<string>();
        // 防御 DB 自定义配置出现重复 Key（UpdateDimensions 未做唯一性校验）—— 取第一条避免抛 ArgumentException
        var dimConfigMap = dims.GroupBy(d => d.Key).ToDictionary(g => g.Key, g => g.First());

        // L1：逐维度 evidence gate
        foreach (var score in dimensionScores)
        {
            if (!dimConfigMap.TryGetValue(score.Key, out var cfg)) continue;
            // 清单维度跳过：由 truth table 强制重算，不需要 evidence gate
            if (cfg.Items != null && cfg.Items.Count > 0) continue;
            // 仅对「得分率 ≥ 90%」的维度强制要求证据
            var threshold90 = (int)Math.Ceiling(score.MaxScore * 0.9);
            if (score.Score < threshold90) continue;

            if (!HasSufficientEvidence(score.Comment))
            {
                var capped = (int)Math.Floor(score.MaxScore * 0.89);
                log.Add(
                    $"[L1 证据闸] 维度「{score.Name}」原 {score.Score}/{score.MaxScore} → 调整为 {capped}/{score.MaxScore}：" +
                    $"得分率 ≥90% 但 LLM 评语未提供具体证据（数字/百分比/引用/原文章节），按 89% 封顶。");
                score.OriginalScore ??= score.Score;
                score.Score = capped;
                score.Comment = (string.IsNullOrWhiteSpace(score.Comment) ? "" : score.Comment.TrimEnd() + " ") +
                                "[系统提示] 因高分缺乏具体证据，已按 89% 封顶。";
            }
        }

        // L2：数据密度封顶（基于方案原文统计）
        var dataDensity = CountDataPoints(proposalContent);
        if (dataDensity < 5)
        {
            CapHighScoringDimensions(dimensionScores, dimConfigMap, log,
                $"[L2 数据密度] 方案原文具体数据/链接/章节引用仅 {dataDensity} 处（要求 ≥ 5），所有得分率 ≥90% 的非清单维度按 89% 封顶。");
        }

        // L3：summary 与总分一致性闸
        // 注：若 L1/L2 已把高分维度压低、total/max 跌破 0.9，则 L3 门槛自动失效，
        // 这是设计上正确的行为（summary 的降级措辞此时与总分一致，没有矛盾）。
        var totalScoreNow = dimensionScores.Sum(d => d.Score);
        var totalMax = dimensionScores.Sum(d => d.MaxScore);
        if (totalMax > 0 && (double)totalScoreNow / totalMax >= 0.9 && SummaryContainsDowngradeKeyword(summary))
        {
            CapHighScoringDimensions(dimensionScores, dimConfigMap, log,
                "[L3 一致性闸] summary 出现明确降级表述（如「未达 90+」「合格区间」「有改进空间」）但总分 ≥90%，所有得分率 ≥90% 的非清单维度按 89% 封顶。");
        }

        return log;
    }

    /// <summary>
    /// 「具体证据」线索的正则：≥2 位连续数字（排除单数字凑数）、百分比、章节引用（允许中间空格）、
    /// 书名号 / 直角引号 / 方括号 / URL。纯定性形容词（"完整""清晰""凝练"）不视为证据。
    /// </summary>
    private static readonly System.Text.RegularExpressions.Regex EvidenceMarkerRegex = new(
        @"\d{2,}|\d+[%％]|第\s?[一-龥\d]+\s?[章节段条]|《[^》]+》|「[^」]+」|\[[^\]]+\]|http[s]?://",
        System.Text.RegularExpressions.RegexOptions.Compiled);

    /// <summary>
    /// 判断 LLM 评语是否含「具体证据」：长度 ≥ 15 字 且 含至少 1 个强标记
    /// （≥2 位数字 / 百分比 / 章节引用 / 书名号 / 直角引号 / 方括号 / URL）。
    /// 长度门槛防纯空话；强标记正则（不含单 `\d`）防 "整体不错…综合判断 1" 这类单数字钻空子。
    /// </summary>
    internal static bool HasSufficientEvidence(string? comment)
    {
        if (string.IsNullOrWhiteSpace(comment)) return false;
        var trimmed = comment.Trim();
        if (trimmed.Length < 15) return false;
        return EvidenceMarkerRegex.IsMatch(trimmed);
    }

    /// <summary>
    /// 数据密度统计：扫方案原文「数字串(≥2 位非百分比) / 百分比 / URL / 章节引用 / 书名号引用」总出现次数。
    /// 阈值 5 是保守估计：1000 字以上的产品方案普遍能轻松达标，达不到说明确实空话占多数。
    /// </summary>
    internal static int CountDataPoints(string content)
    {
        if (string.IsNullOrWhiteSpace(content)) return 0;
        var count = 0;
        // 数字串（≥ 2 位连续数字，且不跟百分号，避免与下一条 \d+% 重复计数）
        count += System.Text.RegularExpressions.Regex.Matches(content, @"\d{2,}(?![%％])").Count;
        // 百分比
        count += System.Text.RegularExpressions.Regex.Matches(content, @"\d+[%％]").Count;
        // URL
        count += System.Text.RegularExpressions.Regex.Matches(content, @"http[s]?://[^\s一-龥]+").Count;
        // 章节引用（允许"第 3 章"这种带空格写法）
        count += System.Text.RegularExpressions.Regex.Matches(content, @"第\s?[一-龥\d]+\s?[章节段条]").Count;
        // 书名号引用
        count += System.Text.RegularExpressions.Regex.Matches(content, @"《[^》]{1,40}》").Count;
        return count;
    }

    /// <summary>
    /// 检测 summary 是否含明确的「降级」关键词。命中即视为 LLM 自己承认"未达 90+"。
    /// 关键词清单只保留**单义负面**表述；像"标杆级水平"这种褒贬双向的词不放入（会误伤"达到行业标杆级水平"褒义高分）。
    /// </summary>
    internal static bool SummaryContainsDowngradeKeyword(string? summary)
    {
        if (string.IsNullOrWhiteSpace(summary)) return false;
        string[] keywords = { "75-89", "75 - 89", "75 至 89", "未达 90", "未达到 90", "未达90", "未达到90",
                              "合格区间", "未达标杆", "未达到标杆", "未到标杆", "未达行业", "有改进空间" };
        return keywords.Any(k => summary.Contains(k, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// 把所有非清单维度中「得分率 ≥ 90%」的项一律压到 floor(MaxScore × 0.89)。
    /// 触发时先写 reason 主条目，再逐条记录被压的维度；未触发任何维度不写 log。
    /// </summary>
    private static void CapHighScoringDimensions(
        List<ReviewDimensionScore> dimensionScores,
        Dictionary<string, ReviewDimensionConfig> dimConfigMap,
        List<string> log,
        string reason)
    {
        var subEntries = new List<string>();
        foreach (var score in dimensionScores)
        {
            if (!dimConfigMap.TryGetValue(score.Key, out var cfg)) continue;
            if (cfg.Items != null && cfg.Items.Count > 0) continue; // 清单维度跳过
            var threshold90 = (int)Math.Ceiling(score.MaxScore * 0.9);
            if (score.Score < threshold90) continue;

            var capped = (int)Math.Floor(score.MaxScore * 0.89);
            subEntries.Add($"  └ 维度「{score.Name}」{score.Score}/{score.MaxScore} → {capped}/{score.MaxScore}");
            score.OriginalScore ??= score.Score;
            score.Score = capped;
        }
        if (subEntries.Count > 0)
        {
            log.Add(reason);
            log.AddRange(subEntries);
        }
    }

    /// <summary>
    /// 基于系统派生的 Passed 真值，为清单类维度生成权威 comment 文案，
    /// 覆盖 LLM 自填的可能与实际分数矛盾的评语。
    /// </summary>
    private static string BuildChecklistComment(int score, int maxScore, List<DimensionCheckItemResult> items)
    {
        var total = items.Count;
        var passed = items.Count(i => i.Passed);
        var failed = total - passed;
        // 「声明不涉及」= involvedChecked=no 且系统判通过
        var notInvolved = items.Count(i => i.InvolvedChecked == "no" && i.Passed);
        // 「涉及且已覆盖」= involvedChecked=yes、coverageChecked=yes、solutionFound=true
        var covered = items.Count(i =>
            i.InvolvedChecked == "yes" && i.CoverageChecked == "yes" && i.SolutionFound == true);

        if (total == 0)
            return $"得分 {score}/{maxScore}（无检查项）。";

        var sb = new StringBuilder();
        sb.Append($"系统派生：共 {total} 项，{passed} 项通过");
        if (notInvolved > 0 || covered > 0)
        {
            var parts = new List<string>();
            if (notInvolved > 0) parts.Add($"{notInvolved} 项声明不涉及视为合规");
            if (covered > 0) parts.Add($"{covered} 项涉及且方案已覆盖");
            sb.Append("（其中 " + string.Join("、", parts) + "）");
        }
        if (failed > 0) sb.Append($"，{failed} 项不通过");
        sb.Append($"。得分 {score}/{maxScore}。");

        if (failed > 0)
        {
            var firstFail = items.FirstOrDefault(i => !i.Passed);
            if (firstFail != null && !string.IsNullOrWhiteSpace(firstFail.Evidence))
            {
                var ev = firstFail.Evidence!.Length > 60 ? firstFail.Evidence[..60] + "…" : firstFail.Evidence;
                sb.Append($" 首个不通过项「{firstFail.Text}」：{ev}");
            }
        }
        return sb.ToString();
    }

    private static string BuildReviewSystemPrompt(List<ReviewDimensionConfig> dims)
    {
        var sb = new StringBuilder();
        sb.AppendLine("你是一位严格的资深产品评审专家，负责对产品方案进行专业、客观、严格的评审打分。");
        sb.AppendLine();
        sb.AppendLine("## 评审原则（必须遵守）");
        sb.AppendLine();
        sb.AppendLine("1. **严格评分，宁可严格不宽松**：通过线 80 分。多数合格方案应落 75-89 区间，不要轻易给到 90+。");
        sb.AppendLine("2. **必须有证据支撑**：每项评分必须能在方案中找到具体对应内容。方案内容空洞、表述模糊、缺乏具体数据/标准的，必须严格扣分。");
        sb.AppendLine("3. **拒绝虚高分**：禁止给出\"意思意思\"的高分。如果某维度内容缺失或质量差，应给出 0-60% 的得分率，不得因为方案提交了就打高分。");
        sb.AppendLine("4. **评语要具体**：comment 必须指出方案中**具体缺失或不足的地方**（引用原文或点明缺少的章节/内容），而非泛泛而谈。");
        sb.AppendLine("5. **分级参考（按总分得分率）**：");
        sb.AppendLine("   - 95-100%（罕见，仅限行业标杆级）：内容完整 + 高度凝练 + 每段有具体数据/链接/对比 + 提出非显而易见的洞察");
        sb.AppendLine("   - 90-94%（上层优秀，约 top 15%）：内容完整、表述凝练无重复、关键论点有数据支撑、可立刻指导落地");
        sb.AppendLine("   - 75-89%（多数合格方案应落此区间）：核心内容齐全、表述清楚、有可优化空间（如细节缺失或论证略浅，但无明显堆砌）");
        sb.AppendLine("   - 60-74%：核心缺失，或表述冗余/重复展开，或仅泛泛而谈无具体抓手（不通过）");
        sb.AppendLine("   - <60%：内容明显不足、空话连篇、为写而写（需重写）");
        sb.AppendLine();
        sb.AppendLine("6. **必须惩罚冗余表达（反堆砌硬规则）**：方案如有以下行为，必须在「表达质量与凝练度」维度扣分，并在 comment 中具体点名：");
        sb.AppendLine("   - 同一观点在不同章节反复展开（重复论证）");
        sb.AppendLine("   - 用「我们认为…」「建议加强…」「需要重视…」「至关重要」「全面提升」等空话占字数");
        sb.AppendLine("   - 一句话能说清的事拆成三段写");
        sb.AppendLine("   - 列表项之间高度重叠（A 是 B 的换种说法）");
        sb.AppendLine("   - 引用大段背景资料但与方案无关");
        sb.AppendLine("7. **凝练优先**：相同信息量下，1000 字优于 3000 字。如方案明显存在可删减 30% 不损失信息的冗余，「表达质量与凝练度」按 50% 得分率封顶；如通篇均为空话套话无具体抓手，本维度按 30% 得分率封顶。质量看密度不看长度，凝练扎实但篇幅短不扣分。");
        sb.AppendLine("8. **数据/证据密度**：90% 以上总分得分率要求方案中至少出现 5 处具体数据/链接/截图/对比/具体配置项，否则总分封顶 89%。");
        sb.AppendLine();
        sb.AppendLine("## 评分校准示例（仅作锚点参考，不代表实际方案）");
        sb.AppendLine();
        sb.AppendLine("**示例 A — 凝练高分 87/100**（落在 75-89 合格区间上沿）：");
        sb.AppendLine("> 为降低首屏加载 P95 从 3.2s 至 1.5s（数据来源：12 月监控 dashboard.example/perf），采用 SSR + 路由级 code-split。");
        sb.AppendLine("> 风险：旧版 Safari 兼容性下降 0.8%（参考 PR #1234 历史回归），监控埋点 sentry.first-paint 看护，超 2s 自动告警。");
        sb.AppendLine("评分理由：目标量化、方案明确、风险可观测、无废话；表达质量满分；信息密度高但缺乏行业洞察，因此未到 90+。");
        sb.AppendLine();
        sb.AppendLine("**示例 B — 堆砌中分 68/100**（落在 60-74 不通过区）：");
        sb.AppendLine("> 为了更好地服务用户，提升用户体验，我们需要对首屏加载进行优化升级。");
        sb.AppendLine("> 首屏加载是用户接触产品的第一印象，对用户体验至关重要。");
        sb.AppendLine("> 我们建议加强首屏加载的优化工作，从多个维度入手，全面提升性能…");
        sb.AppendLine("评分理由：3 句话说的是同一件事，无数据无方案；「表达质量与凝练度」按 50% 封顶（5 分），「问题陈述质量」「实现思路可行性」均严重不足；总分压在 60-74 区间，明确不通过。");
        sb.AppendLine();
        sb.AppendLine("**示例 C — 空洞低分 38/100**（落在 <60 重写区）：");
        sb.AppendLine("> 本次改造旨在优化产品体验，提升用户满意度，建立行业领先地位。");
        sb.AppendLine("> 我们将通过技术手段实现这一目标，确保项目顺利落地。");
        sb.AppendLine("评分理由：通篇无具体内容仅口号；「表达质量与凝练度」按 30% 封顶；多个维度趋零；需要重写。");
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
                sb.AppendLine("**叙事一致性硬要求（最重要！）**：");
                sb.AppendLine("- `involvedChecked=no`（用户声明不涉及）= **通过、计入得分**，**不是**\"未完成 / 未覆盖 / 0 分 / 缺失\"。");
                sb.AppendLine("- 你写的 `comment` 与顶层 `summary`，对该情况应措辞为「声明不涉及（合规）」「N 项声明不涉及视为合规通过」等正向表述。");
                sb.AppendLine("- 禁止把高得分维度在 `summary` 里描述为低分或不足，例如不得出现「检查清单得分极低 / 检查清单 0 分 / 全部未涉及导致 0 分」这种与系统派生分数冲突的表述。");
                sb.AppendLine("- 若你确认所有项都是 `no`（不涉及），请明确写「方案合规声明全部 N 项规则均不涉及，该维度满分通过」。");
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
        sb.AppendLine("**评分纪律**：");
        sb.AppendLine("- 多数合格方案应落 **75-89 区间**；不要轻易给到 90+。");
        sb.AppendLine("- 给 90+ 必须在 summary 里具体说明三项亮点：① 凝练（哪些表述压缩得当）② 数据/洞察（具体数据或非显而易见的判断）③ 立即可落地（实施路径清晰）。说不出来就降到 75-89 区间。");
        sb.AppendLine("- 给 95+ 极高分前自问：这份方案能否作为行业范本对外发布？不能就降到 90-94。");
        sb.AppendLine("- 重复表述、为撑字数的展开、空话套话必须显著扣分，并在评语点名「第 X 段与第 Y 段表达同一观点，建议合并」。");
        sb.AppendLine("- 如方案凝练扎实但篇幅短，不得因「内容不够多」扣分。质量看密度不看长度。");
        sb.AppendLine();
        sb.AppendLine("输出 JSON 格式结果。");
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
            // 用模板覆盖 LLM 自填的 comment，避免 LLM 文字叙事与系统派生分数错位
            // （例如 LLM 把"不涉及"误解为"0 分"，写出与实际得分矛盾的评语）
            score.Comment = BuildChecklistComment(score.Score, dimConfig.MaxScore, score.Items);
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
