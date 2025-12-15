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
