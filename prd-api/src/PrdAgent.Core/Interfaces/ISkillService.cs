using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 技能服务：管理内置技能与用户自定义技能
/// </summary>
public interface ISkillService
{
    /// <summary>获取用户可用的技能列表（内置 + 该用户创建的）</summary>
    Task<List<Skill>> GetAvailableSkillsAsync(string? userId, string? role = null, CancellationToken ct = default);

    /// <summary>按 ID 获取技能</summary>
    Task<Skill?> GetByIdAsync(string skillId, CancellationToken ct = default);

    /// <summary>创建用户自定义技能</summary>
    Task<Skill> CreateAsync(Skill skill, CancellationToken ct = default);

    /// <summary>更新技能（仅允许 owner 更新自己的技能）</summary>
    Task<Skill?> UpdateAsync(string skillId, string userId, Skill updates, CancellationToken ct = default);

    /// <summary>删除技能（仅允许 owner 删除自己的技能，内置技能不可删除）</summary>
    Task<bool> DeleteAsync(string skillId, string userId, CancellationToken ct = default);

    /// <summary>确保内置技能已初始化（应用启动时调用）</summary>
    Task SeedBuiltInSkillsAsync(CancellationToken ct = default);
}
