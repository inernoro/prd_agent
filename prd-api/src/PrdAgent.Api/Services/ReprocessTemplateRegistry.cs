namespace PrdAgent.Api.Services;

/// <summary>
/// 文档再加工模板注册表 —— 4 个内置模板 + custom（用户自定义 prompt）
/// </summary>
public static class ReprocessTemplateRegistry
{
    public static readonly IReadOnlyList<ReprocessTemplate> Templates = new List<ReprocessTemplate>
    {
        new(
            Key: "summary",
            Label: "摘要",
            Description: "把长文浓缩成一段 200-400 字的核心摘要",
            SystemPrompt: "你是专业的内容编辑。任务：把用户给你的原始内容浓缩成一段 200-400 字的核心摘要。要求：" +
                          "1) 抓住最关键的 3-5 个要点；" +
                          "2) 语言简练客观，不添加原文没有的观点；" +
                          "3) 输出纯文本段落，不要 Markdown 标题；" +
                          "4) 不要前言和结语。"
        ),
        new(
            Key: "minutes",
            Label: "会议纪要",
            Description: "把录音/字幕整理成结构化会议纪要（议题/决议/待办）",
            SystemPrompt: "你是会议纪要整理助手。任务：把用户给的原始内容整理成标准会议纪要。要求：" +
                          "1) 输出 Markdown 格式，包含以下章节：# 会议概要、## 讨论议题、## 关键结论、## 待办事项（含责任人和时间）；" +
                          "2) 每个议题下列出关键讨论点和结论；" +
                          "3) 待办事项用 `- [ ]` 格式，若能识别出执行人就注明；" +
                          "4) 严格基于原文，不要编造未出现的内容。"
        ),
        new(
            Key: "blog",
            Label: "技术博文",
            Description: "把原始内容改写成一篇结构清晰的技术博客文章",
            SystemPrompt: "你是技术博客作者。任务：把用户给的原始内容改写成一篇结构清晰、可读性强的技术博客。要求：" +
                          "1) Markdown 格式，包含：引人入胜的一级标题 + 简介段 + 2-5 个二级标题章节 + 结尾段；" +
                          "2) 语言专业但通俗，适当使用示例、类比、小标题提升可读性；" +
                          "3) 保持技术准确性，原文有的数据/事实必须保留；" +
                          "4) 如有代码块，使用标准 Markdown 代码块格式；" +
                          "5) 结尾段落鼓励读者思考或实践。"
        ),
        new(
            Key: "notes",
            Label: "学习笔记",
            Description: "把原始内容整理成带层级的学习笔记（适合复习回顾）",
            SystemPrompt: "你是学习笔记整理助手。任务：把用户给的原始内容整理成结构化的学习笔记。要求：" +
                          "1) Markdown 格式，使用多级标题组织知识点；" +
                          "2) 关键概念用粗体标注；" +
                          "3) 列出要点时使用 bullet list；" +
                          "4) 如有公式、定义、示例，分别用代码块或引用块标注；" +
                          "5) 结尾加一个「## 要点回顾」章节，浓缩最核心的 5-8 条知识点。"
        ),
    };

    public static ReprocessTemplate? FindByKey(string? key)
    {
        if (string.IsNullOrEmpty(key)) return null;
        return Templates.FirstOrDefault(t => t.Key == key);
    }
}

public record ReprocessTemplate(
    string Key,
    string Label,
    string Description,
    string SystemPrompt);
