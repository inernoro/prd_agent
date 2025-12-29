using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public record PromptClientItem(
    string PromptKey,
    int Order,
    UserRole Role,
    string Title);

public record PromptsClientResponse(
    DateTime UpdatedAt,
    List<PromptClientItem> Prompts);

public interface IPromptService
{
    /// <summary>
    /// 获取系统内置默认提示词配置（不读取 DB，不受覆盖影响）。
    /// 用途：判断是否“使用默认”、以及初始化 DB 缺失时的种子数据。
    /// </summary>
    Task<PromptSettings> GetDefaultSettingsAsync(CancellationToken ct = default);

    Task<PromptSettings> GetEffectiveSettingsAsync(CancellationToken ct = default);

    Task<PromptsClientResponse> GetPromptsForClientAsync(CancellationToken ct = default);

    /// <summary>按 promptKey 获取提示词（推荐）</summary>
    Task<RolePrompt?> GetPromptByKeyAsync(UserRole role, string promptKey, CancellationToken ct = default);

    Task RefreshAsync(CancellationToken ct = default);
}


