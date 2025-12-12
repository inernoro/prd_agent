using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Repositories;

/// <summary>
/// 群组仓储实现
/// </summary>
public class GroupRepository : IGroupRepository
{
    private readonly IMongoCollection<Group> _groups;

    public GroupRepository(IMongoCollection<Group> groups)
    {
        _groups = groups;
    }

    public async Task<Group?> GetByIdAsync(string groupId)
    {
        return await _groups.Find(g => g.GroupId == groupId).FirstOrDefaultAsync();
    }

    public async Task<Group?> GetByInviteCodeAsync(string inviteCode)
    {
        return await _groups.Find(g => g.InviteCode == inviteCode).FirstOrDefaultAsync();
    }

    public async Task InsertAsync(Group group)
    {
        await _groups.InsertOneAsync(group);
    }

    public async Task UpdateInviteCodeAsync(string groupId, string newCode)
    {
        await _groups.UpdateOneAsync(
            g => g.GroupId == groupId,
            Builders<Group>.Update.Set(g => g.InviteCode, newCode));
    }

    public async Task<List<Group>> GetByIdsAsync(List<string> groupIds)
    {
        return await _groups.Find(g => groupIds.Contains(g.GroupId)).ToListAsync();
    }
}

/// <summary>
/// 群组成员仓储实现
/// </summary>
public class GroupMemberRepository : IGroupMemberRepository
{
    private readonly IMongoCollection<GroupMember> _members;

    public GroupMemberRepository(IMongoCollection<GroupMember> members)
    {
        _members = members;
    }

    public async Task<GroupMember?> GetAsync(string groupId, string userId)
    {
        return await _members.Find(m => m.GroupId == groupId && m.UserId == userId).FirstOrDefaultAsync();
    }

    public async Task<List<GroupMember>> GetByGroupIdAsync(string groupId)
    {
        return await _members.Find(m => m.GroupId == groupId).ToListAsync();
    }

    public async Task<List<GroupMember>> GetByUserIdAsync(string userId)
    {
        return await _members.Find(m => m.UserId == userId).ToListAsync();
    }

    public async Task InsertAsync(GroupMember member)
    {
        await _members.InsertOneAsync(member);
    }

    public async Task DeleteAsync(string groupId, string userId)
    {
        await _members.DeleteOneAsync(m => m.GroupId == groupId && m.UserId == userId);
    }

    public async Task<long> CountByGroupIdAsync(string groupId)
    {
        return await _members.CountDocumentsAsync(m => m.GroupId == groupId);
    }
}