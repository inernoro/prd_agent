namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 团队成员关系解析服务 —— 供网页托管 / 知识库 / 团队管理共同消费。
/// 只负责「我属于哪些团队 / 我是不是某团队的成员或管理员」这类关系判定，
/// 不持有任何应用内容逻辑（内容隔离靠各应用实体上的 SharedTeamIds）。
/// </summary>
public interface ITeamService
{
    /// <summary>当前用户所属的全部团队 ID（每请求解析一次，传给内容模块做团队作用域过滤）</summary>
    Task<List<string>> GetMyTeamIdsAsync(string userId, CancellationToken ct = default);

    /// <summary>用户是否为该团队成员（含管理员）</summary>
    Task<bool> IsMemberAsync(string teamId, string userId, CancellationToken ct = default);

    /// <summary>用户是否为该团队管理员</summary>
    Task<bool> IsAdminAsync(string teamId, string userId, CancellationToken ct = default);

    /// <summary>
    /// 当前用户在所属各团队的「网页托管有效角色」映射（teamId → owner/editor/viewer）。
    /// 已应用继承解析（WebHostingRole 为空时 admin→owner / member→editor）。
    /// 仅网页托管模块消费，用于在团队作用域内做角色门控。
    /// </summary>
    Task<Dictionary<string, string>> GetMyWebHostingTeamRolesAsync(string userId, CancellationToken ct = default);
}
