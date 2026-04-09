using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.PrReviewPrism;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// PR审查棱镜（独立于产品评审员 review-agent）：
/// 提交 GitHub PR 链接并拉取 L1 Gate 与决策卡可视化结果。
/// </summary>
[ApiController]
[Route("api/pr-review-prism")]
[Authorize]
[AdminController("pr-review-prism", AdminPermissionCatalog.PrReviewPrismUse)]
public sealed class PrReviewPrismController : ControllerBase
{
    private const string AppKey = "pr-review-prism";
    private readonly MongoDbContext _db;
    private readonly PrReviewPrismSnapshotBuilder _snapshotBuilder;
    private readonly ILogger<PrReviewPrismController> _logger;

    public PrReviewPrismController(
        MongoDbContext db,
        PrReviewPrismSnapshotBuilder snapshotBuilder,
        ILogger<PrReviewPrismController> logger)
    {
        _db = db;
        _snapshotBuilder = snapshotBuilder;
        _logger = logger;
    }

    /// <summary>
    /// 健康检查 / 占位：确认具备 pr-review-prism.use 后可调用。
    /// </summary>
    [HttpGet("status")]
    public IActionResult GetStatus()
    {
        return Ok(ApiResponse<object>.Ok(new
        {
            appKey = AppKey,
            phase = "active",
            message = "PR审查棱镜已接入 GitHub 审查结果可视化，可提交 PR 链接并查看 Gate/决策卡结果。",
        }));
    }

    [HttpPost("submissions")]
    public async Task<IActionResult> CreateSubmission([FromBody] CreatePrReviewPrismSubmissionRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.PullRequestUrl))
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "pullRequestUrl 不能为空"));
        }

        var parse = PrReviewPrismSnapshotBuilder.TryParsePullRequestUrl(req.PullRequestUrl, out var owner, out var repo, out var prNumber);
        if (!parse)
        {
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "pullRequestUrl 不是有效的 GitHub PR 链接"));
        }

        var userId = this.GetRequiredUserId();
        var displayName = User.FindFirst("displayName")?.Value
                          ?? User.FindFirst("name")?.Value
                          ?? userId;

        var normalizedOwner = owner!.ToLowerInvariant();
        var normalizedRepo = repo!.ToLowerInvariant();
        var normalizedUrl = $"https://github.com/{normalizedOwner}/{normalizedRepo}/pull/{prNumber}";

        var existing = await _db.PrReviewPrismSubmissions
            .Find(x => x.OwnerUserId == userId
                       && x.RepoOwner == normalizedOwner
                       && x.RepoName == normalizedRepo
                       && x.PullRequestNumber == prNumber)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (existing != null)
        {
            existing.Note = string.IsNullOrWhiteSpace(req.Note) ? existing.Note : req.Note.Trim();
            existing.PullRequestUrl = normalizedUrl;
            existing.UpdatedAt = DateTime.UtcNow;

            try
            {
                var snapshot = await _snapshotBuilder.BuildSnapshotAsync(normalizedOwner, normalizedRepo, prNumber);
                ApplySnapshot(existing, snapshot);
                existing.LastRefreshError = null;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "PrReviewPrism refresh existing failed: {Owner}/{Repo}#{Pr}", normalizedOwner, normalizedRepo, prNumber);
                existing.LastRefreshError = ex.Message;
                existing.GateStatus = PrReviewPrismGateStatuses.Error;
            }

            await _db.PrReviewPrismSubmissions.ReplaceOneAsync(
                x => x.Id == existing.Id,
                existing,
                cancellationToken: CancellationToken.None);

            return Ok(ApiResponse<object>.Ok(new { submission = existing, reused = true }));
        }

        var submission = new PrReviewPrismSubmission
        {
            OwnerUserId = userId,
            OwnerDisplayName = displayName,
            RepoOwner = normalizedOwner,
            RepoName = normalizedRepo,
            PullRequestNumber = prNumber,
            PullRequestUrl = normalizedUrl,
            Note = string.IsNullOrWhiteSpace(req.Note) ? null : req.Note.Trim(),
            GateStatus = PrReviewPrismGateStatuses.Pending,
        };

        try
        {
            var snapshot = await _snapshotBuilder.BuildSnapshotAsync(normalizedOwner, normalizedRepo, prNumber);
            ApplySnapshot(submission, snapshot);
            submission.LastRefreshError = null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PrReviewPrism initial refresh failed: {Owner}/{Repo}#{Pr}", normalizedOwner, normalizedRepo, prNumber);
            submission.LastRefreshError = ex.Message;
            submission.GateStatus = PrReviewPrismGateStatuses.Error;
        }

        await _db.PrReviewPrismSubmissions.InsertOneAsync(submission, cancellationToken: CancellationToken.None);
        return Ok(ApiResponse<object>.Ok(new { submission, reused = false }));
    }

    [HttpGet("submissions")]
    public async Task<IActionResult> ListSubmissions(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? q = null)
    {
        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var userId = this.GetRequiredUserId();
        var filterBuilder = Builders<PrReviewPrismSubmission>.Filter;
        var filter = filterBuilder.Eq(x => x.OwnerUserId, userId);

        if (!string.IsNullOrWhiteSpace(q))
        {
            var keyword = q.Trim();
            var regex = new MongoDB.Bson.BsonRegularExpression(keyword, "i");
            filter &= filterBuilder.Or(
                filterBuilder.Regex(x => x.PullRequestTitle, regex),
                filterBuilder.Regex(x => x.RepoOwner, regex),
                filterBuilder.Regex(x => x.RepoName, regex),
                filterBuilder.Regex(x => x.Note, regex));
        }

        var total = await _db.PrReviewPrismSubmissions.CountDocumentsAsync(filter, cancellationToken: CancellationToken.None);
        var items = await _db.PrReviewPrismSubmissions
            .Find(filter)
            .SortByDescending(x => x.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    [HttpGet("submissions/{id}")]
    public async Task<IActionResult> GetSubmission(string id)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.PrReviewPrismSubmissions
            .Find(x => x.Id == id && x.OwnerUserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "提交记录不存在"));
        }

        return Ok(ApiResponse<object>.Ok(new { submission = item }));
    }

    [HttpPost("submissions/{id}/refresh")]
    public async Task<IActionResult> RefreshSubmission(string id)
    {
        var userId = this.GetRequiredUserId();
        var item = await _db.PrReviewPrismSubmissions
            .Find(x => x.Id == id && x.OwnerUserId == userId)
            .FirstOrDefaultAsync(CancellationToken.None);

        if (item == null)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "提交记录不存在"));
        }

        try
        {
            var snapshot = await _snapshotBuilder.BuildSnapshotAsync(item.RepoOwner, item.RepoName, item.PullRequestNumber);
            ApplySnapshot(item, snapshot);
            item.LastRefreshError = null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PrReviewPrism refresh failed: {Id}", id);
            item.LastRefreshError = ex.Message;
            item.GateStatus = PrReviewPrismGateStatuses.Error;
            item.UpdatedAt = DateTime.UtcNow;
        }

        await _db.PrReviewPrismSubmissions.ReplaceOneAsync(
            x => x.Id == item.Id,
            item,
            cancellationToken: CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(new { submission = item }));
    }

    [HttpDelete("submissions/{id}")]
    public async Task<IActionResult> DeleteSubmission(string id)
    {
        var userId = this.GetRequiredUserId();
        var result = await _db.PrReviewPrismSubmissions.DeleteOneAsync(
            x => x.Id == id && x.OwnerUserId == userId,
            cancellationToken: CancellationToken.None);

        if (result.DeletedCount == 0)
        {
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "提交记录不存在"));
        }

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    private static void ApplySnapshot(PrReviewPrismSubmission target, PrReviewPrismSnapshot snapshot)
    {
        target.RepoOwner = snapshot.RepoOwner;
        target.RepoName = snapshot.RepoName;
        target.PullRequestNumber = snapshot.PullRequestNumber;
        target.PullRequestUrl = snapshot.PullRequestUrl;
        target.PullRequestTitle = snapshot.PullRequestTitle;
        target.PullRequestAuthor = snapshot.PullRequestAuthor;
        target.PullRequestState = snapshot.PullRequestState;
        target.HeadSha = snapshot.HeadSha;
        target.GateStatus = snapshot.GateStatus;
        target.GateConclusion = snapshot.GateConclusion;
        target.GateDetailsUrl = snapshot.GateDetailsUrl;
        target.DecisionSuggestion = snapshot.DecisionSuggestion;
        target.RiskScore = snapshot.RiskScore;
        target.ConfidencePercent = snapshot.ConfidencePercent;
        target.BlockersTriggered = snapshot.BlockersTriggered;
        target.Blockers = snapshot.Blockers;
        target.Advisories = snapshot.Advisories;
        target.FocusQuestions = snapshot.FocusQuestions;
        target.DecisionCardCommentUrl = snapshot.DecisionCardCommentUrl;
        target.DecisionCardUpdatedAt = snapshot.DecisionCardUpdatedAt;
        target.LastRefreshedAt = DateTime.UtcNow;
        target.UpdatedAt = DateTime.UtcNow;
    }
}

public sealed class CreatePrReviewPrismSubmissionRequest
{
    public string PullRequestUrl { get; set; } = string.Empty;
    public string? Note { get; set; }
}
