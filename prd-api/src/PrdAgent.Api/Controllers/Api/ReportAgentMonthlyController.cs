using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Core.Services.ReportAgent;
using PrdAgent.Infrastructure.Database;
using System.Security.Claims;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 周报管理 Agent - 月报。
/// 固定四章、全部手写、不接入 AI；可见性由团队的 MonthlyReportVisibility 决定（草稿仅作者可见）。
/// 访问判定统一走 ReportAccessPolicy.CanViewMonthly，互动逻辑统一走 ReportInteractionService。
/// </summary>
[ApiController]
[Route("api/report-agent/monthly-reports")]
[Authorize]
[AdminController("report-agent", AdminPermissionCatalog.ReportAgentUse)]
public class ReportAgentMonthlyController : ControllerBase
{
    private const string AppKey = "report-agent";
    private const int WeeklyCandidateLimit = 60;

    private readonly MongoDbContext _db;
    private readonly ReportInteractionService _interactions;
    private readonly ReportViewerResolver _viewers;
    private readonly ILogger<ReportAgentMonthlyController> _logger;

    public ReportAgentMonthlyController(
        MongoDbContext db,
        ReportInteractionService interactions,
        ReportViewerResolver viewers,
        ILogger<ReportAgentMonthlyController> logger)
    {
        _db = db;
        _interactions = interactions;
        _viewers = viewers;
        _logger = logger;
    }

    #region Helpers

    private string GetUserId() => this.GetRequiredUserId();

    private string? GetUsername()
        => User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value;

    private bool HasPermission(string perm)
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(perm) || permissions.Contains(AdminPermissionCatalog.Super);
    }

    private bool HasViewAll => HasPermission(AdminPermissionCatalog.ReportAgentViewAll);

    private async Task<string> GetMonthlyVisibilityAsync(string teamId)
    {
        var team = await _db.ReportTeams.Find(t => t.Id == teamId).FirstOrDefaultAsync();
        return team?.MonthlyReportVisibility ?? ReportVisibilityMode.AllMembers;
    }

    /// <summary>加载月报并按可见性校验；不可见时与不存在同样返回 404 之外的 403，便于前端给出明确原因。</summary>
    private async Task<(MonthlyReport? Report, ReportViewer Viewer, IActionResult? Error)> LoadVisibleAsync(string id)
    {
        var userId = GetUserId();
        var report = await _db.MonthlyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return (null, default, NotFound(ApiResponse<object>.Fail("NOT_FOUND", "月报不存在")));

        var viewer = await _viewers.ResolveAsync(report.TeamId, report.UserId, userId, HasViewAll);
        var visibility = await GetMonthlyVisibilityAsync(report.TeamId);
        if (!ReportAccessPolicy.CanViewMonthly(viewer, visibility, report.Status))
        {
            var reason = report.Status == MonthlyReportStatus.Draft
                ? "这份月报还是草稿，只有作者本人可以查看"
                : "团队设置为仅负责人可查看成员月报";
            return (null, viewer, StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", reason)));
        }

        return (report, viewer, null);
    }

    private async Task<(MonthlyReport? Report, IActionResult? Error)> LoadOwnedAsync(string id)
    {
        var userId = GetUserId();
        var report = await _db.MonthlyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return (null, NotFound(ApiResponse<object>.Fail("NOT_FOUND", "月报不存在")));
        if (report.UserId != userId)
            return (null, StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只能修改自己的月报")));
        return (report, null);
    }

    /// <summary>关联周报的实时状态（周报被删除时 exists=false，前端显示「已删除」而不是坏链接）。</summary>
    private async Task<List<object>> BuildLinkedWeekliesAsync(MonthlyReport report)
    {
        var ids = report.WeeklyLinks.Select(l => l.WeeklyReportId).ToList();
        var weeklies = ids.Count == 0
            ? new List<WeeklyReport>()
            : await _db.WeeklyReports.Find(w => ids.Contains(w.Id)).ToListAsync();
        var map = weeklies.ToDictionary(w => w.Id, w => w);

        return report.WeeklyLinks.Select(l =>
        {
            map.TryGetValue(l.WeeklyReportId, out var weekly);
            return (object)new
            {
                weeklyReportId = l.WeeklyReportId,
                weekYear = l.WeekYear,
                weekNumber = l.WeekNumber,
                periodStart = l.PeriodStart,
                periodEnd = l.PeriodEnd,
                exists = weekly != null,
                status = weekly?.Status
            };
        }).ToList();
    }

    private object BuildSubmitIssues(MonthlyReport report)
        => MonthlyReportRules.ValidateForSubmit(report)
            .Select(e => new { chapter = e.Chapter, message = e.Message })
            .ToList();

    private async Task<object> BuildDetailPayloadAsync(MonthlyReport report, ReportViewer viewer)
    {
        return new
        {
            report,
            linkedWeeklies = await BuildLinkedWeekliesAsync(report),
            canEdit = viewer.IsOwner,
            submitIssues = viewer.IsOwner ? BuildSubmitIssues(report) : null,
            chapterTitles = MonthlyReportChapters.Titles
        };
    }

    #endregion

    /// <summary>
    /// 月报列表。scope=my：我的月报（可按团队/年月过滤）；scope=team：某团队某月已提交的月报（按可见性）。
    /// </summary>
    [HttpGet("")]
    public async Task<IActionResult> List(
        [FromQuery] string scope = "my",
        [FromQuery] string? teamId = null,
        [FromQuery] int? year = null,
        [FromQuery] int? month = null)
    {
        var userId = GetUserId();
        FilterDefinition<MonthlyReport> filter;

        if (scope == "team")
        {
            if (string.IsNullOrWhiteSpace(teamId) || !year.HasValue || !month.HasValue)
                return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "团队月报需要指定团队与年月"));

            var role = await _viewers.GetTeamRoleAsync(teamId, userId);
            var probe = new ReportViewer(false, role, HasViewAll);
            var visibility = await GetMonthlyVisibilityAsync(teamId);
            if (!ReportAccessPolicy.CanViewMonthly(probe, visibility, MonthlyReportStatus.Submitted))
                return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看该团队的月报"));

            filter = Builders<MonthlyReport>.Filter.Eq(r => r.TeamId, teamId)
                     & Builders<MonthlyReport>.Filter.Eq(r => r.Year, year.Value)
                     & Builders<MonthlyReport>.Filter.Eq(r => r.Month, month.Value)
                     & Builders<MonthlyReport>.Filter.Ne(r => r.Status, MonthlyReportStatus.Draft);
        }
        else
        {
            filter = Builders<MonthlyReport>.Filter.Eq(r => r.UserId, userId);
            if (!string.IsNullOrWhiteSpace(teamId))
                filter &= Builders<MonthlyReport>.Filter.Eq(r => r.TeamId, teamId);
            if (year.HasValue)
                filter &= Builders<MonthlyReport>.Filter.Eq(r => r.Year, year.Value);
            if (month.HasValue)
                filter &= Builders<MonthlyReport>.Filter.Eq(r => r.Month, month.Value);
        }

        var items = await _db.MonthlyReports.Find(filter)
            .SortByDescending(r => r.Year)
            .ThenByDescending(r => r.Month)
            .ThenBy(r => r.UserName)
            .Limit(200)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id)
    {
        var (report, viewer, error) = await LoadVisibleAsync(id);
        if (error != null) return error;
        return Ok(ApiResponse<object>.Ok(await BuildDetailPayloadAsync(report!, viewer)));
    }

    /// <summary>新建某团队某月的月报草稿；这个月已经有了就直接返回已有的那份（existed=true）。</summary>
    [HttpPost("")]
    public async Task<IActionResult> Create([FromBody] CreateMonthlyReportRequest req)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(req.TeamId))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "请选择团队"));
        if (!MonthlyReportRules.IsMonthAllowed(req.Year, req.Month, DateTime.UtcNow))
            return BadRequest(ApiResponse<object>.Fail("INVALID_MONTH", "只能填写当月或以前月份的月报"));

        var team = await _db.ReportTeams.Find(t => t.Id == req.TeamId).FirstOrDefaultAsync();
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));
        if (await _viewers.GetTeamRoleAsync(team.Id, userId) == null)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "你不是该团队成员，不能为它写月报"));

        var existing = await _db.MonthlyReports.Find(r =>
                r.UserId == userId && r.TeamId == team.Id && r.Year == req.Year && r.Month == req.Month)
            .FirstOrDefaultAsync();
        if (existing != null)
            return Ok(ApiResponse<object>.Ok(new { report = existing, existed = true }));

        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var report = new MonthlyReport
        {
            UserId = userId,
            UserName = ReportInteractionService.ResolveUserDisplayName(user, GetUsername(), userId),
            AvatarFileName = user?.AvatarFileName,
            TeamId = team.Id,
            TeamName = team.Name,
            Year = req.Year,
            Month = req.Month,
        };

        try
        {
            await _db.MonthlyReports.InsertOneAsync(report);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 唯一索引存在时的并发创建：返回胜出的那份
            var winner = await _db.MonthlyReports.Find(r =>
                    r.UserId == userId && r.TeamId == team.Id && r.Year == req.Year && r.Month == req.Month)
                .FirstOrDefaultAsync();
            return Ok(ApiResponse<object>.Ok(new { report = winner, existed = true }));
        }

        return Ok(ApiResponse<object>.Ok(new { report, existed = false }));
    }

    /// <summary>保存月报（草稿或已提交均可改；已提交后修改会留下 edited 记录）。</summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateMonthlyReportRequest req)
    {
        var (report, error) = await LoadOwnedAsync(id);
        if (error != null) return error;

        // 第一章：关联周报——只能是本人、本团队、已提交过的周报
        var weeklyIds = (req.WeeklyReportIds ?? new List<string>())
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Select(x => x.Trim())
            .Distinct()
            .ToList();
        var weeklies = weeklyIds.Count == 0
            ? new List<WeeklyReport>()
            : await _db.WeeklyReports.Find(w => weeklyIds.Contains(w.Id)).ToListAsync();
        var keptLinks = report!.WeeklyLinks.ToDictionary(l => l.WeeklyReportId, l => l);
        var links = new List<MonthlyReportWeeklyLink>();
        foreach (var wid in weeklyIds)
        {
            var weekly = weeklies.FirstOrDefault(w => w.Id == wid);
            if (weekly == null)
            {
                // 已关联、后来被删除的周报：保留原快照，让作者看得到「这一周的周报已删除」
                if (keptLinks.TryGetValue(wid, out var kept)) { links.Add(kept); continue; }
                return BadRequest(ApiResponse<object>.Fail("INVALID_WEEKLY", "要关联的周报不存在"));
            }
            if (!MonthlyReportRules.IsLinkableWeekly(weekly, report.UserId, report.TeamId))
                return BadRequest(ApiResponse<object>.Fail("INVALID_WEEKLY",
                    $"第 {weekly.WeekNumber} 周的周报不能关联：只能关联自己在本团队已提交的周报"));
            links.Add(new MonthlyReportWeeklyLink
            {
                WeeklyReportId = weekly.Id,
                WeekYear = weekly.WeekYear,
                WeekNumber = weekly.WeekNumber,
                PeriodStart = weekly.PeriodStart,
                PeriodEnd = weekly.PeriodEnd,
            });
        }

        // 第三章：伙伴——必须是在职用户，姓名与头像存快照
        var partnerInputs = req.Partners ?? new List<MonthlyReportPartnerInput>();
        var partnerIds = partnerInputs.Select(p => p.UserId).Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        var partnerUsers = partnerIds.Count == 0
            ? new List<User>()
            : await _db.Users.Find(u => partnerIds.Contains(u.UserId)).ToListAsync();
        var partners = new List<MonthlyReportPartner>();
        foreach (var input in partnerInputs)
        {
            var user = partnerUsers.FirstOrDefault(u => u.UserId == input.UserId);
            if (user == null || user.Status != UserStatus.Active)
                return BadRequest(ApiResponse<object>.Fail("INVALID_PARTNER", "选择的伙伴不存在或已停用"));
            partners.Add(new MonthlyReportPartner
            {
                UserId = user.UserId,
                UserName = ReportInteractionService.ResolveUserDisplayName(user, null, user.UserId),
                AvatarFileName = user.AvatarFileName,
                Reason = (input.Reason ?? string.Empty).Trim(),
            });
        }

        var candidate = new MonthlyReport
        {
            Id = report.Id,
            UserId = report.UserId,
            TeamId = report.TeamId,
            WeeklyLinks = links.OrderBy(l => l.PeriodStart).ToList(),
            AchievementsText = (req.AchievementsText ?? string.Empty).Trim(),
            ProblemsText = string.IsNullOrWhiteSpace(req.ProblemsText) ? null : req.ProblemsText.Trim(),
            Partners = partners,
            SuggestionsText = string.IsNullOrWhiteSpace(req.SuggestionsText) ? null : req.SuggestionsText.Trim(),
        };

        // 草稿允许不完整；已提交的月报改完仍必须是一份完整月报，否则负责人看到的是残缺版本
        var isDraft = report.Status == MonthlyReportStatus.Draft;
        var saveErrors = isDraft
            ? MonthlyReportRules.ValidateForSave(candidate)
            : MonthlyReportRules.ValidateForSubmit(candidate);
        if (saveErrors.Count > 0)
            return BadRequest(ApiResponse<object>.Fail("VALIDATION_FAILED",
                isDraft ? saveErrors[0].Message : $"已提交的月报需要保持完整：{saveErrors[0].Message}"));

        var now = DateTime.UtcNow;
        var update = Builders<MonthlyReport>.Update
            .Set(r => r.WeeklyLinks, candidate.WeeklyLinks)
            .Set(r => r.AchievementsText, candidate.AchievementsText)
            .Set(r => r.ProblemsText, candidate.ProblemsText)
            .Set(r => r.Partners, candidate.Partners)
            .Set(r => r.SuggestionsText, candidate.SuggestionsText)
            .Set(r => r.UpdatedAt, now);
        // 编辑页会自动保存：同一段编辑（10 分钟内）只记一条 edited，不让版本时间线被刷屏
        var last = report.VersionHistory.LastOrDefault();
        var recentlyEdited = last?.Event == ReportVersionEvent.Edited && now - last.At < TimeSpan.FromMinutes(10);
        if (!isDraft && !recentlyEdited)
            update = update.Push(r => r.VersionHistory, new ReportVersionEntry { Event = ReportVersionEvent.Edited, At = now });

        await _db.MonthlyReports.UpdateOneAsync(r => r.Id == report.Id, update);
        var saved = await _db.MonthlyReports.Find(r => r.Id == report.Id).FirstOrDefaultAsync();
        var viewer = new ReportViewer(true, null, HasViewAll);
        return Ok(ApiResponse<object>.Ok(await BuildDetailPayloadAsync(saved!, viewer)));
    }

    /// <summary>删除月报：只能删除自己的草稿，并清理它的评论、点赞、浏览记录。</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id)
    {
        var (report, error) = await LoadOwnedAsync(id);
        if (error != null) return error;
        if (report!.Status != MonthlyReportStatus.Draft)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "只有草稿状态的月报可以删除"));

        var result = await _db.MonthlyReports.DeleteOneAsync(r =>
            r.Id == id && r.UserId == report.UserId && r.Status == MonthlyReportStatus.Draft);
        if (result.DeletedCount == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "月报状态已变化，请刷新后重试"));

        await _interactions.DeleteAllForReportAsync(id);
        return Ok(ApiResponse<object>.Ok(new { }));
    }

    [HttpPost("{id}/submit")]
    public async Task<IActionResult> Submit(string id)
    {
        var (report, error) = await LoadOwnedAsync(id);
        if (error != null) return error;
        if (report!.Status != MonthlyReportStatus.Draft)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "这份月报已经提交过了"));

        var issues = MonthlyReportRules.ValidateForSubmit(report);
        if (issues.Count > 0)
            return BadRequest(ApiResponse<object>.Fail("VALIDATION_FAILED",
                string.Join("；", issues.Select(i => i.Message))));

        var now = DateTime.UtcNow;
        var result = await _db.MonthlyReports.UpdateOneAsync(
            r => r.Id == id && r.Status == MonthlyReportStatus.Draft,
            Builders<MonthlyReport>.Update
                .Set(r => r.Status, MonthlyReportStatus.Submitted)
                .Set(r => r.SubmittedAt, now)
                .Set(r => r.UpdatedAt, now)
                .Push(r => r.VersionHistory, new ReportVersionEntry { Event = ReportVersionEvent.Submitted, At = now }));
        if (result.ModifiedCount == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "月报状态已变化，请刷新后重试"));

        var saved = await _db.MonthlyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(await BuildDetailPayloadAsync(saved!, new ReportViewer(true, null, HasViewAll))));
    }

    /// <summary>记录一次浏览；负责人（非作者）首次打开已提交的月报时标记为「已查看」。</summary>
    [HttpPost("{id}/views")]
    public async Task<IActionResult> RecordView(string id)
    {
        var (report, viewer, error) = await LoadVisibleAsync(id);
        if (error != null) return error;

        var viewedAt = await _interactions.RecordViewAsync(report!.Id, GetUserId(), GetUsername());

        if (!viewer.IsOwner && viewer.IsLeaderOrDeputy && report.Status == MonthlyReportStatus.Submitted)
        {
            await _db.MonthlyReports.UpdateOneAsync(
                r => r.Id == report.Id && r.Status == MonthlyReportStatus.Submitted,
                Builders<MonthlyReport>.Update
                    .Set(r => r.Status, MonthlyReportStatus.Viewed)
                    .Set(r => r.ViewedAt, viewedAt));
        }

        return Ok(ApiResponse<object>.Ok(new { viewedAt }));
    }

    [HttpGet("{id}/views-summary")]
    public async Task<IActionResult> GetViewsSummary(string id)
    {
        var (report, _, error) = await LoadVisibleAsync(id);
        if (error != null) return error;
        return Ok(ApiResponse<object>.Ok(await _interactions.BuildViewSummaryAsync(report!.Id, report.UserId)));
    }

    #region Comments / Likes（与周报共用 ReportInteractionService，访问判定与「能否查看这份月报」一致）

    private ObjectResult InteractionFailure(ReportInteractionError error)
        => StatusCode(error.StatusCode, ApiResponse<object>.Fail(error.Code, error.Message));

    [HttpGet("{id}/comments")]
    public async Task<IActionResult> ListComments(string id, [FromQuery] int? sectionIndex)
    {
        var (_, _, error) = await LoadVisibleAsync(id);
        if (error != null) return error;
        return Ok(ApiResponse<object>.Ok(new { items = await _interactions.ListCommentsAsync(id, sectionIndex) }));
    }

    /// <summary>评论（章节序号 0-3 对应四章；支持回复、划词锚点、图片）</summary>
    [HttpPost("{id}/comments")]
    public async Task<IActionResult> CreateComment(string id, [FromBody] CreateCommentRequest req)
    {
        var (_, _, error) = await LoadVisibleAsync(id);
        if (error != null) return error;
        if (req.SectionIndex < 0 || req.SectionIndex >= MonthlyReportChapters.Titles.Length)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "评论的章节不存在"));

        var (comment, failure) = await _interactions.CreateCommentAsync(
            id, MonthlyReportChapters.TitleOf(req.SectionIndex), GetUserId(), GetUsername(), req);
        if (failure != null) return InteractionFailure(failure);
        return Ok(ApiResponse<object>.Ok(new { comment }));
    }

    [HttpPost("{id}/comments/images")]
    [RequestSizeLimit(ReportInteractionService.MaxCommentImageBytes)]
    public async Task<IActionResult> UploadCommentImage(string id, [FromForm] IFormFile file, CancellationToken ct)
    {
        var (_, _, error) = await LoadVisibleAsync(id);
        if (error != null) return error;
        var (data, failure) = await _interactions.UploadCommentImageAsync(GetUserId(), file, ct);
        if (failure != null) return InteractionFailure(failure);
        return Ok(ApiResponse<object>.Ok(data!));
    }

    [HttpPut("{id}/comments/{commentId}")]
    public async Task<IActionResult> UpdateComment(string id, string commentId, [FromBody] UpdateCommentRequest req)
    {
        var (_, _, error) = await LoadVisibleAsync(id);
        if (error != null) return error;
        var (comment, failure) = await _interactions.UpdateCommentAsync(id, commentId, GetUserId(), HasViewAll, req.Content);
        if (failure != null) return InteractionFailure(failure);
        return Ok(ApiResponse<object>.Ok(new { comment }));
    }

    [HttpDelete("{id}/comments/{commentId}")]
    public async Task<IActionResult> DeleteComment(string id, string commentId)
    {
        var (_, _, error) = await LoadVisibleAsync(id);
        if (error != null) return error;
        var failure = await _interactions.DeleteCommentAsync(id, commentId, GetUserId(), HasViewAll);
        if (failure != null) return InteractionFailure(failure);
        return Ok(ApiResponse<object>.Ok(new { }));
    }

    [HttpGet("{id}/likes")]
    public async Task<IActionResult> ListLikes(string id)
    {
        var (_, _, error) = await LoadVisibleAsync(id);
        if (error != null) return error;
        return Ok(ApiResponse<object>.Ok(await _interactions.BuildLikeSummaryAsync(id, GetUserId())));
    }

    [HttpPost("{id}/likes")]
    public async Task<IActionResult> Like(string id)
    {
        var (_, _, error) = await LoadVisibleAsync(id);
        if (error != null) return error;
        var userId = GetUserId();
        await _interactions.LikeAsync(id, userId, GetUsername());
        return Ok(ApiResponse<object>.Ok(await _interactions.BuildLikeSummaryAsync(id, userId)));
    }

    [HttpDelete("{id}/likes")]
    public async Task<IActionResult> Unlike(string id)
    {
        var (_, _, error) = await LoadVisibleAsync(id);
        if (error != null) return error;
        var userId = GetUserId();
        await _interactions.UnlikeAsync(id, userId);
        return Ok(ApiResponse<object>.Ok(await _interactions.BuildLikeSummaryAsync(id, userId)));
    }

    #endregion

    /// <summary>
    /// 可关联的周报：我在该团队的周报（最近 60 份），按周四归属分组——
    /// current = 归属本月，adjacent = 归属相邻月，other = 其余；linkable=false 的是草稿等不可关联项。
    /// </summary>
    [HttpGet("weekly-candidates")]
    public async Task<IActionResult> WeeklyCandidates(
        [FromQuery] string teamId,
        [FromQuery] int year,
        [FromQuery] int month)
    {
        var userId = GetUserId();
        if (string.IsNullOrWhiteSpace(teamId) || month < 1 || month > 12)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "需要指定团队与年月"));

        var weeklies = await _db.WeeklyReports
            .Find(w => w.UserId == userId && w.TeamId == teamId)
            .SortByDescending(w => w.PeriodEnd)
            .Limit(WeeklyCandidateLimit)
            .ToListAsync();

        var target = year * 12 + (month - 1);
        var items = weeklies.Select(w =>
        {
            var (ay, am) = MonthlyReportRules.GetAttributedMonth(w.WeekYear, w.WeekNumber);
            var distance = Math.Abs(ay * 12 + (am - 1) - target);
            return new
            {
                weeklyReportId = w.Id,
                weekYear = w.WeekYear,
                weekNumber = w.WeekNumber,
                periodStart = w.PeriodStart,
                periodEnd = w.PeriodEnd,
                status = w.Status,
                attributedYear = ay,
                attributedMonth = am,
                group = distance == 0 ? "current" : distance == 1 ? "adjacent" : "other",
                linkable = MonthlyReportRules.IsLinkableWeekly(w, userId, teamId),
            };
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items }));
    }
}

public class CreateMonthlyReportRequest
{
    public string TeamId { get; set; } = string.Empty;
    public int Year { get; set; }
    public int Month { get; set; }
}

public class UpdateMonthlyReportRequest
{
    /// <summary>第一章：关联的周报 Id（按勾选顺序，服务端按周起始日期排序存储）</summary>
    public List<string>? WeeklyReportIds { get; set; }
    public string? AchievementsText { get; set; }
    public string? ProblemsText { get; set; }
    public List<MonthlyReportPartnerInput>? Partners { get; set; }
    public string? SuggestionsText { get; set; }
}

public class MonthlyReportPartnerInput
{
    public string UserId { get; set; } = string.Empty;
    public string? Reason { get; set; }
}
