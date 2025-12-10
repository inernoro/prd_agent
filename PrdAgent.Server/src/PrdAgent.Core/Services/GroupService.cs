using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 群组服务实现
/// </summary>
public class GroupService : IGroupService
{
    private readonly IMongoCollection<Group> _groups;
    private readonly IMongoCollection<GroupMember> _members;

    public GroupService(
        IMongoCollection<Group> groups,
        IMongoCollection<GroupMember> members)
    {
        _groups = groups;
        _members = members;
    }

    public async Task<Group> CreateAsync(string ownerId, string prdDocumentId, string? groupName = null)
    {
        var group = new Group
        {
            OwnerId = ownerId,
            PrdDocumentId = prdDocumentId,
            GroupName = groupName ?? "新建群组"
        };

        await _groups.InsertOneAsync(group);

        // 添加创建者为群组成员
        var member = new GroupMember
        {
            GroupId = group.GroupId,
            UserId = ownerId,
            MemberRole = UserRole.PM
        };

        await _members.InsertOneAsync(member);

        return group;
    }

    public async Task<Group?> GetByIdAsync(string groupId)
    {
        return await _groups.Find(g => g.GroupId == groupId).FirstOrDefaultAsync();
    }

    public async Task<Group?> GetByInviteCodeAsync(string inviteCode)
    {
        return await _groups.Find(g => g.InviteCode == inviteCode).FirstOrDefaultAsync();
    }

    public async Task<GroupMember> JoinAsync(string inviteCode, string userId, UserRole memberRole)
    {
        var group = await GetByInviteCodeAsync(inviteCode)
            ?? throw new ArgumentException("邀请码无效");

        // 检查邀请码是否过期
        if (group.InviteExpireAt.HasValue && group.InviteExpireAt.Value < DateTime.UtcNow)
        {
            throw new ArgumentException("邀请码已过期");
        }

        // 检查是否已是成员
        var existingMember = await _members.Find(m => 
            m.GroupId == group.GroupId && m.UserId == userId).FirstOrDefaultAsync();
        
        if (existingMember != null)
        {
            throw new ArgumentException("您已是该群组成员");
        }

        // 检查群组是否已满
        var memberCount = await _members.CountDocumentsAsync(m => m.GroupId == group.GroupId);
        if (memberCount >= group.MaxMembers)
        {
            throw new ArgumentException("群组已满");
        }

        // 添加成员
        var member = new GroupMember
        {
            GroupId = group.GroupId,
            UserId = userId,
            MemberRole = memberRole
        };

        await _members.InsertOneAsync(member);

        return member;
    }

    public async Task<List<GroupMember>> GetMembersAsync(string groupId)
    {
        return await _members.Find(m => m.GroupId == groupId).ToListAsync();
    }

    public async Task<bool> IsMemberAsync(string groupId, string userId)
    {
        var member = await _members.Find(m => 
            m.GroupId == groupId && m.UserId == userId).FirstOrDefaultAsync();
        return member != null;
    }

    public async Task RemoveMemberAsync(string groupId, string userId)
    {
        await _members.DeleteOneAsync(m => m.GroupId == groupId && m.UserId == userId);
    }

    public async Task<string> RegenerateInviteCodeAsync(string groupId)
    {
        var newCode = $"INV-{Guid.NewGuid().ToString("N")[..8].ToUpper()}";
        
        await _groups.UpdateOneAsync(
            g => g.GroupId == groupId,
            Builders<Group>.Update.Set(g => g.InviteCode, newCode));

        return newCode;
    }

    public async Task<List<Group>> GetUserGroupsAsync(string userId)
    {
        // 获取用户所在的群组ID列表
        var memberRecords = await _members.Find(m => m.UserId == userId).ToListAsync();
        var groupIds = memberRecords.Select(m => m.GroupId).ToList();

        // 获取群组信息
        return await _groups.Find(g => groupIds.Contains(g.GroupId)).ToListAsync();
    }
}

