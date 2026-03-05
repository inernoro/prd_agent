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
    /// 构建 PRD 上下文消息（作为“资料”提供给模型，不是指令）。\n
    /// 注意：该消息内容可能很长；日志侧会按标记做脱敏。\n
    /// </summary>
    string BuildPrdContextMessage(string prdContent);

    /// <summary>构建多文档 PRD 上下文消息</summary>
    string BuildMultiPrdContextMessage(List<ParsedPrd> documents);

    /// <summary>
    /// 构建多文档 PRD 上下文消息（带 token 预算和文档类型加权）。
    /// 主文档(product)全文注入，超预算时补充文档按类型权重截断或摘要化。
    /// </summary>
    /// <param name="documents">文档列表（第一个为主文档）</param>
    /// <param name="getDocumentType">获取文档类型的委托（传入 docId，返回 product/technical/design/reference）</param>
    /// <param name="tokenBudget">token 预算上限（0 = 不限制，使用原有全量注入）</param>
    /// <returns>带标记的上下文字符串</returns>
    string BuildMultiPrdContextMessage(List<ParsedPrd> documents, Func<string, string> getDocumentType, int tokenBudget);

    /// <summary>获取引导大纲</summary>
    List<GuideOutlineItem> GetGuideOutline(UserRole role);

    /// <summary>构建缺口检测Prompt</summary>
    string BuildGapDetectionPrompt(string prdContent, string question);
}
