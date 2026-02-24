using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using System.Globalization;
using System.Security.Claims;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 管理后台 - 周报管理 Agent
/// </summary>
[ApiController]
[Route("api/report-agent")]
[Authorize]
[AdminController("report-agent", AdminPermissionCatalog.ReportAgentUse)]
public class ReportAgentController : ControllerBase
{
    private const string AppKey = "report-agent";
    private readonly MongoDbContext _db;
    private readonly ILogger<ReportAgentController> _logger;

    public ReportAgentController(MongoDbContext db, ILogger<ReportAgentController> logger)
    {
        _db = db;
        _logger = logger;
    }

    #region Helpers

    private string GetUserId()
        => User.FindFirst("sub")?.Value
           ?? User.FindFirst(ClaimTypes.NameIdentifier)?.Value
           ?? "unknown";

    private string? GetUsername()
        => User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value;

    private bool HasPermission(string perm)
    {
        var permissions = User.FindAll("permissions").Select(c => c.Value).ToList();
        return permissions.Contains(perm) || permissions.Contains(AdminPermissionCatalog.Super);
    }

    private async Task<bool> IsTeamLeaderOrDeputy(string teamId, string userId)
    {
        var member = await _db.ReportTeamMembers.Find(
            m => m.TeamId == teamId && m.UserId == userId &&
                 (m.Role == ReportTeamRole.Leader || m.Role == ReportTeamRole.Deputy)
        ).FirstOrDefaultAsync();
        return member != null;
    }

    private async Task<bool> IsTeamMember(string teamId, string userId)
    {
        return await _db.ReportTeamMembers.Find(
            m => m.TeamId == teamId && m.UserId == userId
        ).AnyAsync();
    }

    private static (int weekYear, int weekNumber, DateTime periodStart, DateTime periodEnd) GetWeekInfo(DateTime date)
    {
        var weekYear = ISOWeek.GetYear(date);
        var weekNumber = ISOWeek.GetWeekOfYear(date);
        var monday = ISOWeek.ToDateTime(weekYear, weekNumber, DayOfWeek.Monday);
        var sunday = monday.AddDays(6);
        return (weekYear, weekNumber, monday, sunday);
    }

    #endregion

    #region Team Management

    /// <summary>
    /// 列出用户相关团队
    /// </summary>
    [HttpGet("teams")]
    public async Task<IActionResult> ListTeams()
    {
        var userId = GetUserId();

        if (HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
        {
            var all = await _db.ReportTeams.Find(_ => true)
                .SortByDescending(t => t.CreatedAt).ToListAsync();
            return Ok(ApiResponse<object>.Ok(new { items = all }));
        }

        // 查找用户所在的团队 ID
        var memberships = await _db.ReportTeamMembers.Find(m => m.UserId == userId).ToListAsync();
        var teamIds = memberships.Select(m => m.TeamId).Distinct().ToList();

        // 同时查找用户作为 leader 的团队
        var leaderTeams = await _db.ReportTeams.Find(t => t.LeaderUserId == userId).ToListAsync();
        var leaderTeamIds = leaderTeams.Select(t => t.Id).ToList();
        teamIds = teamIds.Union(leaderTeamIds).Distinct().ToList();

        var teams = await _db.ReportTeams.Find(t => teamIds.Contains(t.Id))
            .SortByDescending(t => t.CreatedAt).ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items = teams }));
    }

    /// <summary>
    /// 获取团队详情（含成员）
    /// </summary>
    [HttpGet("teams/{id}")]
    public async Task<IActionResult> GetTeam(string id)
    {
        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        var members = await _db.ReportTeamMembers.Find(m => m.TeamId == id)
            .SortBy(m => m.JoinedAt).ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { team, members }));
    }

    /// <summary>
    /// 创建团队
    /// </summary>
    [HttpPost("teams")]
    public async Task<IActionResult> CreateTeam([FromBody] CreateTeamRequest req)
    {
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTeamManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少团队管理权限"));

        if (string.IsNullOrWhiteSpace(req.Name))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "团队名称不能为空"));

        // 查找 leader 用户信息
        var leaderUser = await _db.Users.Find(u => u.UserId == req.LeaderUserId).FirstOrDefaultAsync();
        if (leaderUser == null)
            return BadRequest(ApiResponse<object>.Fail("NOT_FOUND", "负责人用户不存在"));

        var team = new ReportTeam
        {
            Name = req.Name.Trim(),
            LeaderUserId = req.LeaderUserId,
            LeaderName = leaderUser.DisplayName ?? leaderUser.Username,
            ParentTeamId = req.ParentTeamId,
            Description = req.Description
        };
        await _db.ReportTeams.InsertOneAsync(team);

        // 自动将 leader 添加为团队成员
        var leaderMember = new ReportTeamMember
        {
            TeamId = team.Id,
            UserId = req.LeaderUserId,
            UserName = leaderUser.DisplayName ?? leaderUser.Username,
            AvatarFileName = leaderUser.AvatarFileName,
            Role = ReportTeamRole.Leader
        };
        await _db.ReportTeamMembers.InsertOneAsync(leaderMember);

        return Ok(ApiResponse<object>.Ok(new { team }));
    }

    /// <summary>
    /// 更新团队
    /// </summary>
    [HttpPut("teams/{id}")]
    public async Task<IActionResult> UpdateTeam(string id, [FromBody] UpdateTeamRequest req)
    {
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTeamManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少团队管理权限"));

        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        var update = Builders<ReportTeam>.Update
            .Set(t => t.UpdatedAt, DateTime.UtcNow);

        if (req.Name != null)
            update = update.Set(t => t.Name, req.Name.Trim());
        if (req.Description != null)
            update = update.Set(t => t.Description, req.Description);
        if (req.LeaderUserId != null)
        {
            var leaderUser = await _db.Users.Find(u => u.UserId == req.LeaderUserId).FirstOrDefaultAsync();
            if (leaderUser == null)
                return BadRequest(ApiResponse<object>.Fail("NOT_FOUND", "负责人用户不存在"));
            update = update.Set(t => t.LeaderUserId, req.LeaderUserId)
                           .Set(t => t.LeaderName, leaderUser.DisplayName ?? leaderUser.Username);
        }

        await _db.ReportTeams.UpdateOneAsync(t => t.Id == id, update);

        var updated = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { team = updated }));
    }

    /// <summary>
    /// 删除团队
    /// </summary>
    [HttpDelete("teams/{id}")]
    public async Task<IActionResult> DeleteTeam(string id)
    {
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTeamManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少团队管理权限"));

        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        // 检查是否有关联的周报
        var hasReports = await _db.WeeklyReports.Find(r => r.TeamId == id).AnyAsync();
        if (hasReports)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "该团队下存在周报，无法删除"));

        // 删除成员和团队
        await _db.ReportTeamMembers.DeleteManyAsync(m => m.TeamId == id);
        await _db.ReportTeams.DeleteOneAsync(t => t.Id == id);

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 添加团队成员
    /// </summary>
    [HttpPost("teams/{id}/members")]
    public async Task<IActionResult> AddTeamMember(string id, [FromBody] AddTeamMemberRequest req)
    {
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTeamManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少团队管理权限"));

        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        var user = await _db.Users.Find(u => u.UserId == req.UserId).FirstOrDefaultAsync();
        if (user == null)
            return BadRequest(ApiResponse<object>.Fail("NOT_FOUND", "用户不存在"));

        // 检查是否已是成员
        var exists = await _db.ReportTeamMembers.Find(
            m => m.TeamId == id && m.UserId == req.UserId).AnyAsync();
        if (exists)
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE", "该用户已是团队成员"));

        var member = new ReportTeamMember
        {
            TeamId = id,
            UserId = req.UserId,
            UserName = user.DisplayName ?? user.Username,
            AvatarFileName = user.AvatarFileName,
            Role = req.Role ?? ReportTeamRole.Member,
            JobTitle = req.JobTitle
        };
        await _db.ReportTeamMembers.InsertOneAsync(member);

        return Ok(ApiResponse<object>.Ok(new { member }));
    }

    /// <summary>
    /// 移除团队成员
    /// </summary>
    [HttpDelete("teams/{id}/members/{userId}")]
    public async Task<IActionResult> RemoveTeamMember(string id, string userId)
    {
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTeamManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少团队管理权限"));

        var result = await _db.ReportTeamMembers.DeleteOneAsync(
            m => m.TeamId == id && m.UserId == userId);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "成员不存在"));

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 更新团队成员角色/岗位
    /// </summary>
    [HttpPut("teams/{id}/members/{userId}")]
    public async Task<IActionResult> UpdateTeamMember(string id, string userId, [FromBody] UpdateTeamMemberRequest req)
    {
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTeamManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少团队管理权限"));

        var update = Builders<ReportTeamMember>.Update.Combine();
        if (req.Role != null)
            update = update.Set(m => m.Role, req.Role);
        if (req.JobTitle != null)
            update = update.Set(m => m.JobTitle, req.JobTitle);

        var result = await _db.ReportTeamMembers.UpdateOneAsync(
            m => m.TeamId == id && m.UserId == userId, update);
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "成员不存在"));

        var updated = await _db.ReportTeamMembers.Find(
            m => m.TeamId == id && m.UserId == userId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { member = updated }));
    }

    /// <summary>
    /// 获取用户列表（用于成员选择）
    /// </summary>
    [HttpGet("users")]
    public async Task<IActionResult> ListUsers()
    {
        var users = await _db.Users.Find(u => u.IsActive != false)
            .SortBy(u => u.Username)
            .Project(u => new
            {
                id = u.UserId,
                username = u.Username,
                displayName = u.DisplayName,
                avatarFileName = u.AvatarFileName
            })
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items = users }));
    }

    #endregion

    #region Template Management

    /// <summary>
    /// 列出模板
    /// </summary>
    [HttpGet("templates")]
    public async Task<IActionResult> ListTemplates()
    {
        var templates = await _db.ReportTemplates.Find(_ => true)
            .SortByDescending(t => t.IsDefault)
            .ThenByDescending(t => t.CreatedAt)
            .ToListAsync();
        return Ok(ApiResponse<object>.Ok(new { items = templates }));
    }

    /// <summary>
    /// 获取模板详情
    /// </summary>
    [HttpGet("templates/{id}")]
    public async Task<IActionResult> GetTemplate(string id)
    {
        var template = await _db.ReportTemplates.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (template == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "模板不存在"));
        return Ok(ApiResponse<object>.Ok(new { template }));
    }

    /// <summary>
    /// 创建模板
    /// </summary>
    [HttpPost("templates")]
    public async Task<IActionResult> CreateTemplate([FromBody] CreateTemplateRequest req)
    {
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTemplateManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少模板管理权限"));

        if (string.IsNullOrWhiteSpace(req.Name))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "模板名称不能为空"));

        if (req.Sections == null || req.Sections.Count == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "模板至少需要一个章节"));

        var template = new ReportTemplate
        {
            Name = req.Name.Trim(),
            Description = req.Description,
            Sections = req.Sections.Select((s, i) => new ReportTemplateSection
            {
                Title = s.Title?.Trim() ?? $"章节{i + 1}",
                Description = s.Description,
                InputType = ReportInputType.All.Contains(s.InputType ?? "") ? s.InputType! : ReportInputType.BulletList,
                IsRequired = s.IsRequired ?? true,
                SortOrder = s.SortOrder ?? i,
                DataSourceHint = s.DataSourceHint,
                MaxItems = s.MaxItems
            }).ToList(),
            TeamId = req.TeamId,
            JobTitle = req.JobTitle,
            IsDefault = req.IsDefault ?? false,
            CreatedBy = GetUserId()
        };

        await _db.ReportTemplates.InsertOneAsync(template);
        return Ok(ApiResponse<object>.Ok(new { template }));
    }

    /// <summary>
    /// 更新模板
    /// </summary>
    [HttpPut("templates/{id}")]
    public async Task<IActionResult> UpdateTemplate(string id, [FromBody] UpdateTemplateRequest req)
    {
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTemplateManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少模板管理权限"));

        var template = await _db.ReportTemplates.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (template == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "模板不存在"));

        var update = Builders<ReportTemplate>.Update
            .Set(t => t.UpdatedAt, DateTime.UtcNow);

        if (req.Name != null)
            update = update.Set(t => t.Name, req.Name.Trim());
        if (req.Description != null)
            update = update.Set(t => t.Description, req.Description);
        if (req.Sections != null)
        {
            update = update.Set(t => t.Sections, req.Sections.Select((s, i) => new ReportTemplateSection
            {
                Title = s.Title?.Trim() ?? $"章节{i + 1}",
                Description = s.Description,
                InputType = ReportInputType.All.Contains(s.InputType ?? "") ? s.InputType! : ReportInputType.BulletList,
                IsRequired = s.IsRequired ?? true,
                SortOrder = s.SortOrder ?? i,
                DataSourceHint = s.DataSourceHint,
                MaxItems = s.MaxItems
            }).ToList());
        }
        if (req.TeamId != null)
            update = update.Set(t => t.TeamId, req.TeamId);
        if (req.JobTitle != null)
            update = update.Set(t => t.JobTitle, req.JobTitle);
        if (req.IsDefault.HasValue)
            update = update.Set(t => t.IsDefault, req.IsDefault.Value);

        await _db.ReportTemplates.UpdateOneAsync(t => t.Id == id, update);

        var updated = await _db.ReportTemplates.Find(t => t.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { template = updated }));
    }

    /// <summary>
    /// 删除模板
    /// </summary>
    [HttpDelete("templates/{id}")]
    public async Task<IActionResult> DeleteTemplate(string id)
    {
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTemplateManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少模板管理权限"));

        var result = await _db.ReportTemplates.DeleteOneAsync(t => t.Id == id);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "模板不存在"));

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    #endregion

    #region Weekly Report CRUD + Status Machine

    /// <summary>
    /// 列出周报
    /// </summary>
    [HttpGet("reports")]
    public async Task<IActionResult> ListReports(
        [FromQuery] string scope = "my",
        [FromQuery] string? teamId = null,
        [FromQuery] int? weekYear = null,
        [FromQuery] int? weekNumber = null)
    {
        var userId = GetUserId();
        var now = DateTime.UtcNow;
        var currentWeek = GetWeekInfo(now);

        var wy = weekYear ?? currentWeek.weekYear;
        var wn = weekNumber ?? currentWeek.weekNumber;

        FilterDefinition<WeeklyReport> filter;

        if (scope == "team" && teamId != null)
        {
            // 需要是团队 leader/deputy 或有 view.all 权限
            var isLeader = await IsTeamLeaderOrDeputy(teamId, userId);
            if (!isLeader && !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
                return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看该团队周报"));

            filter = Builders<WeeklyReport>.Filter.Eq(r => r.TeamId, teamId)
                   & Builders<WeeklyReport>.Filter.Eq(r => r.WeekYear, wy)
                   & Builders<WeeklyReport>.Filter.Eq(r => r.WeekNumber, wn);
        }
        else
        {
            // 我的周报
            filter = Builders<WeeklyReport>.Filter.Eq(r => r.UserId, userId);
            if (weekYear.HasValue && weekNumber.HasValue)
            {
                filter &= Builders<WeeklyReport>.Filter.Eq(r => r.WeekYear, wy)
                        & Builders<WeeklyReport>.Filter.Eq(r => r.WeekNumber, wn);
            }
        }

        var reports = await _db.WeeklyReports.Find(filter)
            .SortByDescending(r => r.PeriodEnd)
            .Limit(100)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items = reports }));
    }

    /// <summary>
    /// 获取周报详情
    /// </summary>
    [HttpGet("reports/{id}")]
    public async Task<IActionResult> GetReport(string id)
    {
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        return Ok(ApiResponse<object>.Ok(new { report }));
    }

    /// <summary>
    /// 创建周报
    /// </summary>
    [HttpPost("reports")]
    public async Task<IActionResult> CreateReport([FromBody] CreateReportRequest req)
    {
        var userId = GetUserId();
        var username = GetUsername();

        if (string.IsNullOrWhiteSpace(req.TeamId))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "团队 ID 不能为空"));
        if (string.IsNullOrWhiteSpace(req.TemplateId))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "模板 ID 不能为空"));

        // 验证团队存在且用户是成员
        var team = await _db.ReportTeams.Find(t => t.Id == req.TeamId).FirstOrDefaultAsync();
        if (team == null)
            return BadRequest(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        if (!await IsTeamMember(req.TeamId, userId))
            return BadRequest(ApiResponse<object>.Fail("PERMISSION_DENIED", "你不是该团队成员"));

        // 验证模板存在
        var template = await _db.ReportTemplates.Find(t => t.Id == req.TemplateId).FirstOrDefaultAsync();
        if (template == null)
            return BadRequest(ApiResponse<object>.Fail("NOT_FOUND", "模板不存在"));

        // 计算周信息
        var now = DateTime.UtcNow;
        var (weekYear, weekNumber, periodStart, periodEnd) = GetWeekInfo(now);

        // 支持自定义周（如补填上周）
        if (req.WeekYear.HasValue && req.WeekNumber.HasValue)
        {
            weekYear = req.WeekYear.Value;
            weekNumber = req.WeekNumber.Value;
            var monday = ISOWeek.ToDateTime(weekYear, weekNumber, DayOfWeek.Monday);
            periodStart = monday;
            periodEnd = monday.AddDays(6);
        }

        // 获取用户信息
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();

        var report = new WeeklyReport
        {
            UserId = userId,
            UserName = user?.DisplayName ?? username,
            AvatarFileName = user?.AvatarFileName,
            TeamId = req.TeamId,
            TeamName = team.Name,
            TemplateId = req.TemplateId,
            WeekYear = weekYear,
            WeekNumber = weekNumber,
            PeriodStart = periodStart,
            PeriodEnd = periodEnd,
            Status = WeeklyReportStatus.Draft,
            // 深拷贝模板章节作为快照
            Sections = template.Sections.Select(s => new WeeklyReportSection
            {
                TemplateSection = new ReportTemplateSection
                {
                    Title = s.Title,
                    Description = s.Description,
                    InputType = s.InputType,
                    IsRequired = s.IsRequired,
                    SortOrder = s.SortOrder,
                    DataSourceHint = s.DataSourceHint,
                    MaxItems = s.MaxItems
                },
                Items = new List<WeeklyReportItem>()
            }).ToList()
        };

        try
        {
            await _db.WeeklyReports.InsertOneAsync(report);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            return BadRequest(ApiResponse<object>.Fail("DUPLICATE", "该周已存在周报，不能重复创建"));
        }

        return Ok(ApiResponse<object>.Ok(new { report }));
    }

    /// <summary>
    /// 更新周报内容
    /// </summary>
    [HttpPut("reports/{id}")]
    public async Task<IActionResult> UpdateReport(string id, [FromBody] UpdateReportRequest req)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        if (report.UserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只能编辑自己的周报"));

        if (report.Status != WeeklyReportStatus.Draft && report.Status != WeeklyReportStatus.Returned)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "只有草稿或已退回状态的周报可以编辑"));

        if (req.Sections == null)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "周报内容不能为空"));

        // 更新 sections 内容，保留模板快照
        var updatedSections = new List<WeeklyReportSection>();
        for (int i = 0; i < report.Sections.Count && i < req.Sections.Count; i++)
        {
            updatedSections.Add(new WeeklyReportSection
            {
                TemplateSection = report.Sections[i].TemplateSection,
                Items = req.Sections[i].Items?.Select(item => new WeeklyReportItem
                {
                    Content = item.Content ?? string.Empty,
                    Source = item.Source ?? "manual",
                    SourceRef = item.SourceRef
                }).ToList() ?? new List<WeeklyReportItem>()
            });
        }

        var update = Builders<WeeklyReport>.Update
            .Set(r => r.Sections, updatedSections)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        await _db.WeeklyReports.UpdateOneAsync(r => r.Id == id, update);

        var updated = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { report = updated }));
    }

    /// <summary>
    /// 删除周报（仅草稿）
    /// </summary>
    [HttpDelete("reports/{id}")]
    public async Task<IActionResult> DeleteReport(string id)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        if (report.UserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只能删除自己的周报"));

        if (report.Status != WeeklyReportStatus.Draft)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "只有草稿状态的周报可以删除"));

        await _db.WeeklyReports.DeleteOneAsync(r => r.Id == id);
        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 提交周报 (Draft/Returned → Submitted)
    /// </summary>
    [HttpPost("reports/{id}/submit")]
    public async Task<IActionResult> SubmitReport(string id)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        if (report.UserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只能提交自己的周报"));

        if (report.Status != WeeklyReportStatus.Draft && report.Status != WeeklyReportStatus.Returned)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "只有草稿或已退回状态的周报可以提交"));

        var update = Builders<WeeklyReport>.Update
            .Set(r => r.Status, WeeklyReportStatus.Submitted)
            .Set(r => r.SubmittedAt, DateTime.UtcNow)
            .Set(r => r.ReturnReason, null as string)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        await _db.WeeklyReports.UpdateOneAsync(r => r.Id == id, update);

        var updated = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { report = updated }));
    }

    /// <summary>
    /// 审阅周报 (Submitted → Reviewed)
    /// </summary>
    [HttpPost("reports/{id}/review")]
    public async Task<IActionResult> ReviewReport(string id)
    {
        var userId = GetUserId();
        var username = GetUsername();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        if (report.Status != WeeklyReportStatus.Submitted)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "只有已提交状态的周报可以审阅"));

        // 验证操作者是团队 leader/deputy
        if (!await IsTeamLeaderOrDeputy(report.TeamId, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只有团队负责人可以审阅"));

        var update = Builders<WeeklyReport>.Update
            .Set(r => r.Status, WeeklyReportStatus.Reviewed)
            .Set(r => r.ReviewedAt, DateTime.UtcNow)
            .Set(r => r.ReviewedBy, userId)
            .Set(r => r.ReviewedByName, username)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        await _db.WeeklyReports.UpdateOneAsync(r => r.Id == id, update);

        var updated = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { report = updated }));
    }

    /// <summary>
    /// 退回周报 (Submitted → Returned)
    /// </summary>
    [HttpPost("reports/{id}/return")]
    public async Task<IActionResult> ReturnReport(string id, [FromBody] ReturnReportRequest req)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        if (report.Status != WeeklyReportStatus.Submitted)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "只有已提交状态的周报可以退回"));

        // 验证操作者是团队 leader/deputy
        if (!await IsTeamLeaderOrDeputy(report.TeamId, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只有团队负责人可以退回"));

        var update = Builders<WeeklyReport>.Update
            .Set(r => r.Status, WeeklyReportStatus.Returned)
            .Set(r => r.ReturnReason, req.Reason)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        await _db.WeeklyReports.UpdateOneAsync(r => r.Id == id, update);

        var updated = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { report = updated }));
    }

    #endregion

    #region Team Dashboard

    /// <summary>
    /// 团队面板：成员周报状态概览
    /// </summary>
    [HttpGet("teams/{id}/dashboard")]
    public async Task<IActionResult> GetTeamDashboard(
        string id,
        [FromQuery] int? weekYear = null,
        [FromQuery] int? weekNumber = null)
    {
        var userId = GetUserId();
        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        // 验证权限
        if (!await IsTeamLeaderOrDeputy(id, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看团队面板"));

        var now = DateTime.UtcNow;
        var currentWeek = GetWeekInfo(now);
        var wy = weekYear ?? currentWeek.weekYear;
        var wn = weekNumber ?? currentWeek.weekNumber;

        // 获取团队成员
        var members = await _db.ReportTeamMembers.Find(m => m.TeamId == id).ToListAsync();

        // 获取本周所有团队成员的周报
        var reports = await _db.WeeklyReports.Find(
            r => r.TeamId == id && r.WeekYear == wy && r.WeekNumber == wn
        ).ToListAsync();

        var reportMap = reports.ToDictionary(r => r.UserId);

        var memberStatuses = members.Select(m => new
        {
            userId = m.UserId,
            userName = m.UserName,
            avatarFileName = m.AvatarFileName,
            role = m.Role,
            jobTitle = m.JobTitle,
            reportId = reportMap.TryGetValue(m.UserId, out var rpt) ? rpt.Id : null,
            reportStatus = reportMap.TryGetValue(m.UserId, out var rpt2) ? rpt2.Status : WeeklyReportStatus.NotStarted,
            submittedAt = reportMap.TryGetValue(m.UserId, out var rpt3) ? rpt3.SubmittedAt : null
        }).ToList();

        var monday = ISOWeek.ToDateTime(wy, wn, DayOfWeek.Monday);
        var sunday = monday.AddDays(6);

        return Ok(ApiResponse<object>.Ok(new
        {
            team,
            weekYear = wy,
            weekNumber = wn,
            periodStart = monday,
            periodEnd = sunday,
            members = memberStatuses,
            stats = new
            {
                total = members.Count,
                submitted = reports.Count(r => r.Status == WeeklyReportStatus.Submitted),
                reviewed = reports.Count(r => r.Status == WeeklyReportStatus.Reviewed),
                draft = reports.Count(r => r.Status == WeeklyReportStatus.Draft),
                notStarted = members.Count - reports.Count
            }
        }));
    }

    #endregion

    #region Request DTOs

    public class CreateTeamRequest
    {
        public string Name { get; set; } = string.Empty;
        public string LeaderUserId { get; set; } = string.Empty;
        public string? ParentTeamId { get; set; }
        public string? Description { get; set; }
    }

    public class UpdateTeamRequest
    {
        public string? Name { get; set; }
        public string? LeaderUserId { get; set; }
        public string? Description { get; set; }
    }

    public class AddTeamMemberRequest
    {
        public string UserId { get; set; } = string.Empty;
        public string? Role { get; set; }
        public string? JobTitle { get; set; }
    }

    public class UpdateTeamMemberRequest
    {
        public string? Role { get; set; }
        public string? JobTitle { get; set; }
    }

    public class CreateTemplateRequest
    {
        public string Name { get; set; } = string.Empty;
        public string? Description { get; set; }
        public List<TemplateSectionInput> Sections { get; set; } = new();
        public string? TeamId { get; set; }
        public string? JobTitle { get; set; }
        public bool? IsDefault { get; set; }
    }

    public class UpdateTemplateRequest
    {
        public string? Name { get; set; }
        public string? Description { get; set; }
        public List<TemplateSectionInput>? Sections { get; set; }
        public string? TeamId { get; set; }
        public string? JobTitle { get; set; }
        public bool? IsDefault { get; set; }
    }

    public class TemplateSectionInput
    {
        public string? Title { get; set; }
        public string? Description { get; set; }
        public string? InputType { get; set; }
        public bool? IsRequired { get; set; }
        public int? SortOrder { get; set; }
        public string? DataSourceHint { get; set; }
        public int? MaxItems { get; set; }
    }

    public class CreateReportRequest
    {
        public string TeamId { get; set; } = string.Empty;
        public string TemplateId { get; set; } = string.Empty;
        public int? WeekYear { get; set; }
        public int? WeekNumber { get; set; }
    }

    public class UpdateReportRequest
    {
        public List<UpdateReportSectionInput>? Sections { get; set; }
    }

    public class UpdateReportSectionInput
    {
        public List<UpdateReportItemInput>? Items { get; set; }
    }

    public class UpdateReportItemInput
    {
        public string? Content { get; set; }
        public string? Source { get; set; }
        public string? SourceRef { get; set; }
    }

    public class ReturnReportRequest
    {
        public string? Reason { get; set; }
    }

    #endregion
}
