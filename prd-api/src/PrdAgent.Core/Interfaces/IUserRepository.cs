using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 用户仓储接口
/// </summary>
public interface IUserRepository
{
    Task<User?> GetByIdAsync(string userId);
    Task<User?> GetByUsernameAsync(string username);
    Task InsertAsync(User user);
    Task UpdateLastLoginAsync(string userId);
    Task UpdateLastActiveAsync(string userId, DateTime atUtc);
    Task UpdatePasswordAsync(string userId, string passwordHash);

    /// <summary>
    /// 只有当库里的散列仍然是 <paramref name="expectedHash"/> 时才换。
    /// 返回是否真的换成了——两个会话同时改密时，只有一个能拿到 true。
    /// </summary>
    Task<bool> TryReplacePasswordAsync(string userId, string expectedHash, string passwordHash);
    Task UpdateMustResetPasswordAsync(string userId, bool mustResetPassword);
}

/// <summary>
/// 邀请码仓储接口
/// </summary>
public interface IInviteCodeRepository
{
    Task<InviteCode?> GetByCodeAsync(string code);
    Task<InviteCode?> GetValidCodeAsync(string code);
    Task InsertAsync(InviteCode inviteCode);
    Task MarkAsUsedAsync(string code, string usedBy);
}
