using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Prompt管理器接口
/// </summary>
public interface IPromptManager
{
    /// <summary>构建系统Prompt</summary>
    string BuildSystemPrompt(UserRole role, string prdContent);

    /// <summary>
    /// 构建 PRD 上下文消息（作为"资料"提供给模型，不是指令）。\n
    /// 注意：该消息内容可能很长；日志侧会按标记做脱敏。\n
    /// </summary>
    string BuildPrdContextMessage(string prdContent);

    /// <summary>
    /// 构建多文档上下文消息（知识库多文档注入）
    /// </summary>
    string BuildMultiDocContextMessage(List<KbDocument> documents);

    /// <summary>获取引导大纲</summary>
    List<GuideOutlineItem> GetGuideOutline(UserRole role);

    /// <summary>构建缺口检测Prompt</summary>
    string BuildGapDetectionPrompt(string prdContent, string question);
}
