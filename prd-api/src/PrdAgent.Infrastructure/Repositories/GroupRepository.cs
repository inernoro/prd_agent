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

    public async Task DeleteAsync(string groupId)
    {
        await _groups.DeleteOneAsync(g => g.GroupId == groupId);
    }

    public async Task<long> CountByPrdDocumentIdAsync(string prdDocumentId)
    {
        return await _groups.CountDocumentsAsync(g => g.PrdDocumentId == prdDocumentId);
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

    public async Task UpdatePrdAsync(
        string groupId,
        string prdDocumentId,
        string? prdTitleSnapshot,
        int? prdTokenEstimateSnapshot,
        int? prdCharCountSnapshot)
    {
        var update = Builders<Group>.Update
            .Set(g => g.PrdDocumentId, prdDocumentId)
            .Set(g => g.PrdTitleSnapshot, prdTitleSnapshot)
            .Set(g => g.PrdTokenEstimateSnapshot, prdTokenEstimateSnapshot)
            .Set(g => g.PrdCharCountSnapshot, prdCharCountSnapshot);

        await _groups.UpdateOneAsync(g => g.GroupId == groupId, update);
    }

    public async Task ClearPrdAsync(string groupId)
    {
        var update = Builders<Group>.Update
            .Set(g => g.PrdDocumentId, "")
            .Set(g => g.PrdTitleSnapshot, null)
            .Set(g => g.PrdTokenEstimateSnapshot, null)
            .Set(g => g.PrdCharCountSnapshot, null);

        await _groups.UpdateOneAsync(g => g.GroupId == groupId, update);
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

    public async Task DeleteByGroupIdAsync(string groupId)
    {
        await _members.DeleteManyAsync(m => m.GroupId == groupId);
    }

    public async Task<long> CountByGroupIdAsync(string groupId)
    {
        return await _members.CountDocumentsAsync(m => m.GroupId == groupId);
    }
}
