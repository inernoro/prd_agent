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

    public async Task UpdateLastActiveAsync(string userId, DateTime atUtc)
    {
        if (string.IsNullOrWhiteSpace(userId)) return;
        var utc = atUtc.Kind == DateTimeKind.Utc ? atUtc : atUtc.ToUniversalTime();

        // 用 $max 避免“并发/乱序”把时间回写变小
        var update = Builders<User>.Update.Max(u => u.LastActiveAt, utc);

        await _users.UpdateOneAsync(
            u => u.UserId == userId,
            update);
    }

    public async Task UpdatePasswordAsync(string userId, string passwordHash)
    {
        if (string.IsNullOrWhiteSpace(userId)) return;
        
        await _users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.Set(u => u.PasswordHash, passwordHash));
    }

    public async Task<bool> TryReplacePasswordAsync(string userId, string expectedHash, string passwordHash)
    {
        if (string.IsNullOrWhiteSpace(userId) || string.IsNullOrWhiteSpace(expectedHash)) return false;

        // 条件更新：校验旧密码和写新密码之间有一段窗口，两个会话可以同时通过校验。
        // 都无条件写下去的话，两边都会接着清会话、各自签发新会话——于是密码没写赢的
        // 那一方仍然登着，而「改密码会把其它设备踢下线」这句承诺当场落空。
        var result = await _users.UpdateOneAsync(
            Builders<User>.Filter.And(
                Builders<User>.Filter.Eq(u => u.UserId, userId),
                Builders<User>.Filter.Eq(u => u.PasswordHash, expectedHash),
                // 状态也要进这个原子谓词。控制器里那道 Active 检查读的是**更早**的快照：
                // 管理员在「读到还是启用」和「这句更新执行」之间把人停掉的话，更新照样成功，
                // 端点接着签发一整套新令牌——停用输给了改密。放进来，停用才赢得了这场竞态。
                Builders<User>.Filter.Eq(u => u.Status, UserStatus.Active)),
            Builders<User>.Update
                .Set(u => u.PasswordHash, passwordHash)
                // 「必须改密」这个标记跟着密码一起写，不能拆成后面单独一句。
                //
                // 拆开的话有这么一段窗口：本方法刚写完新密码，管理员的重置端点紧接着
                // 原子地写下临时密码 + MustResetPassword=true，然后那句单独的
                // 「清标记」再无条件把它抹回 false——管理员发的临时密码从此不再强制
                // 首登改密，而自助这一侧还照常签发了新会话。
                // 谁写赢了密码，谁就同时拥有这个标记的状态。
                .Set(u => u.MustResetPassword, false));
        return result.ModifiedCount > 0;
    }

    public async Task UpdateMustResetPasswordAsync(string userId, bool mustResetPassword)
    {
        if (string.IsNullOrWhiteSpace(userId)) return;
        
        await _users.UpdateOneAsync(
            u => u.UserId == userId,
            Builders<User>.Update.Set(u => u.MustResetPassword, mustResetPassword));
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
