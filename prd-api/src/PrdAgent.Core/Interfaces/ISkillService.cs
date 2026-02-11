using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 统一技能服务接口
/// </summary>
public interface ISkillService
{
    /// <summary>获取用户可见的全部技能（系统 + 公共 + 个人）</summary>
    Task<List<Skill>> GetVisibleSkillsAsync(string userId, UserRole? roleFilter = null, CancellationToken ct = default);

    /// <summary>根据 skillKey 获取技能（含执行配置）</summary>
    Task<Skill?> GetByKeyAsync(string skillKey, CancellationToken ct = default);

    /// <summary>创建个人技能</summary>
    Task<Skill> CreatePersonalSkillAsync(string userId, Skill skill, CancellationToken ct = default);

    /// <summary>更新个人技能（仅允许更新自己的）</summary>
    Task<bool> UpdatePersonalSkillAsync(string userId, string skillKey, Skill updates, CancellationToken ct = default);

    /// <summary>删除个人技能（仅允许删除自己的非内置技能）</summary>
    Task<bool> DeletePersonalSkillAsync(string userId, string skillKey, CancellationToken ct = default);

    /// <summary>增加技能使用计数</summary>
    Task IncrementUsageAsync(string skillKey, CancellationToken ct = default);

    /// <summary>从 prompt_stages 迁移数据到 skills 集合</summary>
    Task<int> MigrateFromPromptsAsync(CancellationToken ct = default);
}
