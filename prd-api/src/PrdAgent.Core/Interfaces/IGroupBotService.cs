using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 群机器人账号管理（预留：未来多 Agent / 自动交接）
/// </summary>
public interface IGroupBotService
{
    /// <summary>
    /// 确保群内存在默认的三类角色机器人账号（PM/DEV/QA），并且都已加入该群。
    /// - 幂等：重复调用不会重复创建用户/成员记录
    /// - 兼容：若机器人用户已存在，则复用；若用户名冲突且非机器人账号，则抛错
    /// </summary>
    Task<IReadOnlyList<User>> EnsureDefaultRoleBotsInGroupAsync(string groupId);
}


