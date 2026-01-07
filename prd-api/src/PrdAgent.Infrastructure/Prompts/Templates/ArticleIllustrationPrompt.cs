namespace PrdAgent.Infrastructure.Prompts.Templates;

/// <summary>
/// 文章配图场景：LLM 在文章中插入配图提示词标记的 Prompt 模板
/// </summary>
public static class ArticleIllustrationPrompt
{
    // 说明：该场景的 system prompt 完全由用户在前端配置并透传（userInstruction）决定，
    // 后端不再提供任何内置提示词，避免“看起来用了用户模板，但实际混入系统文案”的误解。
}
