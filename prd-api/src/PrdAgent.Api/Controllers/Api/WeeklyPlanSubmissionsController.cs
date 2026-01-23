using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using System.Security.Claims;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 周计划 Agent - 计划提交与审阅
/// </summary>
[ApiController]
[Route("api/weekly-plan-agent/plans")]
[Authorize]
[AdminController("weekly-plan-agent", AdminPermissionCatalog.WeeklyPlanAgentUse)]
public class WeeklyPlanSubmissionsController : ControllerBase
{
    private readonly MongoDbContext _db;

    public WeeklyPlanSubmissionsController(MongoDbContext db)
    {
        _db = db;
    }

    private string GetAdminId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    /// <summary>
    /// 获取个人计划列表（按周期倒序）
    /// </summary>
    [HttpGet]
    public async Task<IActionResult> ListMyPlans(
        [FromQuery] string? status,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        CancellationToken ct = default)
    {
        var userId = GetAdminId();
        var filterBuilder = Builders<WeeklyPlanSubmission>.Filter;
        var filter = filterBuilder.Eq(x => x.UserId, userId);

        if (!string.IsNullOrWhiteSpace(status))
            filter &= filterBuilder.Eq(x => x.Status, status);

        var total = await _db.WeeklyPlanSubmissions.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.WeeklyPlanSubmissions
            .Find(filter)
            .SortByDescending(x => x.PeriodStart)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>
    /// 获取团队计划列表（管理视图：查看所有人的计划）
    /// </summary>
    [HttpGet("team")]
    public async Task<IActionResult> ListTeamPlans(
        [FromQuery] string? periodStart,
        [FromQuery] string? status,
        [FromQuery] string? userId,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 50,
        CancellationToken ct = default)
    {
        var filterBuilder = Builders<WeeklyPlanSubmission>.Filter;
        var filter = filterBuilder.Empty;

        // 按周期筛选
        if (!string.IsNullOrWhiteSpace(periodStart) && DateTime.TryParse(periodStart, out var periodDate))
        {
            filter &= filterBuilder.Eq(x => x.PeriodStart, periodDate.Date);
        }

        if (!string.IsNullOrWhiteSpace(status))
            filter &= filterBuilder.Eq(x => x.Status, status);

        if (!string.IsNullOrWhiteSpace(userId))
            filter &= filterBuilder.Eq(x => x.UserId, userId);

        var total = await _db.WeeklyPlanSubmissions.CountDocumentsAsync(filter, cancellationToken: ct);
        var items = await _db.WeeklyPlanSubmissions
            .Find(filter)
            .SortByDescending(x => x.PeriodStart)
            .ThenBy(x => x.UserDisplayName)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync(ct);

        return Ok(ApiResponse<object>.Ok(new { items, total, page, pageSize }));
    }

    /// <summary>
    /// 获取单个计划详情
    /// </summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> GetById(string id, CancellationToken ct)
    {
        var plan = await _db.WeeklyPlanSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (plan == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "计划不存在"));

        return Ok(ApiResponse<object>.Ok(new { plan }));
    }

    /// <summary>
    /// 创建/保存计划（草稿状态）
    /// </summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateWeeklyPlanRequest request, CancellationToken ct)
    {
        var userId = GetAdminId();

        if (string.IsNullOrWhiteSpace(request.TemplateId))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "templateId 不能为空"));

        // 查找模板获取名称快照
        var template = await _db.WeeklyPlanTemplates.Find(x => x.Id == request.TemplateId).FirstOrDefaultAsync(ct);
        if (template == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "模板不存在"));

        // 计算周期（默认为本周一到周日）
        var periodStart = request.PeriodStart?.Date ?? GetMonday(DateTime.UtcNow);
        var periodEnd = periodStart.AddDays(6);

        // 检查同一用户、同一模板、同一周期是否已存在
        var existing = await _db.WeeklyPlanSubmissions.Find(x =>
            x.UserId == userId &&
            x.TemplateId == request.TemplateId &&
            x.PeriodStart == periodStart
        ).FirstOrDefaultAsync(ct);

        if (existing != null)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT,
                $"本周({periodStart:yyyy-MM-dd})已存在该模板的计划，请直接编辑"));

        // 获取用户显示名称
        var user = await _db.Users.Find(x => x.Id == userId).FirstOrDefaultAsync(ct);
        var displayName = user?.DisplayName ?? user?.Username ?? userId;

        var plan = new WeeklyPlanSubmission
        {
            Id = Guid.NewGuid().ToString("N"),
            TemplateId = request.TemplateId,
            TemplateName = template.Name,
            UserId = userId,
            UserDisplayName = displayName,
            PeriodStart = periodStart,
            PeriodEnd = periodEnd,
            Status = "draft",
            Entries = request.Entries?.Select(e => new PlanSectionEntry
            {
                SectionId = e.SectionId ?? string.Empty,
                Value = e.Value
            }).ToList() ?? new List<PlanSectionEntry>(),
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        };

        await _db.WeeklyPlanSubmissions.InsertOneAsync(plan, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { plan }));
    }

    /// <summary>
    /// 更新计划内容（仅 draft 状态可编辑）
    /// </summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateWeeklyPlanRequest request, CancellationToken ct)
    {
        var userId = GetAdminId();

        var plan = await _db.WeeklyPlanSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (plan == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "计划不存在"));

        if (plan.UserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权编辑他人的计划"));

        if (plan.Status != "draft")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "已提交的计划不可编辑，如需修改请先撤回"));

        if (request.Entries != null)
        {
            plan.Entries = request.Entries.Select(e => new PlanSectionEntry
            {
                SectionId = e.SectionId ?? string.Empty,
                Value = e.Value
            }).ToList();
        }

        plan.UpdatedAt = DateTime.UtcNow;

        await _db.WeeklyPlanSubmissions.ReplaceOneAsync(x => x.Id == id, plan, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { plan }));
    }

    /// <summary>
    /// 提交计划（从 draft → submitted）
    /// </summary>
    [HttpPut("{id}/submit")]
    public async Task<IActionResult> Submit(string id, [FromBody] SubmitWeeklyPlanRequest? request, CancellationToken ct)
    {
        var userId = GetAdminId();

        var plan = await _db.WeeklyPlanSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (plan == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "计划不存在"));

        if (plan.UserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权提交他人的计划"));

        if (plan.Status == "submitted")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "计划已提交"));

        // 允许提交时同时更新内容
        if (request?.Entries != null)
        {
            plan.Entries = request.Entries.Select(e => new PlanSectionEntry
            {
                SectionId = e.SectionId ?? string.Empty,
                Value = e.Value
            }).ToList();
        }

        plan.Status = "submitted";
        plan.SubmittedAt = DateTime.UtcNow;
        plan.UpdatedAt = DateTime.UtcNow;

        await _db.WeeklyPlanSubmissions.ReplaceOneAsync(x => x.Id == id, plan, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { plan }));
    }

    /// <summary>
    /// 撤回提交（从 submitted → draft，仅未审阅时可撤回）
    /// </summary>
    [HttpPut("{id}/withdraw")]
    public async Task<IActionResult> Withdraw(string id, CancellationToken ct)
    {
        var userId = GetAdminId();

        var plan = await _db.WeeklyPlanSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (plan == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "计划不存在"));

        if (plan.UserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权操作他人的计划"));

        if (plan.Status != "submitted")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅已提交且未审阅的计划可撤回"));

        plan.Status = "draft";
        plan.SubmittedAt = null;
        plan.UpdatedAt = DateTime.UtcNow;

        await _db.WeeklyPlanSubmissions.ReplaceOneAsync(x => x.Id == id, plan, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { plan }));
    }

    /// <summary>
    /// 审阅计划（管理者操作）
    /// </summary>
    [HttpPut("{id}/review")]
    public async Task<IActionResult> Review(string id, [FromBody] ReviewWeeklyPlanRequest request, CancellationToken ct)
    {
        var adminId = GetAdminId();

        var plan = await _db.WeeklyPlanSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (plan == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "计划不存在"));

        if (plan.Status != "submitted")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "仅已提交的计划可审阅"));

        plan.Status = "reviewed";
        plan.ReviewedBy = adminId;
        plan.ReviewedAt = DateTime.UtcNow;
        plan.ReviewComment = request.Comment?.Trim();
        plan.UpdatedAt = DateTime.UtcNow;

        await _db.WeeklyPlanSubmissions.ReplaceOneAsync(x => x.Id == id, plan, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new { plan }));
    }

    /// <summary>
    /// 删除计划（仅 draft 状态可删除）
    /// </summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct)
    {
        var userId = GetAdminId();

        var plan = await _db.WeeklyPlanSubmissions.Find(x => x.Id == id).FirstOrDefaultAsync(ct);
        if (plan == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "计划不存在"));

        if (plan.UserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "无权删除他人的计划"));

        if (plan.Status != "draft")
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "已提交的计划不可删除"));

        await _db.WeeklyPlanSubmissions.DeleteOneAsync(x => x.Id == id, ct);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 获取统计数据（本周提交率、各状态计数等）
    /// </summary>
    [HttpGet("stats")]
    public async Task<IActionResult> GetStats(CancellationToken ct)
    {
        var thisMonday = GetMonday(DateTime.UtcNow);
        var filterBuilder = Builders<WeeklyPlanSubmission>.Filter;

        var thisWeekFilter = filterBuilder.Eq(x => x.PeriodStart, thisMonday);
        var thisWeekPlans = await _db.WeeklyPlanSubmissions.Find(thisWeekFilter).ToListAsync(ct);

        var stats = new
        {
            thisWeek = new
            {
                total = thisWeekPlans.Count,
                draft = thisWeekPlans.Count(x => x.Status == "draft"),
                submitted = thisWeekPlans.Count(x => x.Status == "submitted"),
                reviewed = thisWeekPlans.Count(x => x.Status == "reviewed"),
            },
            periodStart = thisMonday,
            periodEnd = thisMonday.AddDays(6)
        };

        return Ok(ApiResponse<object>.Ok(stats));
    }

    private static DateTime GetMonday(DateTime date)
    {
        var diff = (7 + (date.DayOfWeek - DayOfWeek.Monday)) % 7;
        return date.AddDays(-diff).Date;
    }
}

// ===== Request DTOs =====

public class CreateWeeklyPlanRequest
{
    public string TemplateId { get; set; } = string.Empty;
    public DateTime? PeriodStart { get; set; }
    public List<PlanSectionEntryInput>? Entries { get; set; }
}

public class UpdateWeeklyPlanRequest
{
    public List<PlanSectionEntryInput>? Entries { get; set; }
}

public class SubmitWeeklyPlanRequest
{
    public List<PlanSectionEntryInput>? Entries { get; set; }
}

public class ReviewWeeklyPlanRequest
{
    public string? Comment { get; set; }
}

public class PlanSectionEntryInput
{
    public string? SectionId { get; set; }
    public object? Value { get; set; }
}
