using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services;

/// <summary>
/// 用户服务实现
/// </summary>
public class UserService : IUserService
{
    private readonly IMongoCollection<User> _users;
    private readonly IMongoCollection<InviteCode> _inviteCodes;

    public UserService(IMongoCollection<User> users, IMongoCollection<InviteCode> inviteCodes)
    {
        _users = users;
        _inviteCodes = inviteCodes;
    }

    public async Task<User> RegisterAsync(
        string username, 
        string password, 
        string inviteCode, 
        UserRole role, 
        string? displayName = null)
    {
        // 验证邀请码
        var invite = await _inviteCodes.Find(c => c.Code == inviteCode && !c.IsUsed).FirstOrDefaultAsync();
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
            Username = username,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(password),
            DisplayName = displayName ?? username,
            Role = role,
            Status = UserStatus.Active
        };

        await _users.InsertOneAsync(user);

        // 标记邀请码已使用
        await _inviteCodes.UpdateOneAsync(
            c => c.Code == inviteCode,
            Builders<InviteCode>.Update
                .Set(c => c.IsUsed, true)
                .Set(c => c.UsedBy, user.UserId)
                .Set(c => c.UsedAt, DateTime.UtcNow));

        return user;
    }

    public async Task<User?> ValidateCredentialsAsync(string username, string password)
    {
        var user = await GetByUsernameAsync(username);
        if (user == null)
            return null;

        if (!BCrypt.Net.BCrypt.Verify(password, user.PasswordHash))
            return null;

        if (user.Status == UserStatus.Disabled)
            return null;

        return user;
    }

    public async Task<User?> GetByIdAsync(string userId)
    {
        return await _users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
    }

    public async Task<User?> GetByUsernameAsync(string username)
    {
        return await _users.Find(u => u.Username == username).FirstOrDefaultAsync();
    }

    public async Task UpdateLastLoginAsync(string userId)
    {
        await _users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.Set(u => u.LastLoginAt, DateTime.UtcNow));
    }

    public async Task<bool> ValidateInviteCodeAsync(string inviteCode)
    {
        var invite = await _inviteCodes.Find(c => c.Code == inviteCode && !c.IsUsed).FirstOrDefaultAsync();
        if (invite == null)
            return false;

        // 检查是否过期
        if (invite.ExpiresAt.HasValue && invite.ExpiresAt.Value < DateTime.UtcNow)
            return false;

        return true;
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

        await _inviteCodes.InsertOneAsync(inviteCode);
        return code;
    }
}

/// <summary>
/// 邀请码实体
/// </summary>
public class InviteCode
{
    public string Code { get; set; } = string.Empty;
    public string CreatorId { get; set; } = string.Empty;
    public bool IsUsed { get; set; }
    public string? UsedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? UsedAt { get; set; }
    public DateTime? ExpiresAt { get; set; }
}

