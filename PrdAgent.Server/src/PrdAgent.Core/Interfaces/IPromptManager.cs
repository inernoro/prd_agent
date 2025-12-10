using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// Prompt管理器接口
/// </summary>
public interface IPromptManager
{
    /// <summary>构建系统Prompt</summary>
    string BuildSystemPrompt(UserRole role, string prdContent);

    /// <summary>获取引导大纲</summary>
    List<GuideOutlineItem> GetGuideOutline(UserRole role);

    /// <summary>构建缺口检测Prompt</summary>
    string BuildGapDetectionPrompt(string prdContent, string question);
}


