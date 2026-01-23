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
    private readonly IIdGenerator _idGenerator;

    public GroupService(
        IGroupRepository groupRepository,
        IGroupMemberRepository memberRepository,
        IIdGenerator idGenerator)
    {
        _groupRepository = groupRepository;
        _memberRepository = memberRepository;
        _idGenerator = idGenerator;
    }

    public async Task<Group> CreateAsync(string ownerId, string? groupName = null)
    {
        var group = new Group
        {
            GroupId = await _idGenerator.GenerateIdAsync("group"),
            OwnerId = ownerId,
            GroupName = groupName ?? "新建群组",
            HasKnowledgeBase = false,
            KbDocumentCount = 0
        };

        await _groupRepository.InsertAsync(group);

        // 添加创建者为群组成员
        var member = new GroupMember
        {
            GroupId = group.GroupId,
            UserId = ownerId,
            MemberRole = UserRole.PM,
            Tags = BuildDefaultHumanTags(UserRole.PM)
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

        if (group.InviteExpireAt.HasValue && group.InviteExpireAt.Value < DateTime.UtcNow)
        {
            throw new ArgumentException("邀请码已过期");
        }

        var existingMember = await _memberRepository.GetAsync(group.GroupId, userId);
        if (existingMember != null)
        {
            throw new ArgumentException("您已是该群组成员");
        }

        var memberCount = await _memberRepository.CountByGroupIdAsync(group.GroupId);
        if (memberCount >= group.MaxMembers)
        {
            throw new ArgumentException("群组已满");
        }

        var member = new GroupMember
        {
            GroupId = group.GroupId,
            UserId = userId,
            MemberRole = memberRole,
            Tags = BuildDefaultHumanTags(memberRole)
        };

        await _memberRepository.InsertAsync(member);

        return member;
    }

    private static List<GroupMemberTag> BuildDefaultHumanTags(UserRole role)
    {
        return new List<GroupMemberTag>
        {
            new()
            {
                Name = role switch
                {
                    UserRole.PM => "产品经理",
                    UserRole.DEV => "开发",
                    UserRole.QA => "测试",
                    UserRole.ADMIN => "管理员",
                    _ => "成员"
                },
                Role = role switch
                {
                    UserRole.PM => "pm",
                    UserRole.DEV => "dev",
                    UserRole.QA => "qa",
                    UserRole.ADMIN => "admin",
                    _ => "member"
                }
            }
        };
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
        var memberRecords = await _memberRepository.GetByUserIdAsync(userId);
        var groupIds = memberRecords.Select(m => m.GroupId).ToList();
        return await _groupRepository.GetByIdsAsync(groupIds);
    }

    public async Task UpdateKbStatusAsync(string groupId, bool hasKb, int docCount)
    {
        await _groupRepository.UpdateKbStatusAsync(groupId, hasKb, docCount);
    }

    public async Task DissolveAsync(string groupId)
    {
        await _memberRepository.DeleteByGroupIdAsync(groupId);
        await _groupRepository.DeleteAsync(groupId);
    }

    public async Task UpdateGroupNameAsync(string groupId, string groupName)
    {
        await _groupRepository.UpdateGroupNameAsync(groupId, groupName);
    }
}
