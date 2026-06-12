using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Extensions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Controllers.Api;

/// <summary>
/// 团队 — 跨应用协作单位（网页托管 + 知识库共用同一批团队和成员）。
/// 仅需登录即可使用（任何用户都能创建/加入团队）；团队管理是页内面板，不进导航。
/// </summary>
[ApiController]
[Route("api/teams")]
[Authorize]
public class TeamController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ITeamService _teams;
    private readonly ITeamActivityService _activity;
    private readonly ILogger<TeamController> _logger;

    public TeamController(
        MongoDbContext db,
        ITeamService teams,
        ITeamActivityService activity,
        ILogger<TeamController> logger)
    {
        _db = db;
        _teams = teams;
        _activity = activity;
        _logger = logger;
    }

    private string GetUserId() => this.GetRequiredUserId();

    private async Task<User?> FindUserAsync(string userId)
        => await _db.Users.Find(u => u.UserId == userId).FirstOrDefaultAsync();

    private static string DisplayNameOf(User? u)
        => u != null && !string.IsNullOrWhiteSpace(u.DisplayName) ? u.DisplayName : (u?.Username ?? "未知用户");

    // ─────────────────────────────────────────────
    // 团队 CRUD
    // ─────────────────────────────────────────────

    /// <summary>创建团队（创建者自动成为管理员）</summary>
    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateTeamRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.Name))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "团队名称不能为空"));

        var userId = GetUserId();
        var me = await FindUserAsync(userId);
        var visibility = TeamVisibility.All.Contains(req.Visibility) ? req.Visibility! : TeamVisibility.Private;

        var team = new Team
        {
            Name = req.Name.Trim(),
            Description = req.Description?.Trim(),
            OwnerUserId = userId,
            OwnerName = DisplayNameOf(me),
            Visibility = visibility,
        };
        await _db.Teams.InsertOneAsync(team);

        await _db.TeamMembers.InsertOneAsync(new TeamMember
        {
            TeamId = team.Id,
            UserId = userId,
            UserName = DisplayNameOf(me),
            AvatarFileName = me?.AvatarFileName,
            Role = TeamRole.Admin,
        });

        await _activity.LogAsync(team.Id, TeamAppKey.Team, userId,
            TeamActivityAction.TeamCreated, "team", team.Id, team.Name);

        return Ok(ApiResponse<object>.Ok(new { team, myRole = TeamRole.Admin, memberCount = 1 }));
    }

    /// <summary>列出我所属的团队</summary>
    [HttpGet]
    public async Task<IActionResult> ListMyTeams()
    {
        var userId = GetUserId();
        var myMemberships = await _db.TeamMembers.Find(m => m.UserId == userId).ToListAsync();
        var teamIds = myMemberships.Select(m => m.TeamId).Distinct().ToList();
        if (teamIds.Count == 0)
            return Ok(ApiResponse<object>.Ok(new { items = new List<object>() }));

        var teams = await _db.Teams.Find(t => teamIds.Contains(t.Id)).ToListAsync();
        var allMembers = await _db.TeamMembers.Find(m => teamIds.Contains(m.TeamId)).ToListAsync();
        var countByTeam = allMembers.GroupBy(m => m.TeamId).ToDictionary(g => g.Key, g => g.Count());
        var roleByTeam = myMemberships.ToDictionary(m => m.TeamId, m => m.Role);

        var items = teams.Select(t => new
        {
            team = t,
            myRole = roleByTeam.GetValueOrDefault(t.Id, TeamRole.Member),
            memberCount = countByTeam.GetValueOrDefault(t.Id, 0),
        }).OrderByDescending(x => x.team.CreatedAt).ToList();

        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>团队详情 + 成员列表（成员可见）</summary>
    [HttpGet("{id}")]
    public async Task<IActionResult> Get(string id)
    {
        var userId = GetUserId();
        if (!await _teams.IsMemberAsync(id, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "不是该团队成员"));

        var team = await _db.Teams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "团队不存在"));

        var members = await _db.TeamMembers.Find(m => m.TeamId == id).ToListAsync();
        var myRole = members.FirstOrDefault(m => m.UserId == userId)?.Role ?? TeamRole.Member;

        // 网页托管有效角色（owner/editor/viewer）：成员管理面板据此渲染角色选择器 + 角标。
        // 附带返回避免前端各自做继承解析导致漂移（SSOT 在后端 WebHostingRoles.Resolve）。
        var webHostingRoles = members.ToDictionary(
            m => m.UserId, m => WebHostingRoles.Resolve(m.WebHostingRole, m.Role));
        var myWebHostingRole = webHostingRoles.GetValueOrDefault(userId, WebHostingRoles.Editor);

        return Ok(ApiResponse<object>.Ok(new { team, members, myRole, webHostingRoles, myWebHostingRole }));
    }

    /// <summary>更新团队（管理员）</summary>
    [HttpPut("{id}")]
    public async Task<IActionResult> Update(string id, [FromBody] UpdateTeamRequest req)
    {
        var userId = GetUserId();
        if (!await _teams.IsAdminAsync(id, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要管理员权限"));

        var ub = Builders<Team>.Update;
        var updates = new List<UpdateDefinition<Team>>();
        if (req.Name != null) updates.Add(ub.Set(t => t.Name, req.Name.Trim()));
        if (req.Description != null) updates.Add(ub.Set(t => t.Description, req.Description.Trim()));
        if (req.Visibility != null && TeamVisibility.All.Contains(req.Visibility))
            updates.Add(ub.Set(t => t.Visibility, req.Visibility));
        if (updates.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "没有需要更新的字段"));

        updates.Add(ub.Set(t => t.UpdatedAt, DateTime.UtcNow));
        await _db.Teams.UpdateOneAsync(t => t.Id == id, ub.Combine(updates));

        var team = await _db.Teams.Find(t => t.Id == id).FirstOrDefaultAsync();
        await _activity.LogAsync(id, TeamAppKey.Team, userId,
            TeamActivityAction.TeamUpdated, "team", id, team?.Name);
        return Ok(ApiResponse<object>.Ok(team!));
    }

    /// <summary>解散团队（管理员）。owner 的站点移入解散文件夹，其余仅移除团队引用</summary>
    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id)
    {
        var userId = GetUserId();
        if (!await _teams.IsAdminAsync(id, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要管理员权限"));

        var team = await _db.Teams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "团队不存在"));

        var folderName = $"{team.Name} 团队解散文件夹";

        // 网页托管：owner 的站点移入解散文件夹，其他成员站点仅移除引用
        await _db.HostedSites.UpdateManyAsync(
            Builders<HostedSite>.Filter.And(
                Builders<HostedSite>.Filter.AnyEq(x => x.SharedTeamIds, id),
                Builders<HostedSite>.Filter.Eq(x => x.OwnerUserId, team.OwnerUserId)),
            Builders<HostedSite>.Update
                .Pull(x => x.SharedTeamIds, id)
                .Set(x => x.Folder, folderName));
        await _db.HostedSites.UpdateManyAsync(
            Builders<HostedSite>.Filter.And(
                Builders<HostedSite>.Filter.AnyEq(x => x.SharedTeamIds, id),
                Builders<HostedSite>.Filter.Ne(x => x.OwnerUserId, team.OwnerUserId)),
            Builders<HostedSite>.Update.Pull(x => x.SharedTeamIds, id));

        // 知识库：仅移除团队引用
        await _db.DocumentStores.UpdateManyAsync(
            Builders<DocumentStore>.Filter.AnyEq(x => x.SharedTeamIds, id),
            Builders<DocumentStore>.Update.Pull(x => x.SharedTeamIds, id));

        await _db.TeamMembers.DeleteManyAsync(m => m.TeamId == id);
        await _db.TeamActivityLogs.DeleteManyAsync(l => l.TeamId == id);
        await _db.Teams.DeleteOneAsync(t => t.Id == id);

        return Ok(ApiResponse<object>.Ok(new { deleted = true }));
    }

    // ─────────────────────────────────────────────
    // 成员管理
    // ─────────────────────────────────────────────

    /// <summary>直接添加成员（管理员）。支持单个或批量 userIds</summary>
    [HttpPost("{id}/members")]
    public async Task<IActionResult> AddMembers(string id, [FromBody] AddMembersRequest req)
    {
        var userId = GetUserId();
        if (!await _teams.IsAdminAsync(id, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要管理员权限"));

        var team = await _db.Teams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "团队不存在"));

        var targetIds = (req.UserIds ?? new List<string>())
            .Where(u => !string.IsNullOrWhiteSpace(u)).Distinct().ToList();
        if (targetIds.Count == 0)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请提供要添加的用户"));

        var existing = await _db.TeamMembers.Find(m => m.TeamId == id && targetIds.Contains(m.UserId))
            .Project(m => m.UserId).ToListAsync();
        var toAdd = targetIds.Except(existing).ToList();
        if (toAdd.Count == 0)
            return Ok(ApiResponse<object>.Ok(new { added = 0 }));

        var users = await _db.Users.Find(u => toAdd.Contains(u.UserId)).ToListAsync();
        var userMap = users.ToDictionary(u => u.UserId, u => u);

        var newMembers = toAdd.Select(uid => new TeamMember
        {
            TeamId = id,
            UserId = uid,
            UserName = DisplayNameOf(userMap.GetValueOrDefault(uid)),
            AvatarFileName = userMap.GetValueOrDefault(uid)?.AvatarFileName,
            Role = TeamRole.Member,
        }).ToList();
        await _db.TeamMembers.InsertManyAsync(newMembers);

        foreach (var m in newMembers)
            await _activity.LogAsync(id, TeamAppKey.Team, userId,
                TeamActivityAction.MemberAdded, "member", m.UserId, m.UserName);

        return Ok(ApiResponse<object>.Ok(new { added = newMembers.Count, members = newMembers }));
    }

    /// <summary>移除成员（管理员；或成员自己退出）。不允许移除团队创建者</summary>
    [HttpDelete("{id}/members/{memberUserId}")]
    public async Task<IActionResult> RemoveMember(string id, string memberUserId)
    {
        var userId = GetUserId();
        var team = await _db.Teams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "团队不存在"));

        var isSelfLeave = memberUserId == userId;
        if (!isSelfLeave && !await _teams.IsAdminAsync(id, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要管理员权限"));

        if (memberUserId == team.OwnerUserId)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DUPLICATE, "不能移除团队创建者"));

        var member = await _db.TeamMembers.Find(m => m.TeamId == id && m.UserId == memberUserId).FirstOrDefaultAsync();
        if (member == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "成员不存在"));

        await _db.TeamMembers.DeleteOneAsync(m => m.TeamId == id && m.UserId == memberUserId);
        await _activity.LogAsync(id, TeamAppKey.Team, userId,
            TeamActivityAction.MemberRemoved, "member", memberUserId, member.UserName);
        return Ok(ApiResponse<object>.Ok(new { removed = true }));
    }

    /// <summary>修改成员角色（管理员）。不允许降级团队创建者</summary>
    [HttpPut("{id}/members/{memberUserId}")]
    public async Task<IActionResult> UpdateMemberRole(string id, string memberUserId, [FromBody] UpdateMemberRoleRequest req)
    {
        var userId = GetUserId();
        if (!await _teams.IsAdminAsync(id, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要管理员权限"));

        if (!TeamRole.All.Contains(req.Role))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "角色非法"));

        var team = await _db.Teams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "团队不存在"));
        if (memberUserId == team.OwnerUserId && req.Role != TeamRole.Admin)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DUPLICATE, "不能降级团队创建者"));

        var result = await _db.TeamMembers.UpdateOneAsync(
            m => m.TeamId == id && m.UserId == memberUserId,
            Builders<TeamMember>.Update.Set(m => m.Role, req.Role));
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "成员不存在"));

        var member = await _db.TeamMembers.Find(m => m.TeamId == id && m.UserId == memberUserId).FirstOrDefaultAsync();
        await _activity.LogAsync(id, TeamAppKey.Team, userId,
            TeamActivityAction.MemberRoleChanged, "member", memberUserId, member?.UserName);
        return Ok(ApiResponse<object>.Ok(new { updated = true, role = req.Role }));
    }

    /// <summary>
    /// 设置成员的网页托管内容角色（owner/editor/viewer）。仅团队管理员（= 文件夹 owner）可操作。
    /// role 传 null/空 = 重置为继承（admin→owner / member→editor）。仅影响网页托管，不动知识库。
    /// </summary>
    [HttpPut("{id}/members/{memberUserId}/web-hosting-role")]
    public async Task<IActionResult> UpdateMemberWebHostingRole(
        string id, string memberUserId, [FromBody] UpdateWebHostingRoleRequest req)
    {
        var userId = GetUserId();
        if (!await _teams.IsAdminAsync(id, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要管理员权限"));

        var role = string.IsNullOrWhiteSpace(req.Role) ? null : req.Role.Trim().ToLowerInvariant();
        if (role != null && !WebHostingRoles.IsValid(role))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "网页托管角色非法（owner/editor/viewer）"));

        var team = await _db.Teams.Find(t => t.Id == id).FirstOrDefaultAsync();
        if (team == null) return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "团队不存在"));
        // 团队创建者在网页托管里恒为 owner，不允许被降级（与团队角色「不能降级创建者」对齐）
        if (memberUserId == team.OwnerUserId && role != null && role != WebHostingRoles.Owner)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.DUPLICATE, "不能降级团队创建者的网页托管角色"));

        var result = await _db.TeamMembers.UpdateOneAsync(
            m => m.TeamId == id && m.UserId == memberUserId,
            Builders<TeamMember>.Update.Set(m => m.WebHostingRole, role));
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "成员不存在"));

        var member = await _db.TeamMembers.Find(m => m.TeamId == id && m.UserId == memberUserId).FirstOrDefaultAsync();
        var effective = WebHostingRoles.Resolve(member?.WebHostingRole, member?.Role ?? TeamRole.Member);
        await _activity.LogAsync(id, TeamAppKey.WebHosting, userId,
            TeamActivityAction.MemberRoleChanged, "member", memberUserId, member?.UserName);
        return Ok(ApiResponse<object>.Ok(new
        {
            updated = true,
            webHostingRole = role,
            effectiveWebHostingRole = effective,
        }));
    }

    /// <summary>
    /// 设置成员的角色标签（如「前端组」「测试组」）。仅团队管理员可操作。
    /// 标签仅作授权分组用（网页托管分组级权限可按标签批量授权），本身不产生权限。
    /// 传空数组 = 清空标签。
    /// </summary>
    [HttpPut("{id}/members/{memberUserId}/labels")]
    public async Task<IActionResult> UpdateMemberLabels(
        string id, string memberUserId, [FromBody] UpdateMemberLabelsRequest req)
    {
        var userId = GetUserId();
        if (!await _teams.IsAdminAsync(id, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要管理员权限"));

        var labels = (req.Labels ?? new List<string>())
            .Select(l => l?.Trim() ?? string.Empty)
            .Where(l => l.Length > 0)
            .Distinct()
            .ToList();
        if (labels.Count > 20)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "标签数量最多 20 个"));
        if (labels.Any(l => l.Length > 24))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "单个标签最长 24 字"));

        var result = await _db.TeamMembers.UpdateOneAsync(
            m => m.TeamId == id && m.UserId == memberUserId,
            Builders<TeamMember>.Update.Set(m => m.Labels, labels));
        if (result.MatchedCount == 0)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.NOT_FOUND, "成员不存在"));

        return Ok(ApiResponse<object>.Ok(new { updated = true, labels }));
    }

    // ─────────────────────────────────────────────
    // 邀请
    // ─────────────────────────────────────────────

    /// <summary>重新生成邀请码（管理员），可选过期天数</summary>
    [HttpPost("{id}/invite-code")]
    public async Task<IActionResult> RegenerateInviteCode(string id, [FromBody] CreateInviteCodeRequest? req)
    {
        var userId = GetUserId();
        if (!await _teams.IsAdminAsync(id, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "需要管理员权限"));

        var newCode = $"INV-{Guid.NewGuid().ToString("N")[..8].ToUpper()}";
        var days = req?.ExpiresInDays ?? 0;
        DateTime? expireAt = days > 0 ? DateTime.UtcNow.AddDays(days) : (DateTime?)null;

        await _db.Teams.UpdateOneAsync(t => t.Id == id,
            Builders<Team>.Update
                .Set(t => t.InviteCode, newCode)
                .Set(t => t.InviteExpireAt, expireAt)
                .Set(t => t.UpdatedAt, DateTime.UtcNow));

        return Ok(ApiResponse<object>.Ok(new { inviteCode = newCode, inviteExpireAt = expireAt }));
    }

    /// <summary>凭邀请码加入团队</summary>
    [HttpPost("join")]
    public async Task<IActionResult> Join([FromBody] JoinTeamRequest req)
    {
        if (string.IsNullOrWhiteSpace(req.InviteCode))
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVALID_FORMAT, "请输入邀请码"));

        var code = req.InviteCode.Trim().ToUpperInvariant();
        var team = await _db.Teams.Find(t => t.InviteCode == code).FirstOrDefaultAsync();
        if (team == null)
            return NotFound(ApiResponse<object>.Fail(ErrorCodes.INVALID_INVITE_CODE, "邀请码无效"));
        if (team.InviteExpireAt != null && team.InviteExpireAt < DateTime.UtcNow)
            return BadRequest(ApiResponse<object>.Fail(ErrorCodes.INVITE_EXPIRED, "邀请码已过期"));

        var userId = GetUserId();
        var already = await _db.TeamMembers.Find(m => m.TeamId == team.Id && m.UserId == userId).AnyAsync();
        if (already)
            return Ok(ApiResponse<object>.Ok(new { joined = true, teamId = team.Id, alreadyMember = true }));

        var me = await FindUserAsync(userId);
        await _db.TeamMembers.InsertOneAsync(new TeamMember
        {
            TeamId = team.Id,
            UserId = userId,
            UserName = DisplayNameOf(me),
            AvatarFileName = me?.AvatarFileName,
            Role = TeamRole.Member,
        });

        await _activity.LogAsync(team.Id, TeamAppKey.Team, userId,
            TeamActivityAction.MemberJoined, "member", userId, DisplayNameOf(me));

        return Ok(ApiResponse<object>.Ok(new { joined = true, teamId = team.Id, teamName = team.Name }));
    }

    // ─────────────────────────────────────────────
    // 活动日志
    // ─────────────────────────────────────────────

    /// <summary>团队活动日志（成员可见）</summary>
    [HttpGet("{id}/activity")]
    public async Task<IActionResult> Activity(string id, [FromQuery] string? app, [FromQuery] int limit = 100)
    {
        var userId = GetUserId();
        if (!await _teams.IsMemberAsync(id, userId))
            return StatusCode(403, ApiResponse<object>.Fail(ErrorCodes.PERMISSION_DENIED, "不是该团队成员"));

        limit = Math.Clamp(limit, 1, 300);
        var fb = Builders<TeamActivityLog>.Filter;
        var filter = fb.Eq(l => l.TeamId, id);
        if (!string.IsNullOrWhiteSpace(app))
            filter &= fb.Eq(l => l.AppKey, app);

        var logs = await _db.TeamActivityLogs.Find(filter)
            .Sort(Builders<TeamActivityLog>.Sort.Descending(l => l.CreatedAt))
            .Limit(limit)
            .ToListAsync();

        return Ok(ApiResponse<object>.Ok(new { items = logs }));
    }

    // ─────────────────────────────────────────────
    // 用户检索 / 解析（auto 仅登录，不依赖 UsersRead 权限）
    // ─────────────────────────────────────────────

    /// <summary>团队成员添加用：按昵称/用户名搜索用户（轻量，仅登录可用）</summary>
    [HttpGet("search-users")]
    public async Task<IActionResult> SearchUsers([FromQuery] string? q, [FromQuery] int limit = 20)
    {
        limit = Math.Clamp(limit, 1, 50);
        var fb = Builders<User>.Filter;
        var filter = fb.Eq(u => u.Status, UserStatus.Active);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var kw = q.Trim();
            filter &= fb.Or(
                fb.Regex(u => u.DisplayName, new BsonRegularExpression(kw, "i")),
                fb.Regex(u => u.Username, new BsonRegularExpression(kw, "i")));
        }

        var users = await _db.Users.Find(filter).Limit(limit).ToListAsync();
        var items = users.Select(u => new
        {
            userId = u.UserId,
            displayName = DisplayNameOf(u),
            username = u.Username,
            avatarFileName = u.AvatarFileName,
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }

    /// <summary>批量解析用户展示卡（userId → 昵称 + 头像文件名），供成员归属角标兜底渲染</summary>
    [HttpGet("user-cards")]
    public async Task<IActionResult> UserCards([FromQuery] string ids)
    {
        var idList = (ids ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct().ToList();
        if (idList.Count == 0)
            return Ok(ApiResponse<object>.Ok(new { items = new List<object>() }));

        var users = await _db.Users.Find(u => idList.Contains(u.UserId)).ToListAsync();
        var items = users.Select(u => new
        {
            userId = u.UserId,
            displayName = DisplayNameOf(u),
            avatarFileName = u.AvatarFileName,
        }).ToList();
        return Ok(ApiResponse<object>.Ok(new { items }));
    }
}

// ─────────────────────────────────────────────
// 请求 DTO
// ─────────────────────────────────────────────

public class CreateTeamRequest
{
    public string Name { get; set; } = string.Empty;
    public string? Description { get; set; }
    /// <summary>private | public（默认 private）</summary>
    public string? Visibility { get; set; }
}

public class UpdateTeamRequest
{
    public string? Name { get; set; }
    public string? Description { get; set; }
    public string? Visibility { get; set; }
}

public class AddMembersRequest
{
    public List<string>? UserIds { get; set; }
}

public class UpdateMemberRoleRequest
{
    /// <summary>admin | member</summary>
    public string Role { get; set; } = TeamRole.Member;
}

public class UpdateWebHostingRoleRequest
{
    /// <summary>owner | editor | viewer；null/空 = 重置为继承</summary>
    public string? Role { get; set; }
}

public class UpdateMemberLabelsRequest
{
    /// <summary>角色标签全量列表（空数组 = 清空）</summary>
    public List<string>? Labels { get; set; }
}

public class CreateInviteCodeRequest
{
    public int? ExpiresInDays { get; set; }
}

public class JoinTeamRequest
{
    public string InviteCode { get; set; } = string.Empty;
}
