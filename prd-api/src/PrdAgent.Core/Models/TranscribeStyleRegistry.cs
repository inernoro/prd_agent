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
            "生成可直接发送的方案评审结果通知，支持粘贴评审邀请或已有纪要补齐信息",
            "把内容整理成可直接发送的方案评审结果通知，严格使用以下结构：" +
            "【方案评审结果通知】；评审方案；会议地点；会议时间；方案地址；参与人员；评审结果；评审意见。" +
            "评审意见按编号逐条输出。补充信息中明确写出的方案、地点、时间、地址、人员可以直接用于对应字段；" +
            "评审结果、评审意见必须来自转录全文或用户粘贴的已有纪要，未明确时写「未明确」，不得擅自写成通过。" +
            "如果原文明确记录不同参与人的意见，使用「姓名：意见」保留归属；无法确认说话人时不要猜测。" +
            "不要额外输出会议主题、讨论要点、决议、待办等其他模板字段。",
            new TranscribeStyleContextInput(
                "会议补充信息",
                "可粘贴评审邀请、方案信息或已有会议纪要。系统会用它补齐通知字段，不会覆盖录音原文。",
                "粘贴评审邀请、方案名称、会议时间、方案地址、参与人员或已有纪要",
                "【方案评审邀请通知】\n评审方案：示例方案\n会议地点：会议室\n会议时间：2026.7.15 下午 4:00 - 5:00\n方案地址：https://example.com\n@张三 @李四")),
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
