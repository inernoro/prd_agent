using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 系统角色缓存服务接口。
/// 内置角色从代码加载（只读），自定义角色从数据库加载（可 CRUD）。
/// </summary>
public interface ISystemRoleCacheService
{
    /// <summary>
    /// 获取所有角色（内置 + 自定义）
    /// </summary>
    IReadOnlyList<SystemRole> GetAllRoles();

    /// <summary>
    /// 根据 key 获取角色
    /// </summary>
    SystemRole? GetRoleByKey(string key);

    /// <summary>
    /// 刷新自定义角色缓存（从数据库重新加载）
    /// </summary>
    Task RefreshCustomRolesAsync(CancellationToken ct = default);

    /// <summary>
    /// 初始化缓存（启动时调用）
    /// </summary>
    Task InitializeAsync(CancellationToken ct = default);
}
