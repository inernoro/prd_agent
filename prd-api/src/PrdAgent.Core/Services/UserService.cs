using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 用户服务实现
/// </summary>
public class UserService : IUserService
{
    private readonly IUserRepository _userRepository;
    private readonly IInviteCodeRepository _inviteCodeRepository;
    private readonly IIdGenerator _idGenerator;

    public UserService(
        IUserRepository userRepository, 
        IInviteCodeRepository inviteCodeRepository,
        IIdGenerator idGenerator)
    {
        _userRepository = userRepository;
        _inviteCodeRepository = inviteCodeRepository;
        _idGenerator = idGenerator;
    }

    public async Task<User> RegisterAsync(
        string username, 
        string password, 
        string inviteCode, 
        UserRole role, 
        string? displayName = null)
    {
        // 验证邀请码
        var invite = await _inviteCodeRepository.GetValidCodeAsync(inviteCode);
        if (invite == null)
        {
            throw new ArgumentException("邀请码无效或已使用");
        }

        // 检查用户名是否已存在
        var existingUser = await GetByUsernameAsync(username);
        if (existingUser != null)
        {
            throw new ArgumentException("用户名已存在");
        }

        // 创建用户
        var user = new User
        {
            UserId = await _idGenerator.GenerateIdAsync("user"),
            Username = username,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(password),
            DisplayName = displayName ?? username,
            Role = role,
            Status = UserStatus.Active
        };

        await _userRepository.InsertAsync(user);

        // 标记邀请码已使用
        await _inviteCodeRepository.MarkAsUsedAsync(inviteCode, user.UserId);

        return user;
    }

    public async Task<User?> ValidateCredentialsAsync(string username, string password)
    {
        var user = await GetByUsernameAsync(username);
        if (user == null)
            return null;

        // 机器人账号禁止登录：仅作为群内成员/审计主体存在
        if (user.UserType == UserType.Bot)
            return null;

        if (!BCrypt.Net.BCrypt.Verify(password, user.PasswordHash))
            return null;

        if (user.Status == UserStatus.Disabled)
            return null;

        return user;
    }

    public async Task<User?> GetByIdAsync(string userId)
    {
        return await _userRepository.GetByIdAsync(userId);
    }

    public async Task<User?> GetByUsernameAsync(string username)
    {
        return await _userRepository.GetByUsernameAsync(username);
    }

    public async Task UpdateLastLoginAsync(string userId)
    {
        await _userRepository.UpdateLastLoginAsync(userId);
    }

    public async Task UpdateLastActiveAsync(string userId, DateTime? atUtc = null)
    {
        var uid = (userId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(uid)) return;

        var now = atUtc ?? DateTime.UtcNow;
        var utc = now.Kind == DateTimeKind.Utc ? now : now.ToUniversalTime();

        await _userRepository.UpdateLastActiveAsync(uid, utc);
    }

    public async Task<bool> ValidateInviteCodeAsync(string inviteCode)
    {
        var invite = await _inviteCodeRepository.GetValidCodeAsync(inviteCode);
        return invite != null;
    }

    public async Task<string> CreateInviteCodeAsync(string creatorId)
    {
        var code = $"PRD-{Guid.NewGuid().ToString("N")[..8].ToUpper()}";
        
        var inviteCode = new InviteCode
        {
            Code = code,
            CreatorId = creatorId,
            ExpiresAt = DateTime.UtcNow.AddDays(7) // 7天有效期
        };

        await _inviteCodeRepository.InsertAsync(inviteCode);
        return code;
    }
}
