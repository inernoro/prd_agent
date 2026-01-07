using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 群机器人账号管理（创建/加入群）
/// </summary>
public class GroupBotService : IGroupBotService
{
    private readonly IUserRepository _userRepository;
    private readonly IGroupRepository _groupRepository;
    private readonly IGroupMemberRepository _groupMemberRepository;
    private readonly IIdGenerator _idGenerator;

    public GroupBotService(
        IUserRepository userRepository,
        IGroupRepository groupRepository,
        IGroupMemberRepository groupMemberRepository,
        IIdGenerator idGenerator)
    {
        _userRepository = userRepository;
        _groupRepository = groupRepository;
        _groupMemberRepository = groupMemberRepository;
        _idGenerator = idGenerator;
    }

    public async Task<IReadOnlyList<User>> EnsureDefaultRoleBotsInGroupAsync(string groupId)
    {
        groupId = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(groupId))
        {
            throw new ArgumentException("groupId 不能为空");
        }

        var group = await _groupRepository.GetByIdAsync(groupId);
        if (group == null)
        {
            throw new ArgumentException("群组不存在");
        }

        var bots = new List<User>(capacity: 3)
        {
            await GetOrCreateRoleBotAsync(BotKind.PM),
            await GetOrCreateRoleBotAsync(BotKind.DEV),
            await GetOrCreateRoleBotAsync(BotKind.QA)
        };

        foreach (var bot in bots)
        {
            // 确保加入群
            var existing = await _groupMemberRepository.GetAsync(groupId, bot.UserId);
            if (existing != null) continue;

            await _groupMemberRepository.InsertAsync(new GroupMember
            {
                GroupId = groupId,
                UserId = bot.UserId,
                MemberRole = bot.Role,
                Tags = BuildDefaultBotTags(bot.BotKind ?? BotKind.DEV),
                JoinedAt = DateTime.UtcNow
            });
        }

        return bots;
    }

    private async Task<User> GetOrCreateRoleBotAsync(BotKind kind)
    {
        var username = kind switch
        {
            BotKind.PM => "bot_pm",
            BotKind.DEV => "bot_dev",
            BotKind.QA => "bot_qa",
            _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "未知 BotKind")
        };

        var existing = await _userRepository.GetByUsernameAsync(username);
        if (existing != null)
        {
            // 防止误把真人账号当机器人复用（用户名冲突）
            if (existing.UserType != UserType.Bot)
            {
                throw new InvalidOperationException($"用户名 {username} 已存在，但不是机器人账号，无法初始化默认机器人");
            }
            return existing;
        }

        var displayName = kind switch
        {
            BotKind.PM => "产品经理机器人",
            BotKind.DEV => "开发机器人",
            BotKind.QA => "测试机器人",
            _ => "机器人"
        };

        var role = kind switch
        {
            BotKind.PM => UserRole.PM,
            BotKind.DEV => UserRole.DEV,
            BotKind.QA => UserRole.QA,
            _ => UserRole.DEV
        };

        var user = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("robot"),
            Username = username,
            DisplayName = displayName,
            Role = role,
            Status = UserStatus.Active,
            UserType = UserType.Bot,
            BotKind = kind,
            // 机器人账号不允许登录：即便密码被猜到也会被 ValidateCredentials 拦截；
            // 这里仍写入一个合法 hash，避免出现空值导致 bcrypt verify 异常。
            PasswordHash = BCrypt.Net.BCrypt.HashPassword($"bot-secret-{Guid.NewGuid():N}")
        };

        await _userRepository.InsertAsync(user);
        return user;
    }

    private static List<GroupMemberTag> BuildDefaultBotTags(BotKind kind)
    {
        var roleTag = kind switch
        {
            BotKind.PM => new GroupMemberTag { Name = "产品经理", Role = "pm" },
            BotKind.DEV => new GroupMemberTag { Name = "开发", Role = "dev" },
            BotKind.QA => new GroupMemberTag { Name = "测试", Role = "qa" },
            _ => new GroupMemberTag { Name = "开发", Role = "dev" }
        };

        return new List<GroupMemberTag>
        {
            new() { Name = "机器人", Role = "robot" },
            roleTag
        };
    }
}


