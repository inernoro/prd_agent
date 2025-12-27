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


