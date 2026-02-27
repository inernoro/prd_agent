using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Driver;
using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Helpers;
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
    private readonly IConfiguration _configuration;
    private readonly MapActivityCollector _activityCollector;
    private readonly ReportGenerationService _generationService;
    private readonly ReportNotificationService _notificationService;
    private readonly TeamSummaryService _teamSummaryService;

    public ReportAgentController(
        MongoDbContext db,
        ILogger<ReportAgentController> logger,
        IConfiguration configuration,
        MapActivityCollector activityCollector,
        ReportGenerationService generationService,
        ReportNotificationService notificationService,
        TeamSummaryService teamSummaryService)
    {
        _db = db;
        _logger = logger;
        _configuration = configuration;
        _activityCollector = activityCollector;
        _generationService = generationService;
        _notificationService = notificationService;
        _teamSummaryService = teamSummaryService;
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
            .Set(r => r.ReturnedBy, null as string)
            .Set(r => r.ReturnedByName, null as string)
            .Set(r => r.ReturnedAt, null as DateTime?)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        await _db.WeeklyReports.UpdateOneAsync(r => r.Id == id, update);

        var updated = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();

        // 通知：提交 → 负责人 + 检查全员提交
        if (updated != null)
        {
            var team = await _db.ReportTeams.Find(t => t.Id == updated.TeamId).FirstOrDefaultAsync();
            if (team != null)
            {
                await _notificationService.NotifyReportSubmittedAsync(updated, team.LeaderUserId);
                await _notificationService.CheckAndNotifyAllSubmittedAsync(updated);
            }
        }

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

        // 通知：审阅 → 员工
        if (updated != null)
            await _notificationService.NotifyReportReviewedAsync(updated, username ?? "审阅人");

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

        var username = GetUsername();
        var update = Builders<WeeklyReport>.Update
            .Set(r => r.Status, WeeklyReportStatus.Returned)
            .Set(r => r.ReturnReason, req.Reason)
            .Set(r => r.ReturnedBy, userId)
            .Set(r => r.ReturnedByName, username)
            .Set(r => r.ReturnedAt, DateTime.UtcNow)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        await _db.WeeklyReports.UpdateOneAsync(r => r.Id == id, update);

        var updated = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();

        // 通知：退回 → 员工
        if (updated != null)
            await _notificationService.NotifyReportReturnedAsync(updated, username ?? "审阅人");

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

    public class SaveDailyLogRequest
    {
        public string? Date { get; set; }
        public List<DailyLogItemInput>? Items { get; set; }
    }

    public class DailyLogItemInput
    {
        public string? Content { get; set; }
        public string? Category { get; set; }
        public int? DurationMinutes { get; set; }
    }

    public class CreateDataSourceRequest
    {
        public string TeamId { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public string RepoUrl { get; set; } = string.Empty;
        public string? AccessToken { get; set; }
        public string? BranchFilter { get; set; }
        public Dictionary<string, string>? UserMapping { get; set; }
        public int PollIntervalMinutes { get; set; } = 60;
    }

    public class UpdateDataSourceRequest
    {
        public string? Name { get; set; }
        public string? RepoUrl { get; set; }
        public string? AccessToken { get; set; }
        public string? BranchFilter { get; set; }
        public Dictionary<string, string>? UserMapping { get; set; }
        public int? PollIntervalMinutes { get; set; }
        public bool? Enabled { get; set; }
    }

    #endregion

    #region Daily Logs

    /// <summary>
    /// 保存每日打点（Upsert：同一 userId+date 只保留一条）
    /// </summary>
    [HttpPost("daily-logs")]
    public async Task<IActionResult> SaveDailyLog([FromBody] SaveDailyLogRequest request)
    {
        if (request.Items == null || request.Items.Count == 0)
            return BadRequest(ApiResponse<object>.Fail("items 不能为空"));

        if (string.IsNullOrEmpty(request.Date))
            return BadRequest(ApiResponse<object>.Fail("date 不能为空"));

        if (!DateTime.TryParse(request.Date, out var parsedDate))
            return BadRequest(ApiResponse<object>.Fail("date 格式无效"));

        var date = parsedDate.Date; // normalize to date only
        var userId = GetUserId();

        var items = request.Items.Select(i => new DailyLogItem
        {
            Content = i.Content ?? string.Empty,
            Category = DailyLogCategory.All.Contains(i.Category ?? "") ? i.Category! : DailyLogCategory.Other,
            DurationMinutes = i.DurationMinutes
        }).Where(i => !string.IsNullOrWhiteSpace(i.Content)).ToList();

        if (items.Count == 0)
            return BadRequest(ApiResponse<object>.Fail("至少需要一条有效工作项"));

        var filter = Builders<ReportDailyLog>.Filter.Eq(x => x.UserId, userId)
                   & Builders<ReportDailyLog>.Filter.Eq(x => x.Date, date);

        var existing = await _db.ReportDailyLogs.Find(filter).FirstOrDefaultAsync();

        if (existing != null)
        {
            var update = Builders<ReportDailyLog>.Update
                .Set(x => x.Items, items)
                .Set(x => x.UpdatedAt, DateTime.UtcNow);
            await _db.ReportDailyLogs.UpdateOneAsync(filter, update);
            existing.Items = items;
            existing.UpdatedAt = DateTime.UtcNow;
            return Ok(ApiResponse<object>.Ok(existing));
        }
        else
        {
            var log = new ReportDailyLog
            {
                UserId = userId,
                UserName = GetUsername(),
                Date = date,
                Items = items
            };
            await _db.ReportDailyLogs.InsertOneAsync(log);
            return Ok(ApiResponse<object>.Ok(log));
        }
    }

    /// <summary>
    /// 查询每日打点列表
    /// </summary>
    [HttpGet("daily-logs")]
    public async Task<IActionResult> ListDailyLogs([FromQuery] string? startDate, [FromQuery] string? endDate)
    {
        var userId = GetUserId();
        var filter = Builders<ReportDailyLog>.Filter.Eq(x => x.UserId, userId);

        if (DateTime.TryParse(startDate, out var start))
            filter &= Builders<ReportDailyLog>.Filter.Gte(x => x.Date, start.Date);

        if (DateTime.TryParse(endDate, out var end))
            filter &= Builders<ReportDailyLog>.Filter.Lte(x => x.Date, end.Date);

        var logs = await _db.ReportDailyLogs.Find(filter)
            .SortByDescending(x => x.Date).Limit(100).ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items = logs }));
    }

    /// <summary>
    /// 获取指定日期的打点
    /// </summary>
    [HttpGet("daily-logs/{date}")]
    public async Task<IActionResult> GetDailyLog(string date)
    {
        if (!DateTime.TryParse(date, out var parsedDate))
            return BadRequest(ApiResponse<object>.Fail("日期格式无效"));

        var userId = GetUserId();
        var log = await _db.ReportDailyLogs.Find(
            x => x.UserId == userId && x.Date == parsedDate.Date
        ).FirstOrDefaultAsync();

        if (log == null)
            return Ok(ApiResponse<object>.Ok(new ReportDailyLog
            {
                UserId = userId,
                Date = parsedDate.Date,
                Items = new()
            }));

        return Ok(ApiResponse<object>.Ok(log));
    }

    /// <summary>
    /// 删除指定日期的打点
    /// </summary>
    [HttpDelete("daily-logs/{date}")]
    public async Task<IActionResult> DeleteDailyLog(string date)
    {
        if (!DateTime.TryParse(date, out var parsedDate))
            return BadRequest(ApiResponse<object>.Fail("日期格式无效"));

        var userId = GetUserId();
        var result = await _db.ReportDailyLogs.DeleteOneAsync(
            x => x.UserId == userId && x.Date == parsedDate.Date);

        return Ok(ApiResponse<object>.Ok(new { deleted = result.DeletedCount > 0 }));
    }

    #endregion

    #region Data Sources

    /// <summary>
    /// 列出数据源（按团队过滤）
    /// </summary>
    [HttpGet("data-sources")]
    public async Task<IActionResult> ListDataSources([FromQuery] string? teamId)
    {
        var userId = GetUserId();

        FilterDefinition<ReportDataSource> filter;
        if (!string.IsNullOrEmpty(teamId))
        {
            // 验证是否为团队成员
            if (!HasPermission(AdminPermissionCatalog.ReportAgentViewAll)
                && !await IsTeamMember(teamId, userId))
            {
                return Forbid();
            }
            filter = Builders<ReportDataSource>.Filter.Eq(x => x.TeamId, teamId);
        }
        else if (HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
        {
            filter = Builders<ReportDataSource>.Filter.Empty;
        }
        else
        {
            // 只返回用户所在团队的数据源
            var memberships = await _db.ReportTeamMembers.Find(m => m.UserId == userId).ToListAsync();
            var teamIds = memberships.Select(m => m.TeamId).Distinct().ToList();
            filter = Builders<ReportDataSource>.Filter.In(x => x.TeamId, teamIds);
        }

        var sources = await _db.ReportDataSources.Find(filter)
            .SortByDescending(x => x.CreatedAt).ToListAsync();

        // 脱敏 token
        var result = sources.Select(s => new
        {
            s.Id, s.TeamId, s.SourceType, s.Name, s.RepoUrl,
            AccessTokenMasked = ApiKeyCrypto.Mask(
                string.IsNullOrEmpty(s.EncryptedAccessToken) ? null
                : ApiKeyCrypto.Decrypt(s.EncryptedAccessToken, GetCryptoKey())),
            s.BranchFilter, s.UserMapping, s.PollIntervalMinutes,
            s.Enabled, s.LastSyncAt, s.LastSyncError, s.CreatedBy, s.CreatedAt, s.UpdatedAt
        });

        return Ok(ApiResponse<object>.Ok(new { items = result }));
    }

    /// <summary>
    /// 创建数据源
    /// </summary>
    [HttpPost("data-sources")]
    public async Task<IActionResult> CreateDataSource([FromBody] CreateDataSourceRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
            return BadRequest(ApiResponse<object>.Fail("名称不能为空"));
        if (string.IsNullOrWhiteSpace(request.RepoUrl))
            return BadRequest(ApiResponse<object>.Fail("仓库地址不能为空"));
        if (string.IsNullOrWhiteSpace(request.TeamId))
            return BadRequest(ApiResponse<object>.Fail("团队 ID 不能为空"));

        var userId = GetUserId();
        if (!HasPermission(AdminPermissionCatalog.ReportAgentDataSourceManage)
            && !HasPermission(AdminPermissionCatalog.ReportAgentTeamManage)
            && !await IsTeamLeaderOrDeputy(request.TeamId, userId))
        {
            return Forbid();
        }

        var source = new ReportDataSource
        {
            TeamId = request.TeamId,
            Name = request.Name,
            RepoUrl = request.RepoUrl,
            BranchFilter = request.BranchFilter,
            UserMapping = request.UserMapping ?? new(),
            PollIntervalMinutes = Math.Max(10, request.PollIntervalMinutes),
            CreatedBy = userId
        };

        if (!string.IsNullOrWhiteSpace(request.AccessToken))
        {
            source.EncryptedAccessToken = ApiKeyCrypto.Encrypt(request.AccessToken, GetCryptoKey());
        }

        await _db.ReportDataSources.InsertOneAsync(source);
        return Ok(ApiResponse<object>.Ok(new { id = source.Id }));
    }

    /// <summary>
    /// 更新数据源
    /// </summary>
    [HttpPut("data-sources/{id}")]
    public async Task<IActionResult> UpdateDataSource(string id, [FromBody] UpdateDataSourceRequest request)
    {
        var source = await _db.ReportDataSources.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (source == null) return NotFound(ApiResponse<object>.Fail("数据源不存在"));

        var userId = GetUserId();
        if (!HasPermission(AdminPermissionCatalog.ReportAgentDataSourceManage)
            && !await IsTeamLeaderOrDeputy(source.TeamId, userId))
        {
            return Forbid();
        }

        var updates = new List<UpdateDefinition<ReportDataSource>>();
        if (request.Name != null) updates.Add(Builders<ReportDataSource>.Update.Set(x => x.Name, request.Name));
        if (request.RepoUrl != null) updates.Add(Builders<ReportDataSource>.Update.Set(x => x.RepoUrl, request.RepoUrl));
        if (request.BranchFilter != null) updates.Add(Builders<ReportDataSource>.Update.Set(x => x.BranchFilter, request.BranchFilter));
        if (request.UserMapping != null) updates.Add(Builders<ReportDataSource>.Update.Set(x => x.UserMapping, request.UserMapping));
        if (request.PollIntervalMinutes.HasValue) updates.Add(Builders<ReportDataSource>.Update.Set(x => x.PollIntervalMinutes, Math.Max(10, request.PollIntervalMinutes.Value)));
        if (request.Enabled.HasValue) updates.Add(Builders<ReportDataSource>.Update.Set(x => x.Enabled, request.Enabled.Value));

        if (!string.IsNullOrWhiteSpace(request.AccessToken))
        {
            updates.Add(Builders<ReportDataSource>.Update.Set(x => x.EncryptedAccessToken,
                ApiKeyCrypto.Encrypt(request.AccessToken, GetCryptoKey())));
        }

        updates.Add(Builders<ReportDataSource>.Update.Set(x => x.UpdatedAt, DateTime.UtcNow));

        await _db.ReportDataSources.UpdateOneAsync(
            x => x.Id == id,
            Builders<ReportDataSource>.Update.Combine(updates));

        return Ok(ApiResponse<object>.Ok());
    }

    /// <summary>
    /// 删除数据源
    /// </summary>
    [HttpDelete("data-sources/{id}")]
    public async Task<IActionResult> DeleteDataSource(string id)
    {
        var source = await _db.ReportDataSources.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (source == null) return NotFound(ApiResponse<object>.Fail("数据源不存在"));

        var userId = GetUserId();
        if (!HasPermission(AdminPermissionCatalog.ReportAgentDataSourceManage)
            && !await IsTeamLeaderOrDeputy(source.TeamId, userId))
        {
            return Forbid();
        }

        // 删除关联的提交记录
        await _db.ReportCommits.DeleteManyAsync(x => x.DataSourceId == id);
        await _db.ReportDataSources.DeleteOneAsync(x => x.Id == id);
        return Ok(ApiResponse<object>.Ok());
    }

    /// <summary>
    /// 测试数据源连接
    /// </summary>
    [HttpPost("data-sources/{id}/test")]
    public async Task<IActionResult> TestDataSource(string id)
    {
        var source = await _db.ReportDataSources.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (source == null) return NotFound(ApiResponse<object>.Fail("数据源不存在"));

        try
        {
            var connector = CreateConnector(source);
            var reachable = await connector.TestConnectionAsync(CancellationToken.None);
            return Ok(ApiResponse<object>.Ok(new { success = reachable }));
        }
        catch (Exception ex)
        {
            return Ok(ApiResponse<object>.Ok(new { success = false, error = ex.Message }));
        }
    }

    /// <summary>
    /// 手动触发数据源同步
    /// </summary>
    [HttpPost("data-sources/{id}/sync")]
    public async Task<IActionResult> SyncDataSource(string id)
    {
        var source = await _db.ReportDataSources.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (source == null) return NotFound(ApiResponse<object>.Fail("数据源不存在"));

        var userId = GetUserId();
        if (!HasPermission(AdminPermissionCatalog.ReportAgentDataSourceManage)
            && !await IsTeamLeaderOrDeputy(source.TeamId, userId))
        {
            return Forbid();
        }

        try
        {
            var connector = CreateConnector(source);
            var synced = await connector.SyncAsync(CancellationToken.None);

            // 更新同步状态
            await _db.ReportDataSources.UpdateOneAsync(
                x => x.Id == id,
                Builders<ReportDataSource>.Update
                    .Set(x => x.LastSyncAt, DateTime.UtcNow)
                    .Set(x => x.LastSyncError, null)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow));

            return Ok(ApiResponse<object>.Ok(new { syncedCommits = synced }));
        }
        catch (Exception ex)
        {
            await _db.ReportDataSources.UpdateOneAsync(
                x => x.Id == id,
                Builders<ReportDataSource>.Update
                    .Set(x => x.LastSyncError, ex.Message)
                    .Set(x => x.UpdatedAt, DateTime.UtcNow));

            return Ok(ApiResponse<object>.Ok(new { syncedCommits = 0, error = ex.Message }));
        }
    }

    /// <summary>
    /// 查看已同步的提交列表
    /// </summary>
    [HttpGet("data-sources/{id}/commits")]
    public async Task<IActionResult> ListDataSourceCommits(
        string id, [FromQuery] string? since, [FromQuery] string? until, [FromQuery] int limit = 50)
    {
        var source = await _db.ReportDataSources.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (source == null) return NotFound(ApiResponse<object>.Fail("数据源不存在"));

        var filter = Builders<ReportCommit>.Filter.Eq(x => x.DataSourceId, id);
        if (DateTime.TryParse(since, out var sinceDate))
            filter &= Builders<ReportCommit>.Filter.Gte(x => x.CommittedAt, sinceDate);
        if (DateTime.TryParse(until, out var untilDate))
            filter &= Builders<ReportCommit>.Filter.Lte(x => x.CommittedAt, untilDate);

        var commits = await _db.ReportCommits.Find(filter)
            .SortByDescending(x => x.CommittedAt)
            .Limit(Math.Min(limit, 200))
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items = commits }));
    }

    private ICodeSourceConnector CreateConnector(ReportDataSource source)
    {
        var token = string.IsNullOrEmpty(source.EncryptedAccessToken)
            ? null
            : ApiKeyCrypto.Decrypt(source.EncryptedAccessToken, GetCryptoKey());

        return source.SourceType switch
        {
            DataSourceType.Git => new GitHubConnector(source, token, _db, _logger),
            _ => throw new NotSupportedException($"数据源类型 {source.SourceType} 暂不支持")
        };
    }

    private string GetCryptoKey()
        => _configuration["Security:ApiKeyCryptoSecret"] ?? "default-report-agent-crypto-key-32";

    #endregion

    #region AI Generation

    /// <summary>
    /// 手动触发 AI 生成周报内容
    /// </summary>
    [HttpPost("reports/{id}/generate")]
    public async Task<IActionResult> GenerateReport(string id)
    {
        var report = await _db.WeeklyReports.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (report == null) return NotFound(ApiResponse<object>.Fail("周报不存在"));

        var userId = GetUserId();
        if (report.UserId != userId && !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return Forbid();

        if (report.Status != WeeklyReportStatus.Draft && report.Status != WeeklyReportStatus.Returned)
            return BadRequest(ApiResponse<object>.Fail("只有草稿或退回状态的周报才能生成"));

        try
        {
            var updatedReport = await _generationService.GenerateAsync(
                report.UserId, report.TeamId, report.TemplateId,
                report.WeekYear, report.WeekNumber, CancellationToken.None);

            return Ok(ApiResponse<object>.Ok(updatedReport));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "AI 生成周报失败: reportId={ReportId}", id);
            return StatusCode(500, ApiResponse<object>.Fail($"AI 生成失败: {ex.Message}"));
        }
    }

    /// <summary>
    /// 预览采集数据（不保存）
    /// </summary>
    [HttpGet("activity")]
    public async Task<IActionResult> GetCollectedActivity(
        [FromQuery] int? weekYear, [FromQuery] int? weekNumber)
    {
        var userId = GetUserId();
        var now = DateTime.UtcNow;
        var wy = weekYear ?? ISOWeek.GetYear(now);
        var wn = weekNumber ?? ISOWeek.GetWeekOfYear(now);

        var monday = ISOWeek.ToDateTime(wy, wn, DayOfWeek.Monday);
        var sunday = monday.AddDays(6).AddHours(23).AddMinutes(59).AddSeconds(59);

        var activity = await _activityCollector.CollectAsync(userId, monday, sunday, CancellationToken.None);

        return Ok(ApiResponse<object>.Ok(activity));
    }

    #endregion

    #region Comments

    /// <summary>
    /// 获取周报评论列表
    /// </summary>
    [HttpGet("reports/{id}/comments")]
    public async Task<IActionResult> ListComments(string id, [FromQuery] int? sectionIndex)
    {
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        // 验证访问权限：本人 + 团队成员 + 负责人 + 管理员
        var userId = GetUserId();
        if (report.UserId != userId &&
            !await IsTeamMember(report.TeamId, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看该周报的评论"));

        var filter = Builders<ReportComment>.Filter.Eq(c => c.ReportId, id);
        if (sectionIndex.HasValue)
            filter &= Builders<ReportComment>.Filter.Eq(c => c.SectionIndex, sectionIndex.Value);

        var comments = await _db.ReportComments
            .Find(filter)
            .SortBy(c => c.CreatedAt)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items = comments }));
    }

    /// <summary>
    /// 创建评论（支持段落级 + 回复）
    /// </summary>
    [HttpPost("reports/{id}/comments")]
    public async Task<IActionResult> CreateComment(string id, [FromBody] CreateCommentRequest req)
    {
        var userId = GetUserId();
        var username = GetUsername();

        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        // 验证访问权限
        if (report.UserId != userId &&
            !await IsTeamMember(report.TeamId, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权评论该周报"));

        if (string.IsNullOrWhiteSpace(req.Content))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "评论内容不能为空"));

        // 获取段落标题快照
        var sectionTitle = req.SectionIndex >= 0 && req.SectionIndex < report.Sections.Count
            ? report.Sections[req.SectionIndex].TemplateSection?.Title ?? ""
            : "";

        // 如果是回复，验证父评论存在
        if (!string.IsNullOrEmpty(req.ParentCommentId))
        {
            var parent = await _db.ReportComments.Find(c => c.Id == req.ParentCommentId && c.ReportId == id).AnyAsync();
            if (!parent)
                return BadRequest(ApiResponse<object>.Fail("NOT_FOUND", "父评论不存在"));
        }

        var comment = new ReportComment
        {
            ReportId = id,
            SectionIndex = req.SectionIndex,
            SectionTitleSnapshot = sectionTitle,
            ParentCommentId = string.IsNullOrEmpty(req.ParentCommentId) ? null : req.ParentCommentId,
            AuthorUserId = userId,
            AuthorDisplayName = username ?? "匿名",
            Content = req.Content.Trim()
        };

        await _db.ReportComments.InsertOneAsync(comment);
        return Ok(ApiResponse<object>.Ok(new { comment }));
    }

    /// <summary>
    /// 删除评论（仅作者或管理员）
    /// </summary>
    [HttpDelete("reports/{reportId}/comments/{commentId}")]
    public async Task<IActionResult> DeleteComment(string reportId, string commentId)
    {
        var userId = GetUserId();
        var comment = await _db.ReportComments.Find(c => c.Id == commentId && c.ReportId == reportId).FirstOrDefaultAsync();
        if (comment == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "评论不存在"));

        if (comment.AuthorUserId != userId && !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只能删除自己的评论"));

        // 删除评论及其所有回复
        await _db.ReportComments.DeleteManyAsync(
            c => c.Id == commentId || c.ParentCommentId == commentId);

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    #endregion

    #region Plan Comparison

    /// <summary>
    /// 计划比对：上周计划 vs 本周实际
    /// </summary>
    [HttpGet("reports/{id}/plan-comparison")]
    public async Task<IActionResult> GetPlanComparison(string id)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        // 验证访问权限
        if (report.UserId != userId &&
            !await IsTeamMember(report.TeamId, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看"));

        // 计算上周
        var prevWeekNumber = report.WeekNumber - 1;
        var prevWeekYear = report.WeekYear;
        if (prevWeekNumber < 1)
        {
            prevWeekYear--;
            prevWeekNumber = ISOWeek.GetWeeksInYear(prevWeekYear);
        }

        var lastWeekReport = await _db.WeeklyReports.Find(
            r => r.UserId == report.UserId
                 && r.TeamId == report.TeamId
                 && r.WeekYear == prevWeekYear
                 && r.WeekNumber == prevWeekNumber
        ).FirstOrDefaultAsync();

        // 从上周周报提取"下周计划"段落
        var lastWeekPlans = new List<string>();
        if (lastWeekReport != null)
        {
            var planKeywords = new[] { "计划", "plan", "下周", "next" };
            foreach (var section in lastWeekReport.Sections)
            {
                var title = section.TemplateSection?.Title?.ToLowerInvariant() ?? "";
                if (planKeywords.Any(kw => title.Contains(kw, StringComparison.OrdinalIgnoreCase)))
                {
                    lastWeekPlans.AddRange(section.Items.Select(i => i.Content));
                }
            }
        }

        // 从本周周报提取"完成"段落
        var thisWeekActuals = new List<string>();
        var completedKeywords = new[] { "完成", "成果", "本周", "done", "completed", "this week" };
        foreach (var section in report.Sections)
        {
            var title = section.TemplateSection?.Title?.ToLowerInvariant() ?? "";
            if (completedKeywords.Any(kw => title.Contains(kw, StringComparison.OrdinalIgnoreCase)))
            {
                thisWeekActuals.AddRange(section.Items.Select(i => i.Content));
            }
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            lastWeekPlans,
            thisWeekActuals,
            lastWeekLabel = lastWeekReport != null
                ? $"{prevWeekYear} 年第 {prevWeekNumber} 周"
                : null,
            thisWeekLabel = $"{report.WeekYear} 年第 {report.WeekNumber} 周",
            hasLastWeek = lastWeekReport != null
        }));
    }

    #endregion

    #region Team Summary

    /// <summary>
    /// 生成团队周报汇总（AI 聚合）
    /// </summary>
    [HttpPost("teams/{id}/summary/generate")]
    public async Task<IActionResult> GenerateTeamSummary(string id,
        [FromQuery] int? weekYear, [FromQuery] int? weekNumber)
    {
        var userId = GetUserId();
        var username = GetUsername();

        if (!await IsTeamLeaderOrDeputy(id, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只有团队负责人可以生成团队汇总"));

        var now = DateTime.UtcNow;
        var wy = weekYear ?? ISOWeek.GetYear(now);
        var wn = weekNumber ?? ISOWeek.GetWeekOfYear(now);

        try
        {
            var summary = await _teamSummaryService.GenerateAsync(id, wy, wn, userId, username);
            return Ok(ApiResponse<object>.Ok(new { summary }));
        }
        catch (InvalidOperationException ex)
        {
            return BadRequest(ApiResponse<object>.Fail(ex.Message));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "团队汇总生成失败: teamId={TeamId}", id);
            return StatusCode(500, ApiResponse<object>.Fail($"AI 汇总失败: {ex.Message}"));
        }
    }

    /// <summary>
    /// 获取团队周报汇总
    /// </summary>
    [HttpGet("teams/{id}/summary")]
    public async Task<IActionResult> GetTeamSummary(string id,
        [FromQuery] int? weekYear, [FromQuery] int? weekNumber)
    {
        var userId = GetUserId();
        if (!await IsTeamLeaderOrDeputy(id, userId) &&
            !await IsTeamMember(id, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看团队汇总"));

        var now = DateTime.UtcNow;
        var wy = weekYear ?? ISOWeek.GetYear(now);
        var wn = weekNumber ?? ISOWeek.GetWeekOfYear(now);

        var summary = await _db.ReportTeamSummaries.Find(
            s => s.TeamId == id && s.WeekYear == wy && s.WeekNumber == wn
        ).FirstOrDefaultAsync();

        return Ok(ApiResponse<object>.Ok(new { summary }));
    }

    #endregion
}

public class CreateCommentRequest
{
    public int SectionIndex { get; set; }
    public string Content { get; set; } = string.Empty;
    public string? ParentCommentId { get; set; }
}
