namespace PrdAgent.Infrastructure.Prompts.Templates;

/// <summary>
/// 文章配图场景：LLM 在文章中插入配图提示词标记的 Prompt 模板
/// </summary>
public static class ArticleIllustrationPrompt
{
    /// <summary>
    /// 锚点模式的输出格式约束。当 insertionMode=anchor 时，
    /// 后端将此约束包裹在用户提示词外层，确保 LLM 输出锚点格式。
    /// 用户的原始提示词（风格、内容偏好等）仍被保留并注入。
    /// </summary>
    public const string AnchorFormatConstraint = """
【强制输出格式 — 必须严格遵守】
你只能输出"插入指令"，绝对不要复述、引用或输出原文内容。

每条插入指令的格式（两行为一组）：

@AFTER 原文中的一句话（作为定位锚点，必须与原文完全一致）
[插图](宽x高): 配图描述

可选尺寸（必须从以下列表中选择一个，根据配图场景选择最合适的比例）：
- 1024x1024（正方形，适合头像、图标、Logo、特写）
- 1024x768（横版 4:3，适合风景、场景、宽幅插图）
- 768x1024（竖版 3:4，适合人像、建筑、纵向场景）
- 1280x720（横版 16:9，适合电影感、宽幅场景、Banner）
- 720x1280（竖版 9:16，适合手机壁纸、竖版海报）

规则：
- 锚点必须是原文中完整、连续的一句话（含标点），确保唯一匹配
- 每组插入指令之间用空行分隔
- 除插入指令外不输出任何内容（无开场白、无分析、无总结）
- 根据文章长度合理安排配图数量（约每 300-500 字一张）
""";

    /// <summary>
    /// 当用户未设置自定义风格提示词时，系统自动推断风格的默认指导。
    /// LLM 将根据文章内容、主题和情感基调自动选择最合适的配图风格。
    /// </summary>
    public const string DefaultStyleInference = """
【配图风格 — 系统自动推断】
请根据文章的内容、主题、体裁和情感基调，自动推断最合适的配图风格。
要求：
- 分析文章属于哪种类型（如科技、文学、新闻、教育、商业等）
- 根据文章类型和情感基调选择合适的视觉风格（如写实摄影、扁平插画、水彩手绘、科技感3D、极简线条等）
- 在每条配图描述中明确包含风格关键词，确保生图模型能准确理解风格要求
- 所有配图保持统一的视觉风格，形成连贯的阅读体验
""";

    /// <summary>
    /// 将用户提示词包裹为 anchor 模式的完整 system prompt。
    /// 格式约束在前（优先级高），用户创作指导在后。
    /// 若 userInstruction 为空，则使用系统默认风格推断指导（而非无风格指导）。
    /// </summary>
    public static string WrapForAnchorMode(string userInstruction)
    {
        if (string.IsNullOrWhiteSpace(userInstruction))
        {
            return $"""
{AnchorFormatConstraint}
---

{DefaultStyleInference}
""";
        }

        return $"""
{AnchorFormatConstraint}
---

以下是用户的创作指导（请遵循其中关于配图风格、数量、内容偏好的要求，但输出格式必须严格遵循上述锚点格式）：

{userInstruction}
""";
    }
}
