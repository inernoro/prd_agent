namespace PrdAgent.Infrastructure.Prompts.Templates;

/// <summary>
/// 文章配图场景：LLM 在文章中插入配图提示词标记的 Prompt 模板
/// </summary>
public static class ArticleIllustrationPrompt
{
    // 说明：该场景的 system prompt 完全由用户在前端配置并透传（userInstruction）决定，
    // 后端不再提供任何内置提示词，避免"看起来用了用户模板，但实际混入系统文案"的误解。

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
- 配图描述使用英文，详细描述画面内容、风格、色调
""";

    /// <summary>
    /// 将用户提示词包裹为 anchor 模式的完整 system prompt。
    /// 格式约束在前（优先级高），用户创作指导在后。
    /// 若 userInstruction 为空，则仅返回格式约束（无需用户风格也能工作）。
    /// </summary>
    public static string WrapForAnchorMode(string userInstruction)
    {
        if (string.IsNullOrWhiteSpace(userInstruction))
        {
            return AnchorFormatConstraint;
        }

        return $"""
{AnchorFormatConstraint}
---

以下是用户的创作指导（请遵循其中关于配图风格、数量、内容偏好的要求，但输出格式必须严格遵循上述锚点格式）：

{userInstruction}
""";
    }
}
