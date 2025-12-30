using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface ISystemPromptService
{
    /// <summary>
    /// 获取系统内置默认系统提示词配置（不读取 DB，不受覆盖影响）。
    /// 默认值来源：PromptManager.BuildSystemPrompt(role, ...)
    /// </summary>
    Task<SystemPromptSettings> GetDefaultSettingsAsync(CancellationToken ct = default);

    /// <summary>
    /// 获取“有效系统提示词设置”（管理员覆盖后生效）。
    /// 按用户要求：任何情况下均从 MongoDB 回源读取，不允许使用内存/Redis 等时效缓存。
    /// </summary>
    Task<SystemPromptSettings> GetEffectiveSettingsAsync(CancellationToken ct = default);

    /// <summary>按角色获取本次 PRD 问答应使用的 system prompt</summary>
    Task<string> GetSystemPromptAsync(UserRole role, CancellationToken ct = default);

    Task RefreshAsync(CancellationToken ct = default);
}


