using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 群组服务接口
/// </summary>
public interface IGroupService
{
    /// <summary>创建群组</summary>
    Task<Group> CreateAsync(
        string ownerId,
        string prdDocumentId,
        string? groupName = null,
        string? prdTitleSnapshot = null,
        int? prdTokenEstimateSnapshot = null,
        int? prdCharCountSnapshot = null);
    
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

    /// <summary>绑定 PRD 到群组（仅写入元数据快照；不存原文）</summary>
    Task BindPrdAsync(
        string groupId,
        string prdDocumentId,
        string? prdTitleSnapshot,
        int? prdTokenEstimateSnapshot,
        int? prdCharCountSnapshot);

    /// <summary>解绑 PRD（清空绑定与快照）</summary>
    Task UnbindPrdAsync(string groupId);

    /// <summary>解散群组（删除群组与成员记录）</summary>
    Task DissolveAsync(string groupId);
}
