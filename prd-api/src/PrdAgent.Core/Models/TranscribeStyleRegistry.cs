namespace PrdAgent.Core.Models;

/// <summary>
/// 录音转笔记的「整理方式」注册表（SSOT）。
/// 前端 chips 通过 GET /api/document-store/transcribe-styles 读取本表，禁止前端硬编码。
/// PromptAddon 是拼进摘要 system prompt 的风格段；custom 无 addon，整理要求由用户提供。
/// </summary>
public record TranscribeStyleContextInput(
    string Label,
    string Description,
    string Placeholder,
    string? Example = null);

public record TranscribeStyle(
    string Key,
    string Label,
    string Description,
    string? PromptAddon,
    TranscribeStyleContextInput? ContextInput = null);

public static class TranscribeStyleRegistry
{
    public const string DefaultKey = "general";
    public const string CustomKey = "custom";

    public static readonly IReadOnlyList<TranscribeStyle> All = new List<TranscribeStyle>
    {
        new("general", "智能摘要",
            "一段话概述 + 要点，识别到结论/待办时单独列出（默认）",
            "输出一份结构化 Markdown 摘要：先用一段话概述，再列 3-8 条要点；" +
            "如转录中有明确结论或待办事项，单独用「结论」「待办」小节列出。"),
        new("meeting", "会议纪要",
            "提炼议题、观点、结论和待办，可直接发送或继续编辑",
            "把内容整理成标准 Markdown 会议纪要，依次包含「会议概要」「讨论议题」「关键结论」「待办事项」。" +
            "每个议题保留关键观点及说话人归属；待办使用 - [ ] 格式，并在原文明确时写出负责人和期限。" +
            "补充信息中明确写出的主题、地点、时间、人员和资料地址可用于会议概要。" +
            "所有结论和待办必须来自转录全文或补充信息；未明确的字段写「未明确」，不得猜测。",
            new TranscribeStyleContextInput(
                "会议补充信息",
                "可粘贴会议邀请、主题、时间、参会人或已有纪要。系统会补齐背景，不会覆盖录音原文。",
                "粘贴会议主题、时间、地点、参会人或相关资料地址",
                "主题：客户方案讨论\n时间：2026.8.4 下午 4:00\n参与人员：张三、李四\n资料：https://example.com")),
        new("interview", "访谈整理",
            "按问答对整理，保留关键原话，适合访谈/用户调研",
            "把内容整理成访谈记录：按提问-回答的问答对组织，每个问答一个小节；" +
            "回答中的关键表述尽量保留原话（可用引号标出）；结尾用「要点提炼」小节归纳 3-5 条洞察。"),
        new("todo", "待办清单",
            "只提取行动项，输出可勾选的待办列表",
            "只提取其中的行动项，输出 Markdown 任务列表（- [ ] 事项）；" +
            "转录中提到负责人或期限时一并标注在事项后；没有行动项时输出「本段录音未提及待办事项」。"),
        new("custom", "自定义",
            "自己描述想要的整理方式",
            null),
    };

    public static TranscribeStyle? Find(string? key)
        => string.IsNullOrWhiteSpace(key) ? null : All.FirstOrDefault(s => s.Key == key.Trim().ToLowerInvariant());
}
