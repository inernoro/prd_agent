using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 群组服务接口
/// </summary>
public interface IGroupService
{
    /// <summary>创建群组</summary>
    Task<Group> CreateAsync(string ownerId, string? groupName = null);
    
    /// <summary>根据ID获取群组</summary>
    Task<Group?> GetByIdAsync(string groupId);
    
    /// <summary>根据邀请码获取群组</summary>
    Task<Group?> GetByInviteCodeAsync(string inviteCode);
    
    /// <summary>加入群组</summary>
    Task<GroupMember> JoinAsync(string inviteCode, string userId, UserRole memberRole);
    
    /// <summary>获取群组成员列表</summary>
    Task<List<GroupMember>> GetMembersAsync(string groupId);
    
    /// <summary>检查用户是否为群组成员</summary>
    Task<bool> IsMemberAsync(string groupId, string userId);
    
    /// <summary>移除成员</summary>
    Task RemoveMemberAsync(string groupId, string userId);
    
    /// <summary>重新生成邀请码</summary>
    Task<string> RegenerateInviteCodeAsync(string groupId);
    
    /// <summary>获取用户的群组列表</summary>
    Task<List<Group>> GetUserGroupsAsync(string userId);

    /// <summary>更新群组知识库状态</summary>
    Task UpdateKbStatusAsync(string groupId, bool hasKb, int docCount);

    /// <summary>解散群组（删除群组与成员记录）</summary>
    Task DissolveAsync(string groupId);

    /// <summary>更新群组名称</summary>
    Task UpdateGroupNameAsync(string groupId, string groupName);
}
