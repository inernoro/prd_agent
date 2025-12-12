using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Repositories;

/// <summary>
/// 用户仓储实现
/// </summary>
public class UserRepository : IUserRepository
{
    private readonly IMongoCollection<User> _users;

    public UserRepository(IMongoCollection<User> users)
    {
        _users = users;
    }

    public async Task<User?> GetByIdAsync(string userId)
    {
        return await _users.Find(u => u.UserId == userId).FirstOrDefaultAsync();
    }

    public async Task<User?> GetByUsernameAsync(string username)
    {
        return await _users.Find(u => u.Username == username).FirstOrDefaultAsync();
    }

    public async Task InsertAsync(User user)
    {
        await _users.InsertOneAsync(user);
    }

    public async Task UpdateLastLoginAsync(string userId)
    {
        await _users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.Set(u => u.LastLoginAt, DateTime.UtcNow));
    }
}

/// <summary>
/// 邀请码仓储实现
/// </summary>
public class InviteCodeRepository : IInviteCodeRepository
{
    private readonly IMongoCollection<InviteCode> _inviteCodes;

    public InviteCodeRepository(IMongoCollection<InviteCode> inviteCodes)
    {
        _inviteCodes = inviteCodes;
    }

    public async Task<InviteCode?> GetByCodeAsync(string code)
    {
        return await _inviteCodes.Find(c => c.Code == code).FirstOrDefaultAsync();
    }

    public async Task<InviteCode?> GetValidCodeAsync(string code)
    {
        var invite = await _inviteCodes.Find(c => c.Code == code && !c.IsUsed).FirstOrDefaultAsync();
        if (invite == null)
            return null;

        // 检查是否过期
        if (invite.ExpiresAt.HasValue && invite.ExpiresAt.Value < DateTime.UtcNow)
            return null;

        return invite;
    }

    public async Task InsertAsync(InviteCode inviteCode)
    {
        await _inviteCodes.InsertOneAsync(inviteCode);
    }

    public async Task MarkAsUsedAsync(string code, string usedBy)
    {
        await _inviteCodes.UpdateOneAsync(
            c => c.Code == code,
            Builders<InviteCode>.Update
                .Set(c => c.IsUsed, true)
                .Set(c => c.UsedBy, usedBy)
                .Set(c => c.UsedAt, DateTime.UtcNow));
    }
}





