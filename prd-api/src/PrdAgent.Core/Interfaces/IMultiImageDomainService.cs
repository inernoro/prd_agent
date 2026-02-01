using PrdAgent.Core.Models.MultiImage;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 多图处理领域服务接口
///
/// 设计原则：
/// 1. 这是一个核心领域服务，被多个模块调用（VisualAgent、LiteraryAgent 等）
/// 2. 不依赖于具体的 Controller 或 HTTP 上下文
/// 3. 提供统一的多图解析和意图分析能力
/// </summary>
public interface IMultiImageDomainService
{
    /// <summary>
    /// 解析 prompt 中的 @imgN 引用，并与传入的 imageRefs 进行匹配验证
    /// </summary>
    /// <param name="prompt">用户输入的原始 prompt（包含 @imgN 标记）</param>
    /// <param name="imageRefs">前端传递的图片引用列表</param>
    /// <returns>解析结果</returns>
    MultiImageParseResult ParsePromptRefs(string prompt, IReadOnlyList<ImageRefInput>? imageRefs);

    /// <summary>
    /// 分析用户意图（多图场景）
    ///
    /// 核心功能：
    /// - 将用户描述中的 @imgN 标记与真实图片建立映射
    /// - 输出生图模型可直接使用的 prompt
    /// - 保留用户原始意图，不过度干预
    /// </summary>
    /// <param name="prompt">原始 prompt</param>
    /// <param name="refs">已解析的图片引用列表</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>意图分析结果</returns>
    Task<ImageIntentResult> AnalyzeIntentAsync(
        string prompt,
        IReadOnlyList<ResolvedImageRef> refs,
        CancellationToken ct = default);

    /// <summary>
    /// 使用规则匹配进行快速意图分析（不调用 LLM）
    /// 适用于简单场景，作为 LLM 分析的降级方案
    /// </summary>
    /// <param name="prompt">原始 prompt</param>
    /// <param name="refs">已解析的图片引用列表</param>
    /// <returns>意图分析结果，如果无法匹配则返回 null</returns>
    ImageIntentResult? TryMatchByRules(string prompt, IReadOnlyList<ResolvedImageRef> refs);

    /// <summary>
    /// 构建发送给生图模型的最终 prompt
    ///
    /// 策略：
    /// 1. 多图场景：调用意图分析，将 @imgN 替换为清晰描述
    /// 2. 单图场景：直接使用原始 prompt
    /// 3. 纯文本场景：直接使用原始 prompt
    /// </summary>
    /// <param name="prompt">原始 prompt</param>
    /// <param name="refs">已解析的图片引用列表</param>
    /// <param name="ct">取消令牌</param>
    /// <returns>最终 prompt</returns>
    Task<string> BuildFinalPromptAsync(
        string prompt,
        IReadOnlyList<ResolvedImageRef> refs,
        CancellationToken ct = default);
}
