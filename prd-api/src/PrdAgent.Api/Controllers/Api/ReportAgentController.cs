using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using System.Globalization;
using System.Security.Claims;
using System.Text.RegularExpressions;

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
    private const long MaxRichTextImageBytes = 5 * 1024 * 1024;
    private const int MaxDailyLogCustomTagCount = 20;
    private const int MaxDailyLogCustomTagLength = 16;
    private const string DailyLogTodoPlanWeekInvalidMessage = "Todo 标签必须提供有效的 ISO 周（planWeekYear + planWeekNumber）";
    private const string DailyLogTodoExclusiveInvalidMessage = "Todo 标签不能与其它系统标签同时存在";
    private const int MaxWeeklyReportPromptLength = ReportAgentPromptDefaults.MaxCustomPromptLength;
    private static readonly string[] EditableReportStatuses =
    {
        WeeklyReportStatus.Draft,
        WeeklyReportStatus.Submitted,
        WeeklyReportStatus.Returned,
        WeeklyReportStatus.Overdue
    };
    private static readonly HashSet<string> AllowedRichTextImageMimeTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/webp",
        "image/gif"
    };
    private readonly MongoDbContext _db;
    private readonly IAssetStorage _assetStorage;
    private readonly ILogger<ReportAgentController> _logger;
    private readonly IConfiguration _configuration;
    private readonly MapActivityCollector _activityCollector;
    private readonly ReportGenerationService _generationService;
    private readonly ReportNotificationService _notificationService;
    private readonly TeamSummaryService _teamSummaryService;

    public ReportAgentController(
        MongoDbContext db,
        IAssetStorage assetStorage,
        ILogger<ReportAgentController> logger,
        IConfiguration configuration,
        MapActivityCollector activityCollector,
        ReportGenerationService generationService,
        ReportNotificationService notificationService,
        TeamSummaryService teamSummaryService)
    {
        _db = db;
        _assetStorage = assetStorage;
        _logger = logger;
        _configuration = configuration;
        _activityCollector = activityCollector;
        _generationService = generationService;
        _notificationService = notificationService;
        _teamSummaryService = teamSummaryService;
    }

    #region Helpers

    private string GetUserId() => this.GetRequiredUserId();

    private string? GetUsername()
        => User.FindFirst("name")?.Value
           ?? User.FindFirst(ClaimTypes.Name)?.Value;

    private static string ResolveUserDisplayName(User? user, string? claimName, string userId)
    {
        var displayName = user?.DisplayName?.Trim();
        if (!string.IsNullOrWhiteSpace(displayName))
            return displayName;

        var username = user?.Username?.Trim();
        if (!string.IsNullOrWhiteSpace(username))
            return username;

        var nameFromClaim = claimName?.Trim();
        if (!string.IsNullOrWhiteSpace(nameFromClaim))
            return nameFromClaim;

        // 评论必须实名展示：兜底至少展示 userId，不再显示“匿名”
        return userId;
    }

    private async Task<bool> CanAccessReportAsync(WeeklyReport report, string userId)
    {
        if (report.UserId == userId) return true;
        if (await IsTeamMember(report.TeamId, userId)) return true;
        return HasPermission(AdminPermissionCatalog.ReportAgentViewAll);
    }

    private async Task<object> BuildReportLikeSummaryPayloadAsync(string reportId, string currentUserId)
    {
        var likes = await _db.ReportLikes
            .Find(x => x.ReportId == reportId)
            .SortByDescending(x => x.CreatedAt)
            .ToListAsync();

        var authorIds = likes
            .Select(x => x.UserId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct()
            .ToList();

        Dictionary<string, User> userMap = new(StringComparer.Ordinal);
        if (authorIds.Count > 0)
        {
            var users = await _db.Users.Find(u => authorIds.Contains(u.UserId)).ToListAsync();
            userMap = users.ToDictionary(u => u.UserId, u => u);
        }

        foreach (var like in likes)
        {
            userMap.TryGetValue(like.UserId, out var user);
            if (string.IsNullOrWhiteSpace(like.UserName))
            {
                like.UserName = ResolveUserDisplayName(user, null, like.UserId);
            }
            if (string.IsNullOrWhiteSpace(like.AvatarFileName) && !string.IsNullOrWhiteSpace(user?.AvatarFileName))
            {
                like.AvatarFileName = user!.AvatarFileName;
            }
        }

        return new
        {
            likedByMe = likes.Any(x => x.UserId == currentUserId),
            count = likes.Count,
            users = likes.Select(x => new
            {
                userId = x.UserId,
                userName = !string.IsNullOrWhiteSpace(x.UserName) ? x.UserName : x.UserId,
                avatarFileName = x.AvatarFileName,
                likedAt = x.CreatedAt
            }).ToList()
        };
    }

    private async Task<object> BuildReportViewSummaryPayloadAsync(string reportId, string reportOwnerUserId)
    {
        var events = await _db.ReportViewEvents
            .Find(x => x.ReportId == reportId)
            .SortByDescending(x => x.ViewedAt)
            .ToListAsync();

        var viewerIds = events
            .Select(x => x.UserId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct()
            .ToList();

        Dictionary<string, User> userMap = new(StringComparer.Ordinal);
        if (viewerIds.Count > 0)
        {
            var users = await _db.Users.Find(u => viewerIds.Contains(u.UserId)).ToListAsync();
            userMap = users.ToDictionary(u => u.UserId, u => u);
        }

        foreach (var viewEvent in events)
        {
            userMap.TryGetValue(viewEvent.UserId, out var user);
            if (string.IsNullOrWhiteSpace(viewEvent.UserName))
            {
                viewEvent.UserName = ResolveUserDisplayName(user, null, viewEvent.UserId);
            }
            if (string.IsNullOrWhiteSpace(viewEvent.AvatarFileName) && !string.IsNullOrWhiteSpace(user?.AvatarFileName))
            {
                viewEvent.AvatarFileName = user!.AvatarFileName;
            }
        }

        var groupedByUser = events
            .GroupBy(x => x.UserId)
            .Select(g =>
            {
                var latest = g.OrderByDescending(x => x.ViewedAt).First();
                var userId = latest.UserId;
                var displayName = !string.IsNullOrWhiteSpace(latest.UserName) ? latest.UserName : userId;
                var isFrequent = g.Count() > 5;
                var isOwner = !string.IsNullOrWhiteSpace(reportOwnerUserId) && userId == reportOwnerUserId;
                return new
                {
                    userId,
                    userName = displayName,
                    avatarFileName = latest.AvatarFileName,
                    viewCount = g.Count(),
                    lastViewedAt = latest.ViewedAt,
                    isFrequent,
                    isOwner
                };
            })
            .OrderBy(x => x.isOwner)
            .ThenByDescending(x => x.lastViewedAt)
            .ToList();

        return new
        {
            count = groupedByUser.Count,
            totalViewCount = events.Count,
            users = groupedByUser
        };
    }

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

    private static string? GetTeamRelationType(string? myRole)
    {
        if (myRole == ReportTeamRole.Leader || myRole == ReportTeamRole.Deputy)
            return "managed";
        if (!string.IsNullOrEmpty(myRole))
            return "joined";
        return null;
    }

    private static object MapTeamListItem(
        ReportTeam team,
        string? myRole,
        bool canManageMembers,
        bool canLeave)
    {
        return new
        {
            id = team.Id,
            name = team.Name,
            parentTeamId = team.ParentTeamId,
            leaderUserId = team.LeaderUserId,
            leaderName = team.LeaderName,
            description = team.Description,
            dataCollectionWorkflowId = team.DataCollectionWorkflowId,
            workflowTemplateKey = team.WorkflowTemplateKey,
            reportVisibility = team.ReportVisibility,
            autoSubmitSchedule = team.AutoSubmitSchedule,
            customDailyLogTags = team.CustomDailyLogTags,
            createdAt = team.CreatedAt,
            updatedAt = team.UpdatedAt,
            myRole,
            relationType = GetTeamRelationType(myRole),
            canManageMembers,
            canLeave
        };
    }

    private static TeamSummary BuildSelfSummary(ReportTeam team, WeeklyReport report, string userId, string? username)
    {
        var sections = report.Sections.Select(s => new TeamSummarySection
        {
            Title = s.TemplateSection?.Title ?? "未命名板块",
            Items = s.Items
                .Select(i => i.Content?.Trim())
                .Where(c => !string.IsNullOrWhiteSpace(c))
                .Cast<string>()
                .ToList()
        }).ToList();

        return new TeamSummary
        {
            Id = $"self_{report.Id}",
            TeamId = team.Id,
            TeamName = team.Name ?? "",
            WeekYear = report.WeekYear,
            WeekNumber = report.WeekNumber,
            PeriodStart = report.PeriodStart,
            PeriodEnd = report.PeriodEnd,
            Sections = sections,
            SourceReportIds = new List<string> { report.Id },
            MemberCount = 1,
            SubmittedCount = report.SubmittedAt.HasValue ? 1 : 0,
            GeneratedBy = userId,
            GeneratedByName = username ?? report.UserName,
            GeneratedAt = report.UpdatedAt,
            UpdatedAt = report.UpdatedAt
        };
    }

    private static (int weekYear, int weekNumber, DateTime periodStart, DateTime periodEnd) GetWeekInfo(DateTime date)
    {
        var weekYear = ISOWeek.GetYear(date);
        var weekNumber = ISOWeek.GetWeekOfYear(date);
        var monday = ISOWeek.ToDateTime(weekYear, weekNumber, DayOfWeek.Monday);
        var sunday = monday.AddDays(6);
        return (weekYear, weekNumber, monday, sunday);
    }

    private static ReportTemplateSection MapSection(TemplateSectionInput s, int i) => new()
    {
        Title = s.Title?.Trim() ?? $"章节{i + 1}",
        Description = s.Description,
        InputType = ReportInputType.All.Contains(s.InputType ?? "") ? s.InputType! : ReportInputType.BulletList,
        IsRequired = s.IsRequired ?? true,
        SortOrder = s.SortOrder ?? i,
        DataSourceHint = s.DataSourceHint,
        MaxItems = s.MaxItems,
        SectionType = s.SectionType != null && ReportSectionType.All.Contains(s.SectionType) ? s.SectionType : null,
        DataSources = s.DataSources,
    };

    #endregion

    #region Team Management

    /// <summary>
    /// 列出用户相关团队
    /// </summary>
    [HttpGet("teams")]
    public async Task<IActionResult> ListTeams()
    {
        var userId = GetUserId();
        var memberships = await _db.ReportTeamMembers.Find(m => m.UserId == userId).ToListAsync();
        var membershipRoleByTeamId = memberships
            .GroupBy(m => m.TeamId)
            .ToDictionary(g => g.Key, g => g.OrderByDescending(m => m.JoinedAt).First().Role);

        List<ReportTeam> teams;
        if (HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
        {
            teams = await _db.ReportTeams.Find(_ => true)
                .SortByDescending(t => t.CreatedAt).ToListAsync();
        }
        else
        {
            var teamIds = memberships.Select(m => m.TeamId).Distinct().ToList();
            var leaderTeams = await _db.ReportTeams.Find(t => t.LeaderUserId == userId).ToListAsync();
            var leaderTeamIds = leaderTeams.Select(t => t.Id).ToList();
            teamIds = teamIds.Union(leaderTeamIds).Distinct().ToList();

            teams = await _db.ReportTeams.Find(t => teamIds.Contains(t.Id))
                .SortByDescending(t => t.CreatedAt).ToListAsync();
        }

        var hasTeamManagePermission = HasPermission(AdminPermissionCatalog.ReportAgentTeamManage);
        var items = teams.Select(team =>
        {
            membershipRoleByTeamId.TryGetValue(team.Id, out var membershipRole);
            var myRole = team.LeaderUserId == userId ? ReportTeamRole.Leader : membershipRole;
            var isManagedTeam = myRole == ReportTeamRole.Leader || myRole == ReportTeamRole.Deputy;
            var canManageMembers = hasTeamManagePermission || isManagedTeam;
            var canLeave = !string.IsNullOrEmpty(myRole) && myRole != ReportTeamRole.Leader;
            return MapTeamListItem(team, myRole, canManageMembers, canLeave);
        }).ToList();

        return Ok(ApiResponse<object>.Ok(new { items }));
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
            Description = req.Description,
            ReportVisibility = ReportVisibilityMode.All.Contains(req.ReportVisibility ?? "")
                ? req.ReportVisibility! : ReportVisibilityMode.AllMembers,
            AutoSubmitSchedule = req.AutoSubmitSchedule,
            CustomDailyLogTags = req.CustomDailyLogTags ?? new List<string>()
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
        if (req.ReportVisibility != null && ReportVisibilityMode.All.Contains(req.ReportVisibility))
            update = update.Set(t => t.ReportVisibility, req.ReportVisibility);
        if (req.AutoSubmitSchedule != null)
            update = update.Set(t => t.AutoSubmitSchedule, req.AutoSubmitSchedule == "" ? null : req.AutoSubmitSchedule);
        if (req.CustomDailyLogTags != null)
            update = update.Set(t => t.CustomDailyLogTags, req.CustomDailyLogTags);

        await _db.ReportTeams.UpdateOneAsync(t => t.Id == id, update);

        var updated = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { team = updated }));
    }

    #region Team AI Summary Prompt

    /// <summary>
    /// 获取团队周报 AI 分析 Prompt 设置
    /// </summary>
    [HttpGet("teams/{id}/ai-summary-prompt")]
    public async Task<IActionResult> GetTeamAiSummaryPrompt(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync(ct);
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        var hasTeamManagePermission = HasPermission(AdminPermissionCatalog.ReportAgentTeamManage);
        var hasViewAll = HasPermission(AdminPermissionCatalog.ReportAgentViewAll);
        var isLeaderOrDeputy = team.LeaderUserId == userId || await IsTeamLeaderOrDeputy(id, userId);
        if (!hasTeamManagePermission && !hasViewAll && !isLeaderOrDeputy)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少团队管理权限"));

        var customPrompt = NormalizeTeamAiSummaryPrompt(team.TeamSummaryPrompt);
        return Ok(ApiResponse<object>.Ok(BuildTeamAiSummaryPromptPayload(customPrompt)));
    }

    /// <summary>
    /// 更新团队周报 AI 分析 Prompt 设置
    /// </summary>
    [HttpPut("teams/{id}/ai-summary-prompt")]
    public async Task<IActionResult> UpdateTeamAiSummaryPrompt(string id, [FromBody] UpdateTeamAiSummaryPromptRequest req, CancellationToken ct)
    {
        var userId = GetUserId();
        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync(ct);
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        var hasTeamManagePermission = HasPermission(AdminPermissionCatalog.ReportAgentTeamManage);
        var hasViewAll = HasPermission(AdminPermissionCatalog.ReportAgentViewAll);
        var isLeaderOrDeputy = team.LeaderUserId == userId || await IsTeamLeaderOrDeputy(id, userId);
        if (!hasTeamManagePermission && !hasViewAll && !isLeaderOrDeputy)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少团队管理权限"));

        var customPrompt = NormalizeTeamAiSummaryPrompt(req?.Prompt);
        if (string.IsNullOrWhiteSpace(customPrompt))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "Prompt 不能为空"));
        if (customPrompt.Length > MaxWeeklyReportPromptLength)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", $"Prompt 长度不能超过 {MaxWeeklyReportPromptLength} 字符"));

        var update = Builders<ReportTeam>.Update
            .Set(x => x.TeamSummaryPrompt, customPrompt)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        await _db.ReportTeams.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(BuildTeamAiSummaryPromptPayload(customPrompt)));
    }

    /// <summary>
    /// 重置团队周报 AI 分析 Prompt 到系统默认
    /// </summary>
    [HttpPost("teams/{id}/ai-summary-prompt/reset")]
    public async Task<IActionResult> ResetTeamAiSummaryPrompt(string id, CancellationToken ct)
    {
        var userId = GetUserId();
        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync(ct);
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        var hasTeamManagePermission = HasPermission(AdminPermissionCatalog.ReportAgentTeamManage);
        var hasViewAll = HasPermission(AdminPermissionCatalog.ReportAgentViewAll);
        var isLeaderOrDeputy = team.LeaderUserId == userId || await IsTeamLeaderOrDeputy(id, userId);
        if (!hasTeamManagePermission && !hasViewAll && !isLeaderOrDeputy)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少团队管理权限"));

        var update = Builders<ReportTeam>.Update
            .Set(x => x.TeamSummaryPrompt, null)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);
        await _db.ReportTeams.UpdateOneAsync(x => x.Id == id, update, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(BuildTeamAiSummaryPromptPayload(null)));
    }

    private static object BuildTeamAiSummaryPromptPayload(string? customPrompt)
    {
        var normalizedCustomPrompt = NormalizeTeamAiSummaryPrompt(customPrompt);
        var systemDefaultPrompt = ReportAgentPromptDefaults.TeamSummarySystemDefaultPrompt;

        return new
        {
            systemDefaultPrompt,
            customPrompt = normalizedCustomPrompt,
            effectivePrompt = normalizedCustomPrompt ?? systemDefaultPrompt,
            usingSystemDefault = normalizedCustomPrompt == null,
            maxCustomPromptLength = ReportAgentPromptDefaults.MaxCustomPromptLength
        };
    }

    private static string? NormalizeTeamAiSummaryPrompt(string? prompt)
    {
        var normalized = (prompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
            return null;
        return normalized;
    }

    #endregion

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
        var currentUserId = GetUserId();
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTeamManage) &&
            !await IsTeamLeaderOrDeputy(id, currentUserId))
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
        var currentUserId = GetUserId();
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTeamManage) &&
            !await IsTeamLeaderOrDeputy(id, currentUserId))
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
        var currentUserId = GetUserId();
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTeamManage) &&
            !await IsTeamLeaderOrDeputy(id, currentUserId))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少团队管理权限"));

        var update = Builders<ReportTeamMember>.Update.Combine();
        if (req.Role != null)
            update = update.Set(m => m.Role, req.Role);
        if (req.JobTitle != null)
            update = update.Set(m => m.JobTitle, req.JobTitle);
        if (req.IdentityMappings != null)
            update = update.Set(m => m.IdentityMappings, req.IdentityMappings);

        var result = await _db.ReportTeamMembers.UpdateOneAsync(
            m => m.TeamId == id && m.UserId == userId, update);
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "成员不存在"));

        var updated = await _db.ReportTeamMembers.Find(
            m => m.TeamId == id && m.UserId == userId).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { member = updated }));
    }

    /// <summary>
    /// 主动退出团队（仅成员/副负责人，负责人需先移交）
    /// </summary>
    [HttpPost("teams/{id}/leave")]
    public async Task<IActionResult> LeaveTeam(string id)
    {
        var userId = GetUserId();
        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        var membership = await _db.ReportTeamMembers.Find(
            m => m.TeamId == id && m.UserId == userId).FirstOrDefaultAsync();
        if (membership == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "你不在该团队中"));

        var effectiveRole = team.LeaderUserId == userId ? ReportTeamRole.Leader : membership.Role;
        if (effectiveRole == ReportTeamRole.Leader || membership.Role == ReportTeamRole.Leader)
            return BadRequest(ApiResponse<object>.Fail("INVALID_REQUEST", "团队负责人不能直接退出，请先移交负责人"));

        var result = await _db.ReportTeamMembers.DeleteOneAsync(m => m.TeamId == id && m.UserId == userId);
        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "成员不存在"));

        return Ok(ApiResponse<object>.Ok(new { left = true }));
    }

    /// <summary>
    /// 更新成员多平台身份映射（v2.0）
    /// </summary>
    [HttpPut("teams/{id}/members/{userId}/identity-mappings")]
    public async Task<IActionResult> UpdateIdentityMappings(
        string id, string userId, [FromBody] Dictionary<string, string> mappings)
    {
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTeamManage) &&
            !await IsTeamLeaderOrDeputy(id, GetUserId()))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少团队管理权限"));

        var result = await _db.ReportTeamMembers.UpdateOneAsync(
            m => m.TeamId == id && m.UserId == userId,
            Builders<ReportTeamMember>.Update.Set(m => m.IdentityMappings, mappings));

        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "成员不存在"));

        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>
    /// 获取团队采集工作流信息（v2.0）
    /// </summary>
    [HttpGet("teams/{id}/workflow")]
    public async Task<IActionResult> GetTeamWorkflow(string id)
    {
        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        if (string.IsNullOrEmpty(team.DataCollectionWorkflowId))
            return Ok(ApiResponse<object>.Ok(new { workflow = (object?)null, templateKey = team.WorkflowTemplateKey }));

        var workflow = await _db.Workflows.Find(w => w.Id == team.DataCollectionWorkflowId).FirstOrDefaultAsync();
        // 获取最近一次执行
        var lastExecution = await _db.WorkflowExecutions
            .Find(e => e.WorkflowId == team.DataCollectionWorkflowId)
            .SortByDescending(e => e.CreatedAt)
            .Limit(1)
            .FirstOrDefaultAsync();

        return Ok(ApiResponse<object>.Ok(new
        {
            workflow = workflow != null ? new
            {
                workflow.Id,
                workflow.Name,
                nodeCount = workflow.Nodes.Count,
                workflow.IsEnabled,
                workflow.LastExecutedAt
            } : null,
            templateKey = team.WorkflowTemplateKey,
            lastExecution = lastExecution != null ? new
            {
                lastExecution.Id,
                lastExecution.Status,
                lastExecution.CreatedAt,
                lastExecution.CompletedAt,
                lastExecution.DurationMs,
                artifactCount = lastExecution.FinalArtifacts.Count,
                lastExecution.ErrorMessage
            } : null
        }));
    }

    /// <summary>
    /// 手动触发团队采集工作流（v2.0）
    /// </summary>
    [HttpPost("teams/{id}/workflow/run")]
    public async Task<IActionResult> RunTeamWorkflow(string id, CancellationToken ct)
    {
        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync(ct);
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        if (string.IsNullOrEmpty(team.DataCollectionWorkflowId))
            return BadRequest(ApiResponse<object>.Fail("NO_WORKFLOW", "团队未绑定采集工作流"));

        if (!await IsTeamLeaderOrDeputy(id, GetUserId()) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentTeamManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "仅团队负责人可触发采集"));

        var now = DateTime.UtcNow;
        var wy = ISOWeek.GetYear(now);
        var wn = ISOWeek.GetWeekOfYear(now);
        var weekStart = ISOWeek.ToDateTime(wy, wn, DayOfWeek.Monday);
        var weekEnd = weekStart.AddDays(4); // 周五

        var wfService = HttpContext.RequestServices.GetRequiredService<PrdAgent.Core.Interfaces.IWorkflowExecutionService>();
        var execution = await wfService.ExecuteInternalAsync(
            team.DataCollectionWorkflowId,
            new Dictionary<string, string>
            {
                ["weekYear"] = wy.ToString(),
                ["weekNumber"] = wn.ToString(),
                ["dateFrom"] = weekStart.ToString("yyyy-MM-dd"),
                ["dateTo"] = weekEnd.ToString("yyyy-MM-dd"),
                ["teamId"] = id
            },
            triggeredBy: $"report-agent:{GetUserId()}",
            ct: ct);

        return Ok(ApiResponse<object>.Ok(new { executionId = execution.Id, status = execution.Status }));
    }

    /// <summary>
    /// 获取用户列表（用于成员选择）
    /// </summary>
    [HttpGet("users")]
    public async Task<IActionResult> ListUsers()
    {
        var users = await _db.Users.Find(u => u.Status == UserStatus.Active)
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
            Sections = req.Sections.Select((s, i) => MapSection(s, i)).ToList(),
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
            update = update.Set(t => t.Sections, req.Sections.Select((s, i) => MapSection(s, i)).ToList());
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

        var template = await _db.ReportTemplates.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (template == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "模板不存在"));
        if (template.IsSystem)
            return BadRequest(ApiResponse<object>.Fail("SYSTEM_TEMPLATE", "系统预置模板不可删除"));

        await _db.ReportTemplates.DeleteOneAsync(t => t.Id == id);
        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 初始化系统预置模板（幂等：已存在的 TemplateKey 跳过）
    /// </summary>
    [HttpPost("templates/seed")]
    public async Task<IActionResult> SeedSystemTemplates()
    {
        if (!HasPermission(AdminPermissionCatalog.ReportAgentTemplateManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "缺少模板管理权限"));

        var systemTemplates = SystemTemplates.GetAllSystemTemplates();
        var existingKeys = (await _db.ReportTemplates
            .Find(t => t.IsSystem && t.TemplateKey != null)
            .Project(t => t.TemplateKey)
            .ToListAsync())
            .ToHashSet();

        var inserted = new List<string>();
        foreach (var tpl in systemTemplates)
        {
            if (existingKeys.Contains(tpl.TemplateKey)) continue;
            await _db.ReportTemplates.InsertOneAsync(tpl);
            inserted.Add(tpl.TemplateKey!);
        }

        return Ok(ApiResponse<object>.Ok(new { inserted, skipped = existingKeys.Count }));
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
        [FromQuery] int? weekNumber = null,
        [FromQuery] string? keyword = null,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 100)
    {
        var userId = GetUserId();
        var now = DateTime.UtcNow;
        var currentWeek = GetWeekInfo(now);
        page = Math.Max(page, 1);
        pageSize = Math.Clamp(pageSize, 1, 100);

        var wy = weekYear ?? currentWeek.weekYear;
        var wn = weekNumber ?? currentWeek.weekNumber;
        var normalizedKeyword = string.IsNullOrWhiteSpace(keyword) ? null : keyword.Trim();

        FilterDefinition<WeeklyReport> filter;

        if (scope == "team" && teamId != null)
        {
            // 需要是团队 leader/deputy 或有 view.all 权限
            var isLeader = await IsTeamLeaderOrDeputy(teamId, userId);
            if (!isLeader && !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
                return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看该团队周报"));

            filter = Builders<WeeklyReport>.Filter.Eq(r => r.TeamId, teamId);
            if (normalizedKeyword == null)
            {
                filter &= Builders<WeeklyReport>.Filter.Eq(r => r.WeekYear, wy)
                       & Builders<WeeklyReport>.Filter.Eq(r => r.WeekNumber, wn);
            }
        }
        else
        {
            // 我的周报
            filter = Builders<WeeklyReport>.Filter.Eq(r => r.UserId, userId);
            if (weekYear.HasValue && weekNumber.HasValue && normalizedKeyword == null)
            {
                filter &= Builders<WeeklyReport>.Filter.Eq(r => r.WeekYear, wy)
                        & Builders<WeeklyReport>.Filter.Eq(r => r.WeekNumber, wn);
            }
        }

        if (normalizedKeyword != null)
        {
            var escapedKeyword = Regex.Escape(normalizedKeyword);
            var regex = new BsonRegularExpression(escapedKeyword, "i");
            var keywordFilter = Builders<WeeklyReport>.Filter.Or(
                Builders<WeeklyReport>.Filter.Regex(r => r.TeamName, regex),
                Builders<WeeklyReport>.Filter.Regex(r => r.UserName, regex),
                Builders<WeeklyReport>.Filter.Regex(r => r.ReturnReason, regex),
                Builders<WeeklyReport>.Filter.ElemMatch(
                    r => r.Sections,
                    Builders<WeeklyReportSection>.Filter.Or(
                        Builders<WeeklyReportSection>.Filter.Regex(x => x.TemplateSection.Title, regex),
                        Builders<WeeklyReportSection>.Filter.ElemMatch(
                            x => x.Items,
                            Builders<WeeklyReportItem>.Filter.Regex(i => i.Content, regex)
                        )
                    )
                )
            );
            filter &= keywordFilter;
        }

        var total = await _db.WeeklyReports.CountDocumentsAsync(filter);
        var reports = await _db.WeeklyReports.Find(filter)
            .SortByDescending(r => r.PeriodEnd)
            .ThenByDescending(r => r.UpdatedAt)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new
        {
            items = reports,
            total,
            page,
            pageSize,
            hasMore = page * pageSize < total,
            keyword = normalizedKeyword
        }));
    }

    /// <summary>
    /// 获取周报详情
    /// </summary>
    [HttpGet("reports/{id}")]
    public async Task<IActionResult> GetReport(string id)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        // 可见性检查：如果不是自己的周报，检查团队可见性设置
        if (report.UserId != userId)
        {
            var team = await _db.ReportTeams.Find(t => t.Id == report.TeamId).FirstOrDefaultAsync();
            if (team?.ReportVisibility == ReportVisibilityMode.LeadersOnly)
            {
                var isLeader = await IsTeamLeaderOrDeputy(report.TeamId, userId);
                if (!isLeader && !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
                    return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "团队设置仅负责人可查看成员周报"));
            }
        }

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
        var creationMode = string.IsNullOrWhiteSpace(req.CreationMode)
            ? ReportCreationMode.Manual
            : req.CreationMode.Trim().ToLowerInvariant();

        if (string.IsNullOrWhiteSpace(req.TeamId))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "团队 ID 不能为空"));
        if (string.IsNullOrWhiteSpace(req.TemplateId))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "模板 ID 不能为空"));
        if (creationMode != ReportCreationMode.Manual && creationMode != ReportCreationMode.AiDraft)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "creationMode 仅支持 manual 或 ai-draft"));

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

        string? aiGenerationError = null;
        if (creationMode == ReportCreationMode.AiDraft)
        {
            try
            {
                report = await _generationService.GenerateAsync(
                    userId,
                    req.TeamId,
                    req.TemplateId,
                    weekYear,
                    weekNumber,
                    CancellationToken.None);
            }
            catch (InvalidOperationException ex)
            {
                aiGenerationError = ex.Message;
                _logger.LogWarning(ex,
                    "创建周报后 AI 草稿生成失败(可预期): userId={UserId}, teamId={TeamId}, week={WeekYear}-W{WeekNumber}",
                    userId, req.TeamId, weekYear, weekNumber);
            }
            catch (Exception ex)
            {
                aiGenerationError = "AI 生成失败，请稍后重试";
                _logger.LogWarning(ex,
                    "创建周报后 AI 草稿生成失败: userId={UserId}, teamId={TeamId}, week={WeekYear}-W{WeekNumber}",
                    userId, req.TeamId, weekYear, weekNumber);
            }
        }

        return Ok(ApiResponse<object>.Ok(new { report, aiGenerationError }));
    }

    /// <summary>
    /// 上传富文本粘贴图片（仅作者、仅可编辑状态）
    /// </summary>
    [HttpPost("reports/{id}/rich-text/images")]
    [RequestSizeLimit(MaxRichTextImageBytes)]
    public async Task<IActionResult> UploadRichTextImage(string id, [FromForm] IFormFile file, CancellationToken ct)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync(ct);
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        if (report.UserId != userId)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只能为自己的周报上传图片"));

        if (!EditableReportStatuses.Contains(report.Status))
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "当前周报状态不允许上传图片"));

        if (file == null || file.Length == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FILE", "请选择图片文件"));

        if (file.Length > MaxRichTextImageBytes)
            return BadRequest(ApiResponse<object>.Fail("FILE_TOO_LARGE", "图片大小不能超过 5MB"));

        var mimeType = file.ContentType?.Trim().ToLowerInvariant() ?? "application/octet-stream";
        if (!AllowedRichTextImageMimeTypes.Contains(mimeType))
            return BadRequest(ApiResponse<object>.Fail("UNSUPPORTED_TYPE", $"不支持的图片类型: {mimeType}"));

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
            UploadedAt = DateTime.UtcNow
        };
        await _db.Attachments.InsertOneAsync(attachment, cancellationToken: ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            attachmentId = attachment.AttachmentId,
            url = attachment.Url,
            fileName = attachment.FileName,
            mimeType = attachment.MimeType,
            size = attachment.Size
        }));
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

        var editableStatuses = EditableReportStatuses;
        if (!editableStatuses.Contains(report.Status))
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "只有草稿、已提交、已退回或逾期状态的周报可以编辑"));

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

        var updateFilter = Builders<WeeklyReport>.Filter.Eq(r => r.Id, id)
                         & Builders<WeeklyReport>.Filter.Eq(r => r.UserId, userId)
                         & Builders<WeeklyReport>.Filter.In(r => r.Status, editableStatuses);
        var updateResult = await _db.WeeklyReports.UpdateOneAsync(updateFilter, update);
        if (updateResult.MatchedCount == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "周报状态已变化，当前不可编辑，请刷新后重试"));

        var updated = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        return Ok(ApiResponse<object>.Ok(new { report = updated }));
    }

    /// <summary>
    /// 删除周报（已审阅前，仅作者）
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

        var deletableStatuses = EditableReportStatuses;
        if (!deletableStatuses.Contains(report.Status))
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "只有草稿、已提交、已退回或逾期状态的周报可以删除"));

        var deleteFilter = Builders<WeeklyReport>.Filter.Eq(r => r.Id, id)
                         & Builders<WeeklyReport>.Filter.Eq(r => r.UserId, userId)
                         & Builders<WeeklyReport>.Filter.In(r => r.Status, deletableStatuses);
        var deleteResult = await _db.WeeklyReports.DeleteOneAsync(deleteFilter);
        if (deleteResult.DeletedCount == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "周报状态已变化，当前不可删除，请刷新后重试"));

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

        if (report.Status != WeeklyReportStatus.Draft && report.Status != WeeklyReportStatus.Returned && report.Status != WeeklyReportStatus.Overdue)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "只有草稿、已退回或逾期状态的周报可以提交"));

        // 构建 StatsSnapshot：快照 auto-stats 板块数据
        var snapshot = new Dictionary<string, object>();
        foreach (var section in report.Sections)
        {
            if (section.TemplateSection.SectionType == ReportSectionType.AutoStats && section.Items.Count > 0)
            {
                var stats = new Dictionary<string, string>();
                foreach (var item in section.Items)
                {
                    if (!string.IsNullOrWhiteSpace(item.Content))
                        stats[item.Content] = item.SourceRef ?? "";
                }
                if (stats.Count > 0)
                    snapshot[section.TemplateSection.Title] = stats;
            }
        }

        var update = Builders<WeeklyReport>.Update
            .Set(r => r.Status, WeeklyReportStatus.Submitted)
            .Set(r => r.SubmittedAt, DateTime.UtcNow)
            .Set(r => r.ReturnReason, null as string)
            .Set(r => r.ReturnedBy, null as string)
            .Set(r => r.ReturnedByName, null as string)
            .Set(r => r.ReturnedAt, null as DateTime?)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        if (snapshot.Count > 0)
            update = update.Set(r => r.StatsSnapshot, snapshot);

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
    /// 退回周报 (Submitted/Reviewed → Returned)
    /// </summary>
    [HttpPost("reports/{id}/return")]
    public async Task<IActionResult> ReturnReport(string id, [FromBody] ReturnReportRequest req)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        var returnableStatuses = new[] { WeeklyReportStatus.Submitted, WeeklyReportStatus.Reviewed };
        if (!returnableStatuses.Contains(report.Status))
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "只有待审阅或已审阅状态的周报可以退回"));

        if (string.IsNullOrWhiteSpace(req.Reason))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "退回原因不能为空"));

        // 验证操作者是团队 leader/deputy
        if (!await IsTeamLeaderOrDeputy(report.TeamId, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只有团队负责人可以退回"));

        var username = GetUsername();
        var update = Builders<WeeklyReport>.Update
            .Set(r => r.Status, WeeklyReportStatus.Returned)
            .Set(r => r.ReturnReason, req.Reason.Trim())
            .Set(r => r.ReturnedBy, userId)
            .Set(r => r.ReturnedByName, username)
            .Set(r => r.ReturnedAt, DateTime.UtcNow)
            .Set(r => r.ReviewedAt, null as DateTime?)
            .Set(r => r.ReviewedBy, null as string)
            .Set(r => r.ReviewedByName, null as string)
            .Set(r => r.UpdatedAt, DateTime.UtcNow);

        var updateFilter = Builders<WeeklyReport>.Filter.Eq(r => r.Id, id)
                         & Builders<WeeklyReport>.Filter.In(r => r.Status, returnableStatuses);
        var updateResult = await _db.WeeklyReports.UpdateOneAsync(updateFilter, update);
        if (updateResult.MatchedCount == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "周报状态已变化，当前不可退回，请刷新后重试"));

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
        /// <summary>周报可见性: all_members / leaders_only</summary>
        public string? ReportVisibility { get; set; }
        /// <summary>自动提交时间 (如 "friday-18:00")</summary>
        public string? AutoSubmitSchedule { get; set; }
        /// <summary>团队自定义每日打点标签</summary>
        public List<string>? CustomDailyLogTags { get; set; }
    }

    public class UpdateTeamRequest
    {
        public string? Name { get; set; }
        public string? LeaderUserId { get; set; }
        public string? Description { get; set; }
        /// <summary>周报可见性: all_members / leaders_only</summary>
        public string? ReportVisibility { get; set; }
        /// <summary>自动提交时间 (如 "friday-18:00")</summary>
        public string? AutoSubmitSchedule { get; set; }
        /// <summary>团队自定义每日打点标签</summary>
        public List<string>? CustomDailyLogTags { get; set; }
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
        /// <summary>多平台身份映射（v2.0）如 { "github": "zhangsan", "tapd": "zhangsan@company.com" }</summary>
        public Dictionary<string, string>? IdentityMappings { get; set; }
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
        /// <summary>v2.0 板块类型：auto-stats / auto-list / manual-list / free-text</summary>
        public string? SectionType { get; set; }
        /// <summary>v2.0 关联的数据源类型（如 ["github", "tapd"]）</summary>
        public List<string>? DataSources { get; set; }
    }

    public class CreateReportRequest
    {
        public string TeamId { get; set; } = string.Empty;
        public string TemplateId { get; set; } = string.Empty;
        public int? WeekYear { get; set; }
        public int? WeekNumber { get; set; }
        /// <summary>创建模式：manual（手动创建）/ ai-draft（创建后自动 AI 生成草稿）</summary>
        public string? CreationMode { get; set; }
    }

    public static class ReportCreationMode
    {
        public const string Manual = "manual";
        public const string AiDraft = "ai-draft";
    }

    public static class ReportAiSourceKey
    {
        public const string DailyLog = "daily-log";
        public const string MapPlatform = "map-platform";
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
        public string Reason { get; set; } = string.Empty;
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
        /// <summary>自定义标签列表</summary>
        public List<string>? Tags { get; set; }
        public int? DurationMinutes { get; set; }
        /// <summary>计划目标 ISO 周所属年份（仅 Todo 有效）</summary>
        public int? PlanWeekYear { get; set; }
        /// <summary>计划目标 ISO 周（1-53，仅 Todo 有效）</summary>
        public int? PlanWeekNumber { get; set; }
        public DateTime? CreatedAt { get; set; }
    }

    public class CreateDataSourceRequest
    {
        public string TeamId { get; set; } = string.Empty;
        public string SourceType { get; set; } = DataSourceType.Git;
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
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "items 不能为空"));

        if (string.IsNullOrEmpty(request.Date))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "date 不能为空"));

        if (!DateTime.TryParse(request.Date, out var parsedDate))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "date 格式无效"));

        var date = parsedDate.Date; // normalize to date only
        var userId = GetUserId();

        var now = DateTime.UtcNow;
        var items = new List<DailyLogItem>();
        foreach (var i in request.Items)
        {
            var normalizedCategory = DailyLogCategory.All.Contains(i.Category ?? "") ? i.Category! : DailyLogCategory.Other;
            var normalizedTags = NormalizeDailyLogTags(i.Tags);
            var systemSelections = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (DailyLogCategory.All.Any(category => string.Equals(category, i.Category ?? string.Empty, StringComparison.OrdinalIgnoreCase)))
                systemSelections.Add(normalizedCategory);
            foreach (var tag in normalizedTags)
            {
                if (IsSystemDailyLogTag(tag))
                    systemSelections.Add(tag);
            }

            var isTodo = systemSelections.Any(tag => string.Equals(tag, DailyLogCategory.Todo, StringComparison.OrdinalIgnoreCase));
            var hasNonTodoSystemTag = systemSelections.Any(tag => !string.Equals(tag, DailyLogCategory.Todo, StringComparison.OrdinalIgnoreCase));
            if (isTodo && hasNonTodoSystemTag)
                return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", DailyLogTodoExclusiveInvalidMessage));
            int? planWeekYear = null;
            int? planWeekNumber = null;

            if (isTodo)
            {
                if (!TryNormalizeIsoWeek(i.PlanWeekYear, i.PlanWeekNumber, out var year, out var week))
                    return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", DailyLogTodoPlanWeekInvalidMessage));
                planWeekYear = year;
                planWeekNumber = week;
            }

            items.Add(new DailyLogItem
            {
                Content = i.Content ?? string.Empty,
                Category = normalizedCategory,
                Tags = normalizedTags,
                DurationMinutes = i.DurationMinutes,
                PlanWeekYear = planWeekYear,
                PlanWeekNumber = planWeekNumber,
                CreatedAt = i.CreatedAt ?? now
            });
        }

        items = items.Where(i => !string.IsNullOrWhiteSpace(i.Content)).ToList();

        if (items.Count == 0)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "至少需要一条有效工作项"));

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

    private static List<string> NormalizeDailyLogTags(IEnumerable<string>? tags)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (var raw in tags ?? Enumerable.Empty<string>())
        {
            var tag = (raw ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(tag))
                continue;
            if (seen.Add(tag))
                result.Add(tag);
        }
        return result;
    }

    private static bool IsSystemDailyLogTag(string tag)
        => DailyLogCategory.All.Any(category => string.Equals(category, tag, StringComparison.OrdinalIgnoreCase));

    private static bool TryNormalizeIsoWeek(int? year, int? weekNumber, out int normalizedYear, out int normalizedWeekNumber)
    {
        normalizedYear = 0;
        normalizedWeekNumber = 0;
        if (!year.HasValue || !weekNumber.HasValue)
            return false;
        if (year.Value < 1 || year.Value > 9999)
            return false;
        var maxWeek = ISOWeek.GetWeeksInYear(year.Value);
        if (weekNumber.Value < 1 || weekNumber.Value > maxWeek)
            return false;
        normalizedYear = year.Value;
        normalizedWeekNumber = weekNumber.Value;
        return true;
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
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "日期格式无效"));

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
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "日期格式无效"));

        var userId = GetUserId();
        var result = await _db.ReportDailyLogs.DeleteOneAsync(
            x => x.UserId == userId && x.Date == parsedDate.Date);

        return Ok(ApiResponse<object>.Ok(new { deleted = result.DeletedCount > 0 }));
    }

    #endregion

    #region My AI Sources

    /// <summary>
    /// 获取我的 AI 周报数据源配置
    /// </summary>
    [HttpGet("my/ai-sources")]
    public async Task<IActionResult> ListMyAiSources(CancellationToken ct)
    {
        var userId = GetUserId();
        var prefs = await _db.UserPreferences
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        var mapPlatformEnabled = prefs?.ReportAgentPreferences?.MapPlatformSourceEnabled ?? true;

        return Ok(ApiResponse<object>.Ok(new
        {
            items = BuildMyAiSourcesPayload(mapPlatformEnabled)
        }));
    }

    /// <summary>
    /// 更新我的 AI 周报数据源配置
    /// </summary>
    [HttpPut("my/ai-sources/{key}")]
    public async Task<IActionResult> UpdateMyAiSource(string key, [FromBody] UpdateMyAiSourceRequest req, CancellationToken ct)
    {
        var normalizedKey = (key ?? string.Empty).Trim().ToLowerInvariant();
        if (normalizedKey == ReportAiSourceKey.DailyLog)
            return BadRequest(ApiResponse<object>.Fail("INVALID_OPERATION", "“日常记录”为默认数据源，不能关闭"));
        if (normalizedKey != ReportAiSourceKey.MapPlatform)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", $"不支持的数据源类型: {key}"));

        var userId = GetUserId();
        var update = Builders<UserPreferences>.Update
            .Set(x => x.ReportAgentPreferences!.MapPlatformSourceEnabled, req.Enabled)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true },
            ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            source = new { key = normalizedKey, enabled = req.Enabled }
        }));
    }

    private static object[] BuildMyAiSourcesPayload(bool mapPlatformEnabled)
    {
        return new object[]
        {
            new
            {
                key = ReportAiSourceKey.DailyLog,
                name = "日常记录",
                enabled = true,
                locked = true,
                description = "AI 每周会从当周的日常记录中提取和分析内容，作为周报内容。默认开启，且不可关闭。"
            },
            new
            {
                key = ReportAiSourceKey.MapPlatform,
                name = "MAP平台工作记录",
                enabled = mapPlatformEnabled,
                locked = false,
                description = "MAP 平台内的行为记录等。关闭后，AI 生成周报时不再使用该类上下文。"
            }
        };
    }

    #endregion

    #region My AI Report Prompt

    /// <summary>
    /// 获取我的 AI 生成周报 Prompt 设置
    /// </summary>
    [HttpGet("my/ai-report-prompt")]
    public async Task<IActionResult> GetMyAiReportPrompt(CancellationToken ct)
    {
        var userId = GetUserId();
        var prefs = await _db.UserPreferences
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);
        var customPrompt = NormalizeMyAiReportPrompt(prefs?.ReportAgentPreferences?.WeeklyReportPrompt);

        return Ok(ApiResponse<object>.Ok(BuildMyAiReportPromptPayload(customPrompt)));
    }

    /// <summary>
    /// 更新我的 AI 生成周报 Prompt 设置
    /// </summary>
    [HttpPut("my/ai-report-prompt")]
    public async Task<IActionResult> UpdateMyAiReportPrompt([FromBody] UpdateMyAiReportPromptRequest req, CancellationToken ct)
    {
        var customPrompt = NormalizeMyAiReportPrompt(req?.Prompt);
        if (string.IsNullOrWhiteSpace(customPrompt))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "Prompt 不能为空"));
        if (customPrompt.Length > MaxWeeklyReportPromptLength)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", $"Prompt 长度不能超过 {MaxWeeklyReportPromptLength} 字符"));

        var userId = GetUserId();
        var update = Builders<UserPreferences>.Update
            .Set(x => x.ReportAgentPreferences!.WeeklyReportPrompt, customPrompt)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true },
            ct);

        return Ok(ApiResponse<object>.Ok(BuildMyAiReportPromptPayload(customPrompt)));
    }

    /// <summary>
    /// 重置我的 AI 生成周报 Prompt 到系统默认
    /// </summary>
    [HttpPost("my/ai-report-prompt/reset")]
    public async Task<IActionResult> ResetMyAiReportPrompt(CancellationToken ct)
    {
        var userId = GetUserId();
        var update = Builders<UserPreferences>.Update
            .Set(x => x.ReportAgentPreferences!.WeeklyReportPrompt, null)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true },
            ct);

        return Ok(ApiResponse<object>.Ok(BuildMyAiReportPromptPayload(null)));
    }

    private static object BuildMyAiReportPromptPayload(string? customPrompt)
    {
        var normalizedCustomPrompt = NormalizeMyAiReportPrompt(customPrompt);
        var systemDefaultPrompt = ReportAgentPromptDefaults.WeeklyReportSystemDefaultPrompt;

        return new
        {
            systemDefaultPrompt,
            customPrompt = normalizedCustomPrompt,
            effectivePrompt = normalizedCustomPrompt ?? systemDefaultPrompt,
            usingSystemDefault = normalizedCustomPrompt == null,
            maxCustomPromptLength = ReportAgentPromptDefaults.MaxCustomPromptLength
        };
    }

    private static string? NormalizeMyAiReportPrompt(string? prompt)
    {
        var normalized = (prompt ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalized))
            return null;
        return normalized;
    }

    #endregion

    #region My Daily Log Tags

    /// <summary>
    /// 获取我的日常记录自定义标签
    /// </summary>
    [HttpGet("my/daily-log-tags")]
    public async Task<IActionResult> GetMyDailyLogTags(CancellationToken ct)
    {
        var userId = GetUserId();
        var prefs = await _db.UserPreferences
            .Find(x => x.UserId == userId)
            .FirstOrDefaultAsync(ct);

        var tags = NormalizeDailyLogCustomTags(prefs?.ReportAgentPreferences?.DailyLogCustomTags);
        return Ok(ApiResponse<object>.Ok(new { items = tags }));
    }

    /// <summary>
    /// 更新我的日常记录自定义标签
    /// </summary>
    [HttpPut("my/daily-log-tags")]
    public async Task<IActionResult> UpdateMyDailyLogTags([FromBody] UpdateMyDailyLogTagsRequest req, CancellationToken ct)
    {
        var normalizedTags = NormalizeDailyLogCustomTags(req?.Items);
        if (normalizedTags.Count > MaxDailyLogCustomTagCount)
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", $"自定义标签最多 {MaxDailyLogCustomTagCount} 个"));

        if (normalizedTags.Any(x => x.Length > MaxDailyLogCustomTagLength))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", $"单个标签最多 {MaxDailyLogCustomTagLength} 个字符"));

        var userId = GetUserId();
        var update = Builders<UserPreferences>.Update
            .Set(x => x.ReportAgentPreferences!.DailyLogCustomTags, normalizedTags)
            .Set(x => x.UpdatedAt, DateTime.UtcNow);

        await _db.UserPreferences.UpdateOneAsync(
            x => x.UserId == userId,
            update,
            new UpdateOptions { IsUpsert = true },
            ct);

        return Ok(ApiResponse<object>.Ok(new { items = normalizedTags }));
    }

    private static List<string> NormalizeDailyLogCustomTags(IEnumerable<string>? tags)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (var raw in tags ?? Enumerable.Empty<string>())
        {
            var tag = (raw ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(tag))
                continue;
            if (seen.Add(tag))
                result.Add(tag);
        }
        return result;
    }

    #endregion

    #region Personal Sources (v2.0)

    /// <summary>
    /// 我的个人数据源列表
    /// </summary>
    [HttpGet("my/sources")]
    public async Task<IActionResult> ListPersonalSources()
    {
        var svc = HttpContext.RequestServices.GetRequiredService<PersonalSourceService>();
        var sources = await svc.ListAsync(GetUserId());

        var cryptoKey = GetCryptoKey();
        var items = sources.Select(s => new
        {
            s.Id,
            s.SourceType,
            s.DisplayName,
            s.Config,
            tokenMasked = ApiKeyCrypto.Mask(
                string.IsNullOrEmpty(s.EncryptedToken) ? null
                : ApiKeyCrypto.Decrypt(s.EncryptedToken, cryptoKey)),
            s.Enabled,
            s.LastSyncAt,
            s.LastSyncStatus,
            s.LastSyncError,
            s.CreatedAt
        });

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>
    /// 绑定个人数据源
    /// </summary>
    [HttpPost("my/sources")]
    public async Task<IActionResult> CreatePersonalSource([FromBody] CreatePersonalSourceRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.SourceType) || !PersonalSourceType.All.Contains(req.SourceType))
            return BadRequest(ApiResponse<object>.Fail("INVALID_SOURCE_TYPE", $"不支持的数据源类型: {req.SourceType}"));

        var svc = HttpContext.RequestServices.GetRequiredService<PersonalSourceService>();
        var source = await svc.CreateAsync(
            GetUserId(),
            req.SourceType,
            req.DisplayName ?? req.SourceType,
            new PersonalSourceConfig
            {
                RepoUrl = req.RepoUrl,
                Username = req.Username,
                SpaceId = req.SpaceId,
                ApiEndpoint = req.ApiEndpoint
            },
            req.Token);

        return Ok(ApiResponse<object>.Ok(new { source = new { source.Id, source.SourceType, source.DisplayName } }));
    }

    /// <summary>
    /// 更新个人数据源
    /// </summary>
    [HttpPut("my/sources/{id}")]
    public async Task<IActionResult> UpdatePersonalSource(string id, [FromBody] UpdatePersonalSourceRequest req)
    {
        var svc = HttpContext.RequestServices.GetRequiredService<PersonalSourceService>();
        PersonalSourceConfig? config = (req.RepoUrl != null || req.Username != null || req.SpaceId != null || req.ApiEndpoint != null)
            ? new PersonalSourceConfig
            {
                RepoUrl = req.RepoUrl,
                Username = req.Username,
                SpaceId = req.SpaceId,
                ApiEndpoint = req.ApiEndpoint
            }
            : null;

        var ok = await svc.UpdateAsync(id, GetUserId(), req.DisplayName, config, req.Token, req.Enabled);
        if (!ok)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "数据源不存在"));

        return Ok(ApiResponse<object>.Ok(new { updated = true }));
    }

    /// <summary>
    /// 解绑个人数据源
    /// </summary>
    [HttpDelete("my/sources/{id}")]
    public async Task<IActionResult> DeletePersonalSource(string id)
    {
        var svc = HttpContext.RequestServices.GetRequiredService<PersonalSourceService>();
        var ok = await svc.DeleteAsync(id, GetUserId());
        if (!ok)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "数据源不存在"));

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    /// <summary>
    /// 测试个人数据源连接
    /// </summary>
    [HttpPost("my/sources/{id}/test")]
    public async Task<IActionResult> TestPersonalSource(string id, CancellationToken ct)
    {
        var svc = HttpContext.RequestServices.GetRequiredService<PersonalSourceService>();
        var ok = await svc.TestConnectionAsync(id, GetUserId(), ct);
        return Ok(ApiResponse<object>.Ok(new { connected = ok }));
    }

    /// <summary>
    /// 手动同步个人数据源
    /// </summary>
    [HttpPost("my/sources/{id}/sync")]
    public async Task<IActionResult> SyncPersonalSource(string id, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var wy = ISOWeek.GetYear(now);
        var wn = ISOWeek.GetWeekOfYear(now);
        var weekStart = ISOWeek.ToDateTime(wy, wn, DayOfWeek.Monday);
        var weekEnd = weekStart.AddDays(6).AddHours(23).AddMinutes(59);

        var svc = HttpContext.RequestServices.GetRequiredService<PersonalSourceService>();
        var stats = await svc.SyncAsync(id, GetUserId(), weekStart, weekEnd, ct);

        if (stats == null)
            return Ok(ApiResponse<object>.Ok(new { synced = false, error = "同步失败，请检查数据源配置" }));

        return Ok(ApiResponse<object>.Ok(new { synced = true, stats = new { stats.Summary, detailCount = stats.Details.Count } }));
    }

    /// <summary>
    /// 我的本周统计预览
    /// </summary>
    [HttpGet("my/stats")]
    public async Task<IActionResult> GetMyStats([FromQuery] int? weekYear, [FromQuery] int? weekNumber, CancellationToken ct)
    {
        var now = DateTime.UtcNow;
        var wy = weekYear ?? ISOWeek.GetYear(now);
        var wn = weekNumber ?? ISOWeek.GetWeekOfYear(now);
        var weekStart = ISOWeek.ToDateTime(wy, wn, DayOfWeek.Monday);
        var weekEnd = weekStart.AddDays(6).AddHours(23).AddMinutes(59);

        var svc = HttpContext.RequestServices.GetRequiredService<PersonalSourceService>();
        var allStats = await svc.CollectAllAsync(GetUserId(), weekStart, weekEnd, ct);

        return Ok(ApiResponse<object>.Ok(new
        {
            weekYear = wy,
            weekNumber = wn,
            periodStart = weekStart,
            periodEnd = weekEnd,
            sources = allStats.Select(s => new
            {
                s.SourceType,
                s.Summary,
                detailCount = s.Details.Count,
                s.CollectedAt
            })
        }));
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
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "名称不能为空"));
        if (string.IsNullOrWhiteSpace(request.RepoUrl))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "仓库地址不能为空"));
        if (string.IsNullOrWhiteSpace(request.TeamId))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "团队 ID 不能为空"));

        var userId = GetUserId();
        if (!HasPermission(AdminPermissionCatalog.ReportAgentDataSourceManage)
            && !HasPermission(AdminPermissionCatalog.ReportAgentTeamManage)
            && !await IsTeamLeaderOrDeputy(request.TeamId, userId))
        {
            return Forbid();
        }

        var sourceType = request.SourceType?.ToLowerInvariant() ?? DataSourceType.Git;
        if (!DataSourceType.All.Contains(sourceType))
            return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", $"不支持的数据源类型: {sourceType}"));

        var source = new ReportDataSource
        {
            TeamId = request.TeamId,
            SourceType = sourceType,
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
        if (source == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "数据源不存在"));

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

        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 删除数据源
    /// </summary>
    [HttpDelete("data-sources/{id}")]
    public async Task<IActionResult> DeleteDataSource(string id)
    {
        var source = await _db.ReportDataSources.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (source == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "数据源不存在"));

        var userId = GetUserId();
        if (!HasPermission(AdminPermissionCatalog.ReportAgentDataSourceManage)
            && !await IsTeamLeaderOrDeputy(source.TeamId, userId))
        {
            return Forbid();
        }

        // 删除关联的提交记录
        await _db.ReportCommits.DeleteManyAsync(x => x.DataSourceId == id);
        await _db.ReportDataSources.DeleteOneAsync(x => x.Id == id);
        return Ok(ApiResponse<object>.Ok(new { }));
    }

    /// <summary>
    /// 测试数据源连接
    /// </summary>
    [HttpPost("data-sources/{id}/test")]
    public async Task<IActionResult> TestDataSource(string id)
    {
        var source = await _db.ReportDataSources.Find(x => x.Id == id).FirstOrDefaultAsync();
        if (source == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "数据源不存在"));

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
        if (source == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "数据源不存在"));

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
        if (source == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "数据源不存在"));

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
            DataSourceType.Svn => new SvnConnector(source, token, _db, _logger),
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
        if (report == null) return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        var userId = GetUserId();
        if (report.UserId != userId && !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return Forbid();

        if (report.Status != WeeklyReportStatus.Draft && report.Status != WeeklyReportStatus.Returned && report.Status != WeeklyReportStatus.Overdue)
            return BadRequest(ApiResponse<object>.Fail("INVALID_STATE", "只有草稿、退回或逾期状态的周报才能生成"));

        try
        {
            var updatedReport = await _generationService.GenerateAsync(
                report.UserId, report.TeamId, report.TemplateId,
                report.WeekYear, report.WeekNumber, CancellationToken.None);

            return Ok(ApiResponse<object>.Ok(updatedReport));
        }
        catch (InvalidOperationException ex)
        {
            _logger.LogWarning(ex, "AI 生成周报失败(可预期): reportId={ReportId}", id);
            return BadRequest(ApiResponse<object>.Fail("AI_GENERATION_FAILED", ex.Message));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "AI 生成周报失败: reportId={ReportId}", id);
            return StatusCode(500, ApiResponse<object>.Fail("SERVER_ERROR", $"AI 生成失败: {ex.Message}"));
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

        var pendingResolved = comments
            .Where(c => string.IsNullOrWhiteSpace(c.AuthorDisplayName) || c.AuthorDisplayName.Trim() == "匿名")
            .ToList();

        if (pendingResolved.Count > 0)
        {
            var authorIds = pendingResolved
                .Select(c => c.AuthorUserId)
                .Where(uid => !string.IsNullOrWhiteSpace(uid))
                .Distinct()
                .ToList();

            if (authorIds.Count > 0)
            {
                var users = await _db.Users
                    .Find(u => authorIds.Contains(u.UserId))
                    .ToListAsync();

                var userMap = users.ToDictionary(u => u.UserId, u => u);
                foreach (var comment in pendingResolved)
                {
                    userMap.TryGetValue(comment.AuthorUserId, out var authorUser);
                    comment.AuthorDisplayName = ResolveUserDisplayName(authorUser, null, comment.AuthorUserId);
                }
            }
        }

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
        var currentUser = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var authorDisplayName = ResolveUserDisplayName(currentUser, username, userId);

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
            AuthorDisplayName = authorDisplayName,
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

    #region Likes

    /// <summary>
    /// 获取周报点赞列表
    /// </summary>
    [HttpGet("reports/{id}/likes")]
    public async Task<IActionResult> ListReportLikes(string id)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        if (!await CanAccessReportAsync(report, userId))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看该周报的点赞"));

        var payload = await BuildReportLikeSummaryPayloadAsync(id, userId);
        return Ok(ApiResponse<object>.Ok(payload));
    }

    /// <summary>
    /// 点赞周报（幂等）
    /// </summary>
    [HttpPost("reports/{id}/likes")]
    public async Task<IActionResult> LikeReport(string id)
    {
        var userId = GetUserId();
        var username = GetUsername();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        if (!await CanAccessReportAsync(report, userId))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权点赞该周报"));

        var currentUser = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var userDisplayName = ResolveUserDisplayName(currentUser, username, userId);
        var like = new ReportLike
        {
            ReportId = id,
            UserId = userId,
            UserName = userDisplayName,
            AvatarFileName = currentUser?.AvatarFileName
        };

        try
        {
            await _db.ReportLikes.InsertOneAsync(like);
        }
        catch (MongoWriteException ex) when (ex.WriteError?.Category == ServerErrorCategory.DuplicateKey)
        {
            // 幂等：重复点赞不报错
        }

        var payload = await BuildReportLikeSummaryPayloadAsync(id, userId);
        return Ok(ApiResponse<object>.Ok(payload));
    }

    /// <summary>
    /// 取消点赞周报（幂等）
    /// </summary>
    [HttpDelete("reports/{id}/likes")]
    public async Task<IActionResult> UnlikeReport(string id)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        if (!await CanAccessReportAsync(report, userId))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权取消点赞该周报"));

        await _db.ReportLikes.DeleteOneAsync(x => x.ReportId == id && x.UserId == userId);

        var payload = await BuildReportLikeSummaryPayloadAsync(id, userId);
        return Ok(ApiResponse<object>.Ok(payload));
    }

    #endregion

    #region Views

    /// <summary>
    /// 记录周报浏览（每次打开/刷新都记录）
    /// </summary>
    [HttpPost("reports/{id}/views")]
    public async Task<IActionResult> RecordReportView(string id)
    {
        var userId = GetUserId();
        var username = GetUsername();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        if (!await CanAccessReportAsync(report, userId))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看该周报"));

        var currentUser = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
        var userDisplayName = ResolveUserDisplayName(currentUser, username, userId);
        var viewEvent = new ReportViewEvent
        {
            ReportId = id,
            UserId = userId,
            UserName = userDisplayName,
            AvatarFileName = currentUser?.AvatarFileName,
            ViewedAt = DateTime.UtcNow
        };

        await _db.ReportViewEvents.InsertOneAsync(viewEvent);
        return Ok(ApiResponse<object>.Ok(new { viewedAt = viewEvent.ViewedAt }));
    }

    /// <summary>
    /// 获取周报浏览汇总（去重人数 + 浏览明细）
    /// </summary>
    [HttpGet("reports/{id}/views-summary")]
    public async Task<IActionResult> GetReportViewsSummary(string id)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        if (!await CanAccessReportAsync(report, userId))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看该周报浏览记录"));

        var payload = await BuildReportViewSummaryPayloadAsync(id, report.UserId);
        return Ok(ApiResponse<object>.Ok(payload));
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
    /// 团队汇总视图（按权限返回 full_team / self_only）
    /// </summary>
    [HttpGet("teams/{id}/summary/view")]
    public async Task<IActionResult> GetTeamSummaryView(string id,
        [FromQuery] int? weekYear, [FromQuery] int? weekNumber)
    {
        var userId = GetUserId();
        var username = GetUsername();
        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        var membership = await _db.ReportTeamMembers.Find(
            m => m.TeamId == id && m.UserId == userId).FirstOrDefaultAsync();

        var hasViewAll = HasPermission(AdminPermissionCatalog.ReportAgentViewAll);
        var isLeaderOrDeputy = team.LeaderUserId == userId ||
            (membership != null && (membership.Role == ReportTeamRole.Leader || membership.Role == ReportTeamRole.Deputy));
        var isMember = membership != null || team.LeaderUserId == userId;

        if (!isMember && !hasViewAll)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看团队汇总"));

        var canViewAllReports = hasViewAll
            || isLeaderOrDeputy
            || (isMember && team.ReportVisibility == ReportVisibilityMode.AllMembers);
        var hasTeamManagePermission = HasPermission(AdminPermissionCatalog.ReportAgentTeamManage);
        var canManageMembers = hasTeamManagePermission || isLeaderOrDeputy;
        var canGenerateSummary = hasViewAll || isLeaderOrDeputy;

        var now = DateTime.UtcNow;
        var wy = weekYear ?? ISOWeek.GetYear(now);
        var wn = weekNumber ?? ISOWeek.GetWeekOfYear(now);
        var monday = ISOWeek.ToDateTime(wy, wn, DayOfWeek.Monday);
        var sunday = monday.AddDays(6);

        TeamSummary? summary = null;
        string summaryKind = "none";
        string? message = null;
        List<object> members;

        if (canViewAllReports)
        {
            summary = await _db.ReportTeamSummaries.Find(
                s => s.TeamId == id && s.WeekYear == wy && s.WeekNumber == wn
            ).FirstOrDefaultAsync();

            summaryKind = summary != null ? "team_summary" : "none";
            if (summary == null)
                message = canGenerateSummary
                    ? "暂无团队汇总，可点击“生成汇总”"
                    : "团队汇总尚未生成";

            var allMembers = await _db.ReportTeamMembers.Find(m => m.TeamId == id).ToListAsync();
            var reports = await _db.WeeklyReports.Find(
                r => r.TeamId == id && r.WeekYear == wy && r.WeekNumber == wn
            ).ToListAsync();
            var reportMap = reports.ToDictionary(r => r.UserId);

            members = allMembers.Select(m => new
            {
                userId = m.UserId,
                userName = m.UserName,
                avatarFileName = m.AvatarFileName,
                role = m.Role,
                jobTitle = m.JobTitle,
                reportId = reportMap.TryGetValue(m.UserId, out var rpt) ? rpt.Id : null,
                reportStatus = reportMap.TryGetValue(m.UserId, out var rpt2) ? rpt2.Status : WeeklyReportStatus.NotStarted,
                submittedAt = reportMap.TryGetValue(m.UserId, out var rpt3) ? rpt3.SubmittedAt : null
            }).Cast<object>().ToList();
        }
        else
        {
            var selfViewableStatuses = new[] {
                WeeklyReportStatus.Submitted,
                WeeklyReportStatus.Reviewed,
                WeeklyReportStatus.Returned,
                WeeklyReportStatus.Viewed
            };

            var selfSubmittedReport = await _db.WeeklyReports.Find(
                r => r.TeamId == id
                     && r.UserId == userId
                     && r.WeekYear == wy
                     && r.WeekNumber == wn
                     && selfViewableStatuses.Contains(r.Status)
            ).FirstOrDefaultAsync();

            if (selfSubmittedReport != null)
            {
                summary = BuildSelfSummary(team, selfSubmittedReport, userId, username);
                summaryKind = "self_report";
                message = "当前团队未公开成员周报，仅展示你本周已提交内容";
            }
            else
            {
                message = "当前团队未公开成员周报，且你本周暂无已提交周报";
            }

            var selfReportForStatus = await _db.WeeklyReports.Find(
                r => r.TeamId == id && r.UserId == userId && r.WeekYear == wy && r.WeekNumber == wn
            ).FirstOrDefaultAsync();

            members = new List<object>
            {
                new
                {
                    userId,
                    userName = username ?? membership?.UserName,
                    avatarFileName = membership?.AvatarFileName,
                    role = membership?.Role ?? (team.LeaderUserId == userId ? ReportTeamRole.Leader : ReportTeamRole.Member),
                    jobTitle = membership?.JobTitle,
                    reportId = selfReportForStatus?.Id,
                    reportStatus = selfReportForStatus?.Status ?? WeeklyReportStatus.NotStarted,
                    submittedAt = selfReportForStatus?.SubmittedAt
                }
            };
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            team,
            weekYear = wy,
            weekNumber = wn,
            periodStart = monday,
            periodEnd = sunday,
            visibilityScope = canViewAllReports ? "full_team" : "self_only",
            summaryKind,
            summary,
            message,
            canGenerateSummary,
            canManageMembers,
            canViewAllMembers = canViewAllReports,
            members
        }));
    }

    /// <summary>
    /// 团队周报列表视图（默认主视图，按权限返回 full_team / self_only）
    /// </summary>
    [HttpGet("teams/{id}/reports/view")]
    public async Task<IActionResult> GetTeamReportsView(string id,
        [FromQuery] int? weekYear, [FromQuery] int? weekNumber)
    {
        var userId = GetUserId();
        var username = GetUsername();
        var team = await _db.ReportTeams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "团队不存在"));

        var membership = await _db.ReportTeamMembers.Find(
            m => m.TeamId == id && m.UserId == userId).FirstOrDefaultAsync();

        var hasViewAll = HasPermission(AdminPermissionCatalog.ReportAgentViewAll);
        var isLeaderOrDeputy = team.LeaderUserId == userId ||
            (membership != null && (membership.Role == ReportTeamRole.Leader || membership.Role == ReportTeamRole.Deputy));
        var isMember = membership != null || team.LeaderUserId == userId;

        if (!isMember && !hasViewAll)
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看团队周报列表"));

        var canViewAllReports = hasViewAll
            || isLeaderOrDeputy
            || (isMember && team.ReportVisibility == ReportVisibilityMode.AllMembers);
        var hasTeamManagePermission = HasPermission(AdminPermissionCatalog.ReportAgentTeamManage);
        var canManageMembers = hasTeamManagePermission || isLeaderOrDeputy;
        var canGenerateSummary = hasViewAll || isLeaderOrDeputy;

        var now = DateTime.UtcNow;
        var wy = weekYear ?? ISOWeek.GetYear(now);
        var wn = weekNumber ?? ISOWeek.GetWeekOfYear(now);
        var monday = ISOWeek.ToDateTime(wy, wn, DayOfWeek.Monday);
        var sunday = monday.AddDays(6);

        var allMembers = await _db.ReportTeamMembers.Find(m => m.TeamId == id).ToListAsync();
        var weekReports = await _db.WeeklyReports.Find(
            r => r.TeamId == id && r.WeekYear == wy && r.WeekNumber == wn
        ).ToListAsync();

        var submittedStatuses = new[] { WeeklyReportStatus.Submitted, WeeklyReportStatus.Reviewed, WeeklyReportStatus.Viewed };
        var submittedCount = weekReports.Count(r => submittedStatuses.Contains(r.Status));
        var pendingCount = Math.Max(0, allMembers.Count - submittedCount);

        string? message = null;
        List<object> items;
        List<object> members;

        if (canViewAllReports)
        {
            items = weekReports
                .Where(r => submittedStatuses.Contains(r.Status))
                .OrderByDescending(r => r.SubmittedAt ?? r.UpdatedAt)
                .Select(r => new
                {
                    reportId = r.Id,
                    userId = r.UserId,
                    userName = r.UserName,
                    avatarFileName = r.AvatarFileName,
                    status = r.Status,
                    submittedAt = r.SubmittedAt,
                    updatedAt = r.UpdatedAt,
                    teamId = r.TeamId,
                    teamName = r.TeamName,
                    weekYear = r.WeekYear,
                    weekNumber = r.WeekNumber
                })
                .Cast<object>()
                .ToList();

            var reportMap = weekReports.ToDictionary(r => r.UserId);
            members = allMembers.Select(m => new
            {
                userId = m.UserId,
                userName = m.UserName,
                avatarFileName = m.AvatarFileName,
                role = m.Role,
                jobTitle = m.JobTitle,
                reportId = reportMap.TryGetValue(m.UserId, out var rpt) ? rpt.Id : null,
                reportStatus = reportMap.TryGetValue(m.UserId, out var rpt2) ? rpt2.Status : WeeklyReportStatus.NotStarted,
                submittedAt = reportMap.TryGetValue(m.UserId, out var rpt3) ? rpt3.SubmittedAt : null
            }).Cast<object>().ToList();
        }
        else
        {
            var selfVisibleReport = weekReports
                .Where(r => r.UserId == userId && submittedStatuses.Contains(r.Status))
                .OrderByDescending(r => r.SubmittedAt ?? r.UpdatedAt)
                .FirstOrDefault();

            items = new List<object>();
            if (selfVisibleReport != null)
            {
                items.Add(new
                {
                    reportId = selfVisibleReport.Id,
                    userId = selfVisibleReport.UserId,
                    userName = selfVisibleReport.UserName,
                    avatarFileName = selfVisibleReport.AvatarFileName,
                    status = selfVisibleReport.Status,
                    submittedAt = selfVisibleReport.SubmittedAt,
                    updatedAt = selfVisibleReport.UpdatedAt,
                    teamId = selfVisibleReport.TeamId,
                    teamName = selfVisibleReport.TeamName,
                    weekYear = selfVisibleReport.WeekYear,
                    weekNumber = selfVisibleReport.WeekNumber
                });
                message = "当前团队未公开成员周报，仅展示你本周已提交周报";
            }
            else
            {
                message = "当前团队未公开成员周报，且你本周暂无已提交周报";
            }

            var selfReportForStatus = weekReports.FirstOrDefault(r => r.UserId == userId);
            members = new List<object>
            {
                new
                {
                    userId,
                    userName = username ?? membership?.UserName,
                    avatarFileName = membership?.AvatarFileName,
                    role = membership?.Role ?? (team.LeaderUserId == userId ? ReportTeamRole.Leader : ReportTeamRole.Member),
                    jobTitle = membership?.JobTitle,
                    reportId = selfReportForStatus?.Id,
                    reportStatus = selfReportForStatus?.Status ?? WeeklyReportStatus.NotStarted,
                    submittedAt = selfReportForStatus?.SubmittedAt
                }
            };
        }

        return Ok(ApiResponse<object>.Ok(new
        {
            team,
            weekYear = wy,
            weekNumber = wn,
            periodStart = monday,
            periodEnd = sunday,
            visibilityScope = canViewAllReports ? "full_team" : "self_only",
            stats = new
            {
                totalMembers = allMembers.Count,
                submittedCount,
                pendingCount
            },
            items,
            members,
            message,
            canGenerateSummary,
            canManageMembers,
            canViewAllMembers = canViewAllReports
        }));
    }

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
            return BadRequest(ApiResponse<object>.Fail("INVALID_REQUEST", ex.Message));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "团队汇总生成失败: teamId={TeamId}", id);
            return StatusCode(500, ApiResponse<object>.Fail("SERVER_ERROR", $"AI 汇总失败: {ex.Message}"));
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

    #region Phase 4: History Trends

    /// <summary>
    /// 获取个人历史趋势数据（最近 N 周）
    /// </summary>
    [HttpGet("trends/personal")]
    public async Task<IActionResult> GetPersonalTrends([FromQuery] int weeks = 12)
    {
        var userId = GetUserId();
        weeks = Math.Clamp(weeks, 4, 52);
        var now = DateTime.UtcNow;

        var items = new List<object>();
        for (var i = weeks - 1; i >= 0; i--)
        {
            var targetDate = now.AddDays(-7 * i);
            var wy = ISOWeek.GetYear(targetDate);
            var wn = ISOWeek.GetWeekOfYear(targetDate);
            var monday = ISOWeek.ToDateTime(wy, wn, DayOfWeek.Monday);
            var sunday = monday.AddDays(6);

            // 周报状态
            var report = await _db.WeeklyReports.Find(
                r => r.UserId == userId && r.WeekYear == wy && r.WeekNumber == wn
            ).FirstOrDefaultAsync();

            // 提交记录数
            var commitCount = await _db.ReportCommits.CountDocumentsAsync(
                c => c.MappedUserId == userId && c.CommittedAt >= monday && c.CommittedAt <= sunday.AddDays(1));

            // 每日打点天数
            var dailyLogDays = await _db.ReportDailyLogs.CountDocumentsAsync(
                d => d.UserId == userId && d.Date >= monday && d.Date <= sunday.AddDays(1));

            items.Add(new
            {
                weekYear = wy,
                weekNumber = wn,
                periodStart = monday,
                periodEnd = sunday,
                reportStatus = report?.Status ?? WeeklyReportStatus.NotStarted,
                sectionCount = report?.Sections.Sum(s => s.Items.Count) ?? 0,
                commitCount,
                dailyLogDays,
                submittedAt = report?.SubmittedAt,
            });
        }

        return Ok(ApiResponse<object>.Ok(new { items, weeks }));
    }

    /// <summary>
    /// 获取团队历史趋势数据（最近 N 周）
    /// </summary>
    [HttpGet("trends/team/{teamId}")]
    public async Task<IActionResult> GetTeamTrends(string teamId, [FromQuery] int weeks = 12)
    {
        var userId = GetUserId();
        if (!await IsTeamLeaderOrDeputy(teamId, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权查看团队趋势"));

        weeks = Math.Clamp(weeks, 4, 52);
        var now = DateTime.UtcNow;

        var members = await _db.ReportTeamMembers.Find(m => m.TeamId == teamId).ToListAsync();
        var memberCount = members.Count;

        var items = new List<object>();
        for (var i = weeks - 1; i >= 0; i--)
        {
            var targetDate = now.AddDays(-7 * i);
            var wy = ISOWeek.GetYear(targetDate);
            var wn = ISOWeek.GetWeekOfYear(targetDate);
            var monday = ISOWeek.ToDateTime(wy, wn, DayOfWeek.Monday);
            var sunday = monday.AddDays(6);

            var reports = await _db.WeeklyReports.Find(
                r => r.TeamId == teamId && r.WeekYear == wy && r.WeekNumber == wn
            ).ToListAsync();

            var submittedCount = reports.Count(r =>
                r.Status == WeeklyReportStatus.Submitted ||
                r.Status == WeeklyReportStatus.Reviewed);
            var reviewedCount = reports.Count(r => r.Status == WeeklyReportStatus.Reviewed);
            var overdueCount = reports.Count(r => r.Status == WeeklyReportStatus.Overdue);

            // 团队提交记录数
            var memberIds = members.Select(m => m.UserId).ToList();
            var commitCount = await _db.ReportCommits.CountDocumentsAsync(
                c => memberIds.Contains(c.MappedUserId!) && c.CommittedAt >= monday && c.CommittedAt <= sunday.AddDays(1));

            items.Add(new
            {
                weekYear = wy,
                weekNumber = wn,
                periodStart = monday,
                periodEnd = sunday,
                memberCount,
                submittedCount,
                reviewedCount,
                overdueCount,
                submissionRate = memberCount > 0 ? Math.Round((double)submittedCount / memberCount * 100, 1) : 0,
                commitCount,
            });
        }

        return Ok(ApiResponse<object>.Ok(new { items, weeks, teamId }));
    }

    #endregion

    #region Phase 4: Export

    /// <summary>
    /// 导出周报为 Markdown
    /// </summary>
    [HttpGet("reports/{id}/export/markdown")]
    public async Task<IActionResult> ExportReportMarkdown(string id)
    {
        var userId = GetUserId();
        var report = await _db.WeeklyReports.Find(r => r.Id == id).FirstOrDefaultAsync();
        if (report == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "周报不存在"));

        // 验证可见性
        if (report.UserId != userId &&
            !await IsTeamLeaderOrDeputy(report.TeamId, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权导出该周报"));

        var md = BuildMarkdownExport(report);
        var fileName = $"周报_{report.UserName ?? report.UserId}_{report.WeekYear}W{report.WeekNumber:D2}.md";

        return File(System.Text.Encoding.UTF8.GetBytes(md), "text/markdown; charset=utf-8", fileName);
    }

    /// <summary>
    /// 导出团队汇总为 Markdown
    /// </summary>
    [HttpGet("teams/{teamId}/summary/export/markdown")]
    public async Task<IActionResult> ExportTeamSummaryMarkdown(string teamId,
        [FromQuery] int? weekYear, [FromQuery] int? weekNumber)
    {
        var userId = GetUserId();
        if (!await IsTeamLeaderOrDeputy(teamId, userId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentViewAll))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "无权导出团队汇总"));

        var now = DateTime.UtcNow;
        var wy = weekYear ?? ISOWeek.GetYear(now);
        var wn = weekNumber ?? ISOWeek.GetWeekOfYear(now);

        var summary = await _db.ReportTeamSummaries.Find(
            s => s.TeamId == teamId && s.WeekYear == wy && s.WeekNumber == wn
        ).FirstOrDefaultAsync();

        if (summary == null)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "暂无团队汇总数据"));

        var md = BuildTeamSummaryMarkdown(summary);
        var fileName = $"团队汇总_{summary.TeamName}_{wy}W{wn:D2}.md";

        return File(System.Text.Encoding.UTF8.GetBytes(md), "text/markdown; charset=utf-8", fileName);
    }

    private static string BuildMarkdownExport(WeeklyReport report)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"# 周报 — {report.UserName ?? report.UserId}");
        sb.AppendLine();
        sb.AppendLine($"- **周期**：{report.WeekYear} 年第 {report.WeekNumber} 周（{report.PeriodStart:yyyy-MM-dd} ~ {report.PeriodEnd:yyyy-MM-dd}）");
        sb.AppendLine($"- **团队**：{report.TeamName ?? report.TeamId}");
        sb.AppendLine($"- **状态**：{report.Status}");
        if (report.SubmittedAt.HasValue)
            sb.AppendLine($"- **提交时间**：{report.SubmittedAt:yyyy-MM-dd HH:mm}");
        sb.AppendLine();
        sb.AppendLine("---");
        sb.AppendLine();

        foreach (var section in report.Sections)
        {
            sb.AppendLine($"## {section.TemplateSection.Title}");
            sb.AppendLine();

            if (section.Items.Count == 0)
            {
                sb.AppendLine("_（暂无内容）_");
            }
            else
            {
                if (section.TemplateSection.InputType == ReportInputType.RichText)
                {
                    var hasRichTextContent = false;
                    foreach (var item in section.Items)
                    {
                        var source = item.Source != "manual" ? $" `[{item.Source}]`" : "";
                        var content = item.Content?.Trim();
                        if (!string.IsNullOrWhiteSpace(content))
                        {
                            hasRichTextContent = true;
                            sb.AppendLine(content);
                            if (!string.IsNullOrWhiteSpace(source))
                                sb.AppendLine(source);
                            sb.AppendLine();
                        }
                    }
                    if (!hasRichTextContent)
                        sb.AppendLine("_（暂无内容）_");
                }
                else
                {
                    foreach (var item in section.Items)
                    {
                        var source = item.Source != "manual" ? $" `[{item.Source}]`" : "";
                        sb.AppendLine($"- {item.Content}{source}");
                    }
                }
            }
            sb.AppendLine();
        }

        sb.AppendLine("---");
        sb.AppendLine($"_导出时间：{DateTime.UtcNow:yyyy-MM-dd HH:mm} UTC_");
        return sb.ToString();
    }

    private static string BuildTeamSummaryMarkdown(TeamSummary summary)
    {
        var sb = new System.Text.StringBuilder();
        sb.AppendLine($"# 团队周报汇总 — {summary.TeamName}");
        sb.AppendLine();
        sb.AppendLine($"- **周期**：{summary.WeekYear} 年第 {summary.WeekNumber} 周（{summary.PeriodStart:yyyy-MM-dd} ~ {summary.PeriodEnd:yyyy-MM-dd}）");
        sb.AppendLine($"- **成员数**：{summary.MemberCount}，已提交：{summary.SubmittedCount}");
        sb.AppendLine($"- **生成人**：{summary.GeneratedByName}");
        sb.AppendLine($"- **生成时间**：{summary.GeneratedAt:yyyy-MM-dd HH:mm}");
        sb.AppendLine();
        sb.AppendLine("---");
        sb.AppendLine();

        foreach (var section in summary.Sections)
        {
            sb.AppendLine($"## {section.Title}");
            sb.AppendLine();
            foreach (var item in section.Items)
            {
                sb.AppendLine($"- {item}");
            }
            sb.AppendLine();
        }

        sb.AppendLine("---");
        sb.AppendLine($"_导出时间：{DateTime.UtcNow:yyyy-MM-dd HH:mm} UTC_");
        return sb.ToString();
    }

    #endregion

    #region Phase 4: Holiday / Vacation

    /// <summary>
    /// 标记成员本周请假（团队负责人操作）
    /// </summary>
    [HttpPost("teams/{teamId}/members/{userId}/vacation")]
    public async Task<IActionResult> MarkVacation(string teamId, string userId,
        [FromBody] MarkVacationRequest req)
    {
        var currentUserId = GetUserId();

        if (!await IsTeamLeaderOrDeputy(teamId, currentUserId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentTeamManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只有团队负责人可以标记请假"));

        if (!await IsTeamMember(teamId, userId))
            return BadRequest(ApiResponse<object>.Fail("NOT_FOUND", "该用户不是团队成员"));

        var now = DateTime.UtcNow;
        var wy = req.WeekYear ?? ISOWeek.GetYear(now);
        var wn = req.WeekNumber ?? ISOWeek.GetWeekOfYear(now);

        // 查看该周是否已有周报
        var existingReport = await _db.WeeklyReports.Find(
            r => r.UserId == userId && r.TeamId == teamId && r.WeekYear == wy && r.WeekNumber == wn
        ).FirstOrDefaultAsync();

        if (existingReport != null &&
            (existingReport.Status == WeeklyReportStatus.Submitted || existingReport.Status == WeeklyReportStatus.Reviewed))
            return BadRequest(ApiResponse<object>.Fail("INVALID_REQUEST", "该周报已提交/审阅，无法标记请假"));

        // 如果已有 draft/overdue 周报，删除
        if (existingReport != null)
        {
            await _db.WeeklyReports.DeleteOneAsync(r => r.Id == existingReport.Id);
        }

        // 创建请假标记周报（特殊 status = vacation）
        var monday = ISOWeek.ToDateTime(wy, wn, DayOfWeek.Monday);
        var sunday = monday.AddDays(6);
        var user = await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();

        var vacationReport = new WeeklyReport
        {
            UserId = userId,
            UserName = user?.DisplayName,
            AvatarFileName = user?.AvatarFileName,
            TeamId = teamId,
            TeamName = (await _db.ReportTeams.Find(t => t.Id == teamId).FirstOrDefaultAsync())?.Name,
            TemplateId = "",
            WeekYear = wy,
            WeekNumber = wn,
            PeriodStart = monday,
            PeriodEnd = sunday,
            Status = "vacation",
            Sections = new List<WeeklyReportSection>
            {
                new() {
                    TemplateSection = new ReportTemplateSection { Title = "请假说明" },
                    Items = new List<WeeklyReportItem>
                    {
                        new() { Content = req.Reason ?? "本周请假", Source = "system" }
                    }
                }
            }
        };

        await _db.WeeklyReports.InsertOneAsync(vacationReport);

        return Ok(ApiResponse<object>.Ok(new { report = vacationReport }));
    }

    /// <summary>
    /// 取消请假标记
    /// </summary>
    [HttpDelete("teams/{teamId}/members/{userId}/vacation")]
    public async Task<IActionResult> CancelVacation(string teamId, string userId,
        [FromQuery] int? weekYear, [FromQuery] int? weekNumber)
    {
        var currentUserId = GetUserId();

        if (!await IsTeamLeaderOrDeputy(teamId, currentUserId) &&
            !HasPermission(AdminPermissionCatalog.ReportAgentTeamManage))
            return StatusCode(403, ApiResponse<object>.Fail("PERMISSION_DENIED", "只有团队负责人可以取消请假标记"));

        var now = DateTime.UtcNow;
        var wy = weekYear ?? ISOWeek.GetYear(now);
        var wn = weekNumber ?? ISOWeek.GetWeekOfYear(now);

        var result = await _db.WeeklyReports.DeleteOneAsync(
            r => r.UserId == userId && r.TeamId == teamId &&
                 r.WeekYear == wy && r.WeekNumber == wn &&
                 r.Status == "vacation");

        if (result.DeletedCount == 0)
            return NotFound(ApiResponse<object>.Fail("NOT_FOUND", "未找到请假标记"));

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    #endregion
}

public class CreateCommentRequest
{
    public int SectionIndex { get; set; }
    public string Content { get; set; } = string.Empty;
    public string? ParentCommentId { get; set; }
}

public class MarkVacationRequest
{
    public int? WeekYear { get; set; }
    public int? WeekNumber { get; set; }
    public string? Reason { get; set; }
}

// v2.0 Personal Source DTOs
public class CreatePersonalSourceRequest
{
    public string SourceType { get; set; } = string.Empty;
    public string? DisplayName { get; set; }
    public string? Token { get; set; }
    public string? RepoUrl { get; set; }
    public string? Username { get; set; }
    public string? SpaceId { get; set; }
    public string? ApiEndpoint { get; set; }
}

public class UpdateMyAiSourceRequest
{
    public bool Enabled { get; set; }
}

public class UpdateMyDailyLogTagsRequest
{
    public List<string>? Items { get; set; }
}

public class UpdateMyAiReportPromptRequest
{
    public string? Prompt { get; set; }
}

public class UpdateTeamAiSummaryPromptRequest
{
    public string? Prompt { get; set; }
}

public class UpdatePersonalSourceRequest
{
    public string? DisplayName { get; set; }
    public string? Token { get; set; }
    public bool? Enabled { get; set; }
    public string? RepoUrl { get; set; }
    public string? Username { get; set; }
    public string? SpaceId { get; set; }
    public string? ApiEndpoint { get; set; }
}
