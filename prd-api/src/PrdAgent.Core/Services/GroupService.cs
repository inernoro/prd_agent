using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 群组服务实现
/// </summary>
public class GroupService : IGroupService
{
    private readonly IGroupRepository _groupRepository;
    private readonly IGroupMemberRepository _memberRepository;
    private readonly IPrdDocumentRepository _documentRepository;

    public GroupService(
        IGroupRepository groupRepository,
        IGroupMemberRepository memberRepository,
        IPrdDocumentRepository documentRepository)
    {
        _groupRepository = groupRepository;
        _memberRepository = memberRepository;
        _documentRepository = documentRepository;
    }

    public async Task<Group> CreateAsync(
        string ownerId,
        string prdDocumentId,
        string? groupName = null,
        string? prdTitleSnapshot = null,
        int? prdTokenEstimateSnapshot = null,
        int? prdCharCountSnapshot = null)
    {
        var group = new Group
        {
            OwnerId = ownerId,
            PrdDocumentId = prdDocumentId,
            GroupName = groupName ?? "新建群组",
            PrdTitleSnapshot = prdTitleSnapshot,
            PrdTokenEstimateSnapshot = prdTokenEstimateSnapshot,
            PrdCharCountSnapshot = prdCharCountSnapshot
        };

        await _groupRepository.InsertAsync(group);

        // 添加创建者为群组成员
        var member = new GroupMember
        {
            GroupId = group.GroupId,
            UserId = ownerId,
            MemberRole = UserRole.PM
        };

        await _memberRepository.InsertAsync(member);

        return group;
    }

    public async Task<Group?> GetByIdAsync(string groupId)
    {
        return await _groupRepository.GetByIdAsync(groupId);
    }

    public async Task<Group?> GetByInviteCodeAsync(string inviteCode)
    {
        return await _groupRepository.GetByInviteCodeAsync(inviteCode);
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
        var existingMember = await _memberRepository.GetAsync(group.GroupId, userId);
        if (existingMember != null)
        {
            throw new ArgumentException("您已是该群组成员");
        }

        // 检查群组是否已满
        var memberCount = await _memberRepository.CountByGroupIdAsync(group.GroupId);
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

        await _memberRepository.InsertAsync(member);

        return member;
    }

    public async Task<List<GroupMember>> GetMembersAsync(string groupId)
    {
        return await _memberRepository.GetByGroupIdAsync(groupId);
    }

    public async Task<bool> IsMemberAsync(string groupId, string userId)
    {
        var member = await _memberRepository.GetAsync(groupId, userId);
        return member != null;
    }

    public async Task RemoveMemberAsync(string groupId, string userId)
    {
        await _memberRepository.DeleteAsync(groupId, userId);
    }

    public async Task<string> RegenerateInviteCodeAsync(string groupId)
    {
        var newCode = $"INV-{Guid.NewGuid().ToString("N")[..8].ToUpper()}";
        await _groupRepository.UpdateInviteCodeAsync(groupId, newCode);
        return newCode;
    }

    public async Task<List<Group>> GetUserGroupsAsync(string userId)
    {
        // 获取用户所在的群组ID列表
        var memberRecords = await _memberRepository.GetByUserIdAsync(userId);
        var groupIds = memberRecords.Select(m => m.GroupId).ToList();

        // 获取群组信息
        return await _groupRepository.GetByIdsAsync(groupIds);
    }

    public async Task BindPrdAsync(
        string groupId,
        string prdDocumentId,
        string? prdTitleSnapshot,
        int? prdTokenEstimateSnapshot,
        int? prdCharCountSnapshot)
    {
        await _groupRepository.UpdatePrdAsync(
            groupId,
            prdDocumentId,
            prdTitleSnapshot,
            prdTokenEstimateSnapshot,
            prdCharCountSnapshot);
    }

    public async Task UnbindPrdAsync(string groupId)
    {
        await _groupRepository.ClearPrdAsync(groupId);
    }

    public async Task DissolveAsync(string groupId)
    {
        // 先读出群组，拿到 prdDocumentId，便于后续做引用清理
        var group = await _groupRepository.GetByIdAsync(groupId);
        var prdDocumentId = group?.PrdDocumentId;

        // 删除成员记录（先删成员，避免残留无主成员）
        await _memberRepository.DeleteByGroupIdAsync(groupId);
        // 删除群组
        await _groupRepository.DeleteAsync(groupId);

        // 业务规则：PRD 文档随时可被查看，默认不应“自己消失”；
        // 只有当群组被人为删除/解散，且无任何群组再引用该 PRD 时，才允许清理文档。
        if (!string.IsNullOrWhiteSpace(prdDocumentId))
        {
            var refs = await _groupRepository.CountByPrdDocumentIdAsync(prdDocumentId);
            if (refs == 0)
            {
                await _documentRepository.DeleteAsync(prdDocumentId);
            }
        }
    }
}
