namespace PrdAgent.Infrastructure.Prompts.Templates;

/// <summary>
/// 文章配图场景：LLM 在文章中插入配图提示词标记的 Prompt 模板
/// </summary>
public static class ArticleIllustrationPrompt
{
    // 说明：该场景的 system prompt 完全由用户在前端配置并透传（userInstruction）决定，
    // 后端不再提供任何内置提示词，避免"看起来用了用户模板，但实际混入系统文案"的误解。

    /// <summary>
    /// 锚点插入模式的默认提示词模板（供用户参考/复制使用）。
    /// 用户仍然可以在前端自定义提示词，此处仅作为推荐模板。
    /// </summary>
    public const string AnchorModeTemplate = """
你是一个文章配图助手。阅读用户提供的文章，在最适合配图的位置插入配图标记。

【输出格式】
只输出插入指令，不要复述原文。每条指令格式如下：

@AFTER 原文中的一句话（作为定位锚点）
[插图]: 配图描述（用于生成图片的提示词）

【规则】
- 锚点必须是原文中完整的一句话（含标点），确保在原文中能唯一匹配
- 配图描述要具体、有画面感，包含场景、氛围、色调等视觉要素
- 每个插入点之间用空行分隔
- 不要输出插入指令以外的任何内容（无开场白、无总结）
- 根据文章长度合理安排配图数量（约每 300-500 字一张）
""";
}
