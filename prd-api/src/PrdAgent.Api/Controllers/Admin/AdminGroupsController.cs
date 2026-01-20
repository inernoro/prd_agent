using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Core.Security;

namespace PrdAgent.Api.Controllers.Admin;

/// <summary>
/// 管理后台 - 群组管理控制器
/// </summary>
[ApiController]
[Route("api/v1/admin/groups")]
[Authorize]
[AdminController("admin-groups", AdminPermissionCatalog.GroupsRead, WritePermission = AdminPermissionCatalog.GroupsWrite)]
public class AdminGroupsController : ControllerBase
{
    private readonly MongoDbContext _db;
    private readonly ILogger<AdminGroupsController> _logger;
    private readonly ICacheManager _cache;

    public AdminGroupsController(MongoDbContext db, ICacheManager cache, ILogger<AdminGroupsController> logger)
    {
        _db = db;
        _cache = cache;
        _logger = logger;
    }

    /// <summary>
    /// 获取群组列表（分页）
    /// </summary>
    [HttpGet]
    [ProducesResponseType(typeof(ApiResponse<AdminPagedResult<AdminGroupListItem>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetGroups(
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? search = null,
        [FromQuery] string? inviteStatus = null,
        [FromQuery] string? sort = null)
    {
        if (page <= 0) page = 1;
        if (pageSize <= 0) pageSize = 20;
        if (pageSize > 100) pageSize = 100;

        var filter = Builders<Group>.Filter.Empty;
        var now = DateTime.UtcNow;

        // 邀请状态筛选
        if (!string.IsNullOrEmpty(inviteStatus))
        {
            var s = inviteStatus.Trim().ToLowerInvariant();
            if (s == "valid")
            {
                filter &= Builders<Group>.Filter.Or(
                    Builders<Group>.Filter.Eq(g => g.InviteExpireAt, null),
                    Builders<Group>.Filter.Gt(g => g.InviteExpireAt, now));
            }
            else if (s == "expired")
            {
                filter &= Builders<Group>.Filter.And(
                    Builders<Group>.Filter.Ne(g => g.InviteExpireAt, null),
                    Builders<Group>.Filter.Lte(g => g.InviteExpireAt, now));
            }
        }

        // 搜索：群组名/群组ID/群主用户名&昵称（ownerId in ...）
        if (!string.IsNullOrWhiteSpace(search))
        {
            var q = search.Trim();
            var regex = new BsonRegularExpression(q, "i");

            var groupNameOrId = Builders<Group>.Filter.Or(
                Builders<Group>.Filter.Regex(g => g.GroupName, regex),
                Builders<Group>.Filter.Regex(g => g.GroupId, regex));

            // owner: 先在 users 中匹配 username/displayName
            var matchedOwners = await _db.Users.Find(Builders<User>.Filter.Or(
                    Builders<User>.Filter.Regex(u => u.Username, regex),
                    Builders<User>.Filter.Regex(u => u.DisplayName, regex)))
                .Project(u => u.UserId)
                .Limit(200)
                .ToListAsync();

            if (matchedOwners.Count > 0)
            {
                var ownerIn = Builders<Group>.Filter.In(g => g.OwnerId, matchedOwners);
                filter &= Builders<Group>.Filter.Or(groupNameOrId, ownerIn);
            }
            else
            {
                filter &= groupNameOrId;
            }
        }

        // 先把过滤后的 group 拉出来，再做聚合统计与排序（便于快速落地，后续可优化为 Mongo 聚合分页）
        var groups = await _db.Groups.Find(filter).ToListAsync();

        var groupIds = groups.Select(g => g.GroupId).ToList();
        var stats = groupIds.Count == 0
            ? new AdminGroupStatsMaps()
            : await LoadGroupStatsAsync(groupIds);

        // 排序（默认 recent）
        var sortKey = (sort ?? "recent").Trim().ToLowerInvariant();
        groups = sortKey switch
        {
            "created" => groups.OrderByDescending(g => g.CreatedAt).ToList(),
            "gaps" => groups.OrderByDescending(g => stats.PendingGaps.TryGetValue(g.GroupId, out var c) ? c : 0).ThenByDescending(g => g.CreatedAt).ToList(),
            "messages" => groups.OrderByDescending(g => stats.MessageCounts.TryGetValue(g.GroupId, out var c) ? c : 0).ThenByDescending(g => g.CreatedAt).ToList(),
            _ => groups.OrderByDescending(g => stats.LastMessageAt.TryGetValue(g.GroupId, out var t) ? t : DateTime.MinValue).ThenByDescending(g => g.CreatedAt).ToList(),
        };

        var total = groups.Count;
        var pageItems = groups.Skip((page - 1) * pageSize).Take(pageSize).ToList();

        // owners
        var ownerIds = pageItems.Select(g => g.OwnerId).Where(x => !string.IsNullOrEmpty(x)).Distinct().ToList();
        var owners = await _db.Users.Find(u => ownerIds.Contains(u.UserId)).ToListAsync();
        var ownerMap = owners.ToDictionary(u => u.UserId, u => u);

        var items = pageItems.Select(g =>
        {
            ownerMap.TryGetValue(g.OwnerId, out var owner);
            stats.MemberCounts.TryGetValue(g.GroupId, out var memberCount);
            stats.MessageCounts.TryGetValue(g.GroupId, out var messageCount);
            stats.PendingGaps.TryGetValue(g.GroupId, out var pendingGapCount);
            stats.LastMessageAt.TryGetValue(g.GroupId, out var lastMessageAt);

            return new AdminGroupListItem
            {
                GroupId = g.GroupId,
                GroupName = g.GroupName,
                Owner = owner == null
                    ? null
                    : new AdminGroupOwner
                    {
                        UserId = owner.UserId,
                        Username = owner.Username,
                        DisplayName = owner.DisplayName,
                        Role = owner.Role.ToString()
                    },
                MemberCount = (int)(memberCount == 0 ? 0 : memberCount),
                PrdTitleSnapshot = g.PrdTitleSnapshot,
                PrdTokenEstimateSnapshot = g.PrdTokenEstimateSnapshot,
                PrdCharCountSnapshot = g.PrdCharCountSnapshot,
                InviteCode = g.InviteCode,
                InviteExpireAt = g.InviteExpireAt,
                MaxMembers = g.MaxMembers,
                CreatedAt = g.CreatedAt,
                LastMessageAt = lastMessageAt == default ? null : lastMessageAt,
                MessageCount = (int)(messageCount == 0 ? 0 : messageCount),
                PendingGapCount = (int)(pendingGapCount == 0 ? 0 : pendingGapCount)
            };
        }).ToList();

        var response = new AdminPagedResult<AdminGroupListItem>
        {
            Items = items,
            Total = total,
            Page = page,
            PageSize = pageSize
        };

        return Ok(ApiResponse<AdminPagedResult<AdminGroupListItem>>.Ok(response));
    }

    /// <summary>
    /// 获取群组详情
    /// </summary>
    [HttpGet("{groupId}")]
    [ProducesResponseType(typeof(ApiResponse<AdminGroupListItem>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetGroup(string groupId)
    {
        var group = await _db.Groups.Find(g => g.GroupId == groupId).FirstOrDefaultAsync();
        if (group == null) return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "群组不存在"));

        var stats = await LoadGroupStatsAsync(new List<string> { groupId });
        var owner = await _db.Users.Find(u => u.UserId == group.OwnerId).FirstOrDefaultAsync();

        stats.MemberCounts.TryGetValue(groupId, out var memberCount);
        stats.MessageCounts.TryGetValue(groupId, out var messageCount);
        stats.PendingGaps.TryGetValue(groupId, out var pendingGapCount);
        stats.LastMessageAt.TryGetValue(groupId, out var lastMessageAt);

        var dto = new AdminGroupListItem
        {
            GroupId = group.GroupId,
            GroupName = group.GroupName,
            Owner = owner == null
                ? null
                : new AdminGroupOwner
                {
                    UserId = owner.UserId,
                    Username = owner.Username,
                    DisplayName = owner.DisplayName,
                    Role = owner.Role.ToString()
                },
            MemberCount = (int)memberCount,
            PrdTitleSnapshot = group.PrdTitleSnapshot,
            PrdTokenEstimateSnapshot = group.PrdTokenEstimateSnapshot,
            PrdCharCountSnapshot = group.PrdCharCountSnapshot,
            InviteCode = group.InviteCode,
            InviteExpireAt = group.InviteExpireAt,
            MaxMembers = group.MaxMembers,
            CreatedAt = group.CreatedAt,
            LastMessageAt = lastMessageAt == default ? null : lastMessageAt,
            MessageCount = (int)messageCount,
            PendingGapCount = (int)pendingGapCount
        };

        return Ok(ApiResponse<AdminGroupListItem>.Ok(dto));
    }

    /// <summary>
    /// 获取群组成员列表
    /// </summary>
    [HttpGet("{groupId}/members")]
    [ProducesResponseType(typeof(ApiResponse<List<AdminGroupMemberDto>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetMembers(string groupId)
    {
        var group = await _db.Groups.Find(g => g.GroupId == groupId).FirstOrDefaultAsync();
        if (group == null) return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "群组不存在"));

        var members = await _db.GroupMembers.Find(m => m.GroupId == groupId).ToListAsync();
        var userIds = members.Select(m => m.UserId).Distinct().ToList();
        var users = await _db.Users.Find(u => userIds.Contains(u.UserId)).ToListAsync();
        var userMap = users.ToDictionary(u => u.UserId, u => u);

        var response = members
            .OrderByDescending(m => m.JoinedAt)
            .Select(m =>
            {
                userMap.TryGetValue(m.UserId, out var u);
                return new AdminGroupMemberDto
                {
                    UserId = m.UserId,
                    Username = u?.Username ?? "",
                    DisplayName = u?.DisplayName ?? "",
                    Role = (u?.Role ?? m.MemberRole).ToString(),
                    JoinedAt = m.JoinedAt,
                    IsOwner = m.UserId == group.OwnerId
                };
            })
            .ToList();

        return Ok(ApiResponse<List<AdminGroupMemberDto>>.Ok(response));
    }

    /// <summary>
    /// 移除群组成员
    /// </summary>
    [HttpDelete("{groupId}/members/{userId}")]
    public async Task<IActionResult> RemoveMember(string groupId, string userId)
    {
        var group = await _db.Groups.Find(g => g.GroupId == groupId).FirstOrDefaultAsync();
        if (group == null) return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "群组不存在"));
        if (userId == group.OwnerId) return BadRequest(ApiResponse<object>.Fail("CANNOT_REMOVE_OWNER", "不能移除群主"));

        await _db.GroupMembers.DeleteOneAsync(m => m.GroupId == groupId && m.UserId == userId);
        _logger.LogInformation("Admin removed member from group: groupId={GroupId}, userId={UserId}", groupId, userId);
        return NoContent();
    }

    /// <summary>
    /// 重新生成邀请码
    /// </summary>
    [HttpPost("{groupId}/regenerate-invite")]
    [ProducesResponseType(typeof(ApiResponse<AdminRegenerateInviteResponse>), StatusCodes.Status200OK)]
    public async Task<IActionResult> RegenerateInvite(string groupId)
    {
        var group = await _db.Groups.Find(g => g.GroupId == groupId).FirstOrDefaultAsync();
        if (group == null) return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "群组不存在"));

        var newCode = $"INV-{Guid.NewGuid().ToString("N")[..8].ToUpperInvariant()}";
        await _db.Groups.UpdateOneAsync(
            g => g.GroupId == groupId,
            Builders<Group>.Update.Set(g => g.InviteCode, newCode));

        _logger.LogInformation("Admin regenerated invite code: groupId={GroupId}", groupId);

        var response = new AdminRegenerateInviteResponse
        {
            InviteCode = newCode,
            InviteLink = $"prdagent://join/{newCode}",
            InviteExpireAt = group.InviteExpireAt
        };

        return Ok(ApiResponse<AdminRegenerateInviteResponse>.Ok(response));
    }

    /// <summary>
    /// 更新群组配置
    /// </summary>
    [HttpPut("{groupId}")]
    public async Task<IActionResult> UpdateGroup(string groupId, [FromBody] AdminUpdateGroupRequest request)
    {
        var group = await _db.Groups.Find(g => g.GroupId == groupId).FirstOrDefaultAsync();
        if (group == null) return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "群组不存在"));

        var update = Builders<Group>.Update.Combine();
        var hasUpdate = false;

        if (request.GroupName != null)
        {
            if (string.IsNullOrWhiteSpace(request.GroupName) || request.GroupName.Length > 50)
                return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "群组名称不能为空且不能超过50字符"));
            update = update.Set(g => g.GroupName, request.GroupName.Trim());
            hasUpdate = true;
        }

        if (request.InviteExpireAt.HasValue)
        {
            update = update.Set(g => g.InviteExpireAt, request.InviteExpireAt.Value);
            hasUpdate = true;
        }
        else if (request.InviteExpireAtIsNull == true)
        {
            update = update.Set(g => g.InviteExpireAt, null);
            hasUpdate = true;
        }

        if (request.MaxMembers.HasValue)
        {
            if (request.MaxMembers.Value <= 0 || request.MaxMembers.Value > 5000)
                return BadRequest(ApiResponse<object>.Fail("INVALID_FORMAT", "最大成员数需在 1-5000 之间"));
            update = update.Set(g => g.MaxMembers, request.MaxMembers.Value);
            hasUpdate = true;
        }

        if (hasUpdate)
        {
            await _db.Groups.UpdateOneAsync(g => g.GroupId == groupId, update);
            _logger.LogInformation("Admin updated group: groupId={GroupId}", groupId);
        }

        return NoContent();
    }

    /// <summary>
    /// 删除群组（级联删除成员/缺失/消息）
    /// </summary>
    [HttpDelete("{groupId}")]
    public async Task<IActionResult> DeleteGroup(string groupId)
    {
        var group = await _db.Groups.Find(g => g.GroupId == groupId).FirstOrDefaultAsync();
        if (group == null) return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "群组不存在"));

        await _db.GroupMembers.DeleteManyAsync(m => m.GroupId == groupId);
        await _db.ContentGaps.DeleteManyAsync(g => g.GroupId == groupId);
        await _db.Messages.DeleteManyAsync(m => m.GroupId == groupId);
        await _db.Groups.DeleteOneAsync(g => g.GroupId == groupId);

        _logger.LogInformation("Admin deleted group: groupId={GroupId}", groupId);
        return NoContent();
    }

    /// <summary>
    /// 获取群组消息（分页 + 可选关键字检索）
    /// </summary>
    [HttpGet("{groupId}/messages")]
    [ProducesResponseType(typeof(ApiResponse<AdminPagedResult<AdminMessageDto>>), StatusCodes.Status200OK)]
    public async Task<IActionResult> GetMessages(
        string groupId,
        [FromQuery] int page = 1,
        [FromQuery] int pageSize = 20,
        [FromQuery] string? q = null)
    {
        if (page <= 0) page = 1;
        if (pageSize <= 0) pageSize = 20;
        if (pageSize > 100) pageSize = 100;

        var group = await _db.Groups.Find(g => g.GroupId == groupId).FirstOrDefaultAsync();
        if (group == null) return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "群组不存在"));

        var filter = Builders<Message>.Filter.Eq(m => m.GroupId, groupId);
        if (!string.IsNullOrWhiteSpace(q))
        {
            var regex = new BsonRegularExpression(q.Trim(), "i");
            filter &= Builders<Message>.Filter.Regex(m => m.Content, regex);
        }

        var total = await _db.Messages.CountDocumentsAsync(filter);
        var msgs = await _db.Messages.Find(filter)
            .SortByDescending(m => m.Timestamp)
            .Skip((page - 1) * pageSize)
            .Limit(pageSize)
            .ToListAsync();

        // 批量补齐 senderName/senderRole（避免 N+1）
        var senderIds = msgs
            .Select(m => m.SenderId)
            .Where(x => !string.IsNullOrWhiteSpace(x))
            .Distinct()
            .ToList();
        var senderNameMap = new Dictionary<string, string>(StringComparer.Ordinal);
        var senderRoleMap = new Dictionary<string, UserRole>(StringComparer.Ordinal);
        if (senderIds.Count > 0)
        {
            var users = await _db.Users
                .Find(u => senderIds.Contains(u.UserId))
                .Project(u => new { u.UserId, u.DisplayName, u.Username, u.Role })
                .ToListAsync();
            foreach (var u in users)
            {
                var name = (u.DisplayName ?? u.Username ?? u.UserId ?? string.Empty).Trim();
                if (!string.IsNullOrWhiteSpace(u.UserId) && !string.IsNullOrWhiteSpace(name))
                {
                    senderNameMap[u.UserId] = name;
                }
                if (!string.IsNullOrWhiteSpace(u.UserId))
                {
                    senderRoleMap[u.UserId] = u.Role;
                }
            }
        }

        // 从新到旧返回；前端可自行反转展示
        var items = msgs.Select(m => new AdminMessageDto
        {
            Id = m.Id,
            GroupId = m.GroupId,
            SessionId = m.SessionId,
            SenderId = m.SenderId,
            SenderName = m.SenderId != null && senderNameMap.TryGetValue(m.SenderId, out var nm) ? nm : null,
            SenderRole = m.SenderId != null && senderRoleMap.TryGetValue(m.SenderId, out var rr) ? rr.ToString() : null,
            Role = m.Role.ToString(),
            Content = m.Content,
            LlmRequestId = m.LlmRequestId,
            ViewRole = m.ViewRole?.ToString(),
            Timestamp = m.Timestamp,
            TokenUsage = m.TokenUsage == null ? null : new AdminTokenUsageDto { Input = m.TokenUsage.Input, Output = m.TokenUsage.Output }
        }).ToList();

        var response = new AdminPagedResult<AdminMessageDto>
        {
            Items = items,
            Total = (int)total,
            Page = page,
            PageSize = pageSize
        };

        return Ok(ApiResponse<AdminPagedResult<AdminMessageDto>>.Ok(response));
    }

    /// <summary>
    /// 清空群组所有聊天消息（仅删除 messages；保留群组/成员/缺失）
    /// </summary>
    /// <remarks>
    /// - 仅 ADMIN 可操作
    /// - 会清理该群的 LLM 上下文缓存与 reset marker，避免“删除后仍带旧上下文”
    /// </remarks>
    [HttpDelete("{groupId}/messages")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public async Task<IActionResult> DeleteAllMessages(string groupId)
    {
        groupId = (groupId ?? string.Empty).Trim();
        var group = await _db.Groups.Find(g => g.GroupId == groupId).FirstOrDefaultAsync();
        if (group == null) return NotFound(ApiResponse<object>.Fail("GROUP_NOT_FOUND", "群组不存在"));

        // 删除所有 messages（包括已软删的历史轮次）
        await _db.Messages.DeleteManyAsync(m => m.GroupId == groupId);

        // 清理群组上下文缓存（LLM 上下文拼接用）
        try
        {
            await _cache.RemoveAsync(CacheKeys.ForGroupChatHistory(groupId));
            await _cache.RemoveAsync(CacheKeys.ForGroupContextReset(groupId));
        }
        catch
        {
            // cache 清理失败不应影响主流程
        }

        _logger.LogInformation("Admin cleared all group messages: groupId={GroupId}", groupId);
        return NoContent();
    }

    private async Task<AdminGroupStatsMaps> LoadGroupStatsAsync(List<string> groupIds)
    {
        var memberCounts = await _db.GroupMembers.Aggregate()
            .Match(m => groupIds.Contains(m.GroupId))
            .Group(m => m.GroupId, g => new { GroupId = g.Key, Count = g.Count() })
            .ToListAsync();

        var messageAgg = await _db.Messages.Aggregate()
            .Match(m => groupIds.Contains(m.GroupId))
            .Group(m => m.GroupId, g => new { GroupId = g.Key, Count = g.Count(), Last = g.Max(x => x.Timestamp) })
            .ToListAsync();

        var pendingGaps = await _db.ContentGaps.Aggregate()
            .Match(g => groupIds.Contains(g.GroupId) && g.Status == GapStatus.Pending)
            .Group(g => g.GroupId, gg => new { GroupId = gg.Key, Count = gg.Count() })
            .ToListAsync();

        return new AdminGroupStatsMaps
        {
            MemberCounts = memberCounts.ToDictionary(x => x.GroupId, x => (long)x.Count),
            MessageCounts = messageAgg.ToDictionary(x => x.GroupId, x => (long)x.Count),
            LastMessageAt = messageAgg.ToDictionary(x => x.GroupId, x => x.Last),
            PendingGaps = pendingGaps.ToDictionary(x => x.GroupId, x => (long)x.Count)
        };
    }
}

public class AdminPagedResult<T>
{
    public List<T> Items { get; set; } = new();
    public int Total { get; set; }
    public int Page { get; set; }
    public int PageSize { get; set; }
}

public class AdminGroupOwner
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
}

public class AdminGroupListItem
{
    public string GroupId { get; set; } = string.Empty;
    public string GroupName { get; set; } = string.Empty;
    public AdminGroupOwner? Owner { get; set; }
    public int MemberCount { get; set; }
    public string? PrdTitleSnapshot { get; set; }
    public int? PrdTokenEstimateSnapshot { get; set; }
    public int? PrdCharCountSnapshot { get; set; }
    public string InviteCode { get; set; } = string.Empty;
    public DateTime? InviteExpireAt { get; set; }
    public int MaxMembers { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime? LastMessageAt { get; set; }
    public int MessageCount { get; set; }
    public int PendingGapCount { get; set; }
}

public class AdminGroupMemberDto
{
    public string UserId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
    public DateTime JoinedAt { get; set; }
    public bool IsOwner { get; set; }
}

public class AdminRegenerateInviteResponse
{
    public string InviteCode { get; set; } = string.Empty;
    public string InviteLink { get; set; } = string.Empty;
    public DateTime? InviteExpireAt { get; set; }
}

public class AdminUpdateGroupRequest
{
    public string? GroupName { get; set; }

    // 由于 JSON 反序列化无法区分“未传 inviteExpireAt”与“传 null”，这里用辅助字段表达置空意图
    public DateTime? InviteExpireAt { get; set; }
    public bool? InviteExpireAtIsNull { get; set; }

    public int? MaxMembers { get; set; }
}

internal class AdminGroupStatsMaps
{
    public Dictionary<string, long> MemberCounts { get; set; } = new();
    public Dictionary<string, long> MessageCounts { get; set; } = new();
    public Dictionary<string, DateTime> LastMessageAt { get; set; } = new();
    public Dictionary<string, long> PendingGaps { get; set; } = new();
}

public class AdminMessageDto
{
    public string Id { get; set; } = string.Empty;
    public string GroupId { get; set; } = string.Empty;
    public string SessionId { get; set; } = string.Empty;
    public string? SenderId { get; set; }
    public string? SenderName { get; set; }
    public string? SenderRole { get; set; }
    public string Role { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
    public string? LlmRequestId { get; set; }
    public string? ViewRole { get; set; }
    public DateTime Timestamp { get; set; }
    public AdminTokenUsageDto? TokenUsage { get; set; }
}

public class AdminTokenUsageDto
{
    public int Input { get; set; }
    public int Output { get; set; }
}


