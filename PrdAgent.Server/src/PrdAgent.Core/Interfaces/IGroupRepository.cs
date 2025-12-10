using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 群组仓储接口
/// </summary>
public interface IGroupRepository
{
    Task<Group?> GetByIdAsync(string groupId);
    Task<Group?> GetByInviteCodeAsync(string inviteCode);
    Task InsertAsync(Group group);
    Task UpdateInviteCodeAsync(string groupId, string newCode);
    Task<List<Group>> GetByIdsAsync(List<string> groupIds);
}

/// <summary>
/// 群组成员仓储接口
/// </summary>
public interface IGroupMemberRepository
{
    Task<GroupMember?> GetAsync(string groupId, string userId);
    Task<List<GroupMember>> GetByGroupIdAsync(string groupId);
    Task<List<GroupMember>> GetByUserIdAsync(string userId);
    Task InsertAsync(GroupMember member);
    Task DeleteAsync(string groupId, string userId);
    Task<long> CountByGroupIdAsync(string groupId);
}



