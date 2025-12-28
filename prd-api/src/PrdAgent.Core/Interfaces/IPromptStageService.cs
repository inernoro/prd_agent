using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public record PromptStageClientItem(
    string StageKey,
    int Order,
    UserRole Role,
    string Title);

public record PromptStagesClientResponse(
    DateTime UpdatedAt,
    List<PromptStageClientItem> Stages);

public interface IPromptStageService
{
    /// <summary>
    /// 获取系统内置默认阶段配置（不读取 DB，不受覆盖影响）。\n
    /// 用途：判断是否“使用默认”、以及初始化 DB 缺失时的种子数据。\n
    /// </summary>
    Task<PromptStageSettings> GetDefaultSettingsAsync(CancellationToken ct = default);

    Task<PromptStageSettings> GetEffectiveSettingsAsync(CancellationToken ct = default);

    Task<PromptStagesClientResponse> GetStagesForClientAsync(CancellationToken ct = default);

    Task<List<GuideOutlineItem>> GetGuideOutlineAsync(UserRole role, CancellationToken ct = default);

    /// <summary>按 order(step) 获取阶段提示词（兼容旧客户端）</summary>
    Task<RoleStagePrompt?> GetStagePromptAsync(UserRole role, int step, CancellationToken ct = default);

    /// <summary>按 stageKey 获取阶段提示词（推荐）</summary>
    Task<RoleStagePrompt?> GetStagePromptByKeyAsync(UserRole role, string stageKey, CancellationToken ct = default);

    /// <summary>将 order 映射到 stageKey（order 在 role 内排序；用于旧接口兼容）</summary>
    Task<string?> MapOrderToStageKeyAsync(UserRole role, int order, CancellationToken ct = default);

    Task RefreshAsync(CancellationToken ct = default);
}


