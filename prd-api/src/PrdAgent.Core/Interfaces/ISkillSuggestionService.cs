using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 对话技能建议服务：从最近一轮对话生成可确认的技能草稿。
/// </summary>
public interface ISkillSuggestionService
{
    /// <summary>
    /// 基于会话最新 assistant 回复生成技能建议。
    /// 返回 null 表示当前轮次不建议沉淀。
    /// </summary>
    Task<SkillSuggestion?> GetLatestSuggestionAsync(
        string sessionId,
        string userId,
        string? assistantMessageId = null,
        CancellationToken ct = default);
}
