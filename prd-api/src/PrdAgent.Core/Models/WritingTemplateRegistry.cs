namespace PrdAgent.Core.Models;

public record WritingHeading(string Title, string Hint);
public record WritingTemplate(string Id, string Name, string Type, string Role, string UseWhen, IReadOnlyList<WritingHeading> Headings, string Version = "1.0");

// Source: user-provided MAP 写作模版包 v1.0. Examples deliberately excluded.
public static class WritingTemplateRegistry
{
    public static readonly IReadOnlyList<WritingTemplate> All = new List<WritingTemplate>
    {
        new("overview", "总览模版", "总览", "primary", "做合集的主文档；读者需要先知道结论和阅读顺序时。", new WritingHeading[] { new WritingHeading("结论摘要", "3–5 条结论，每条一句话"), new WritingHeading("评审范围与议程", "覆盖什么、不覆盖什么"), new WritingHeading("各方向阅读顺序", "按合集章节列出先读哪份"), new WritingHeading("待决问题", "需要评审会拍板的事项"), new WritingHeading("附录说明", "历次纪要与数据口径") }),
        new("tech-spec", "技术方案模版", "技术方案", "member", "需要评审拍板的方案设计、架构调整、选型。", new WritingHeading[] { new WritingHeading("背景与问题", "现在哪里不够好，有数据最好"), new WritingHeading("目标与非目标", "这次解决什么、明确不解决什么"), new WritingHeading("方案设计", "主方案与被放弃的方案"), new WritingHeading("风险与回滚", "出问题时怎么退回"), new WritingHeading("里程碑", "时间点与负责人") }),
        new("research", "调研报告模版", "调研报告", "member", "对比方案、评估工具、用户或数据调研，结论需要可复核。", new WritingHeading[] { new WritingHeading("调研问题", "一句话写清要回答的问题"), new WritingHeading("方法与样本", "样本来源、数量与评分方式"), new WritingHeading("主要发现", "按重要性排列"), new WritingHeading("建议", "对决策者的直接建议"), new WritingHeading("局限", "哪些结论不能外推") }),
        new("retro", "复盘模版", "复盘", "member", "故障、上线、项目结束后的回顾。", new WritingHeading[] { new WritingHeading("影响范围", "受影响的用户、数据与时长"), new WritingHeading("时间线", "发现、响应、恢复的关键时间点"), new WritingHeading("根因", "追问到可以修的那一层"), new WritingHeading("做得好的与不足", "流程层面，不点名个人"), new WritingHeading("改进项", "事项、负责人、截止时间") }),
        new("prd", "需求说明模版", "需求说明", "member", "新功能或改动立项，需要对齐范围和验收标准。", new WritingHeading[] { new WritingHeading("背景与用户", "谁在什么场景遇到什么问题"), new WritingHeading("目标与指标", "做到什么程度算成功"), new WritingHeading("需求范围", "本期做 / 不做"), new WritingHeading("功能说明", "按用户操作流程写"), new WritingHeading("验收标准", "可逐条检查的条件"), new WritingHeading("开放问题", "待确认事项与负责人") }),
        new("weekly", "数据周报模版", "数据周报", "member", "每周固定节奏的指标汇报。", new WritingHeading[] { new WritingHeading("本周结论", "3 条以内，先写异常"), new WritingHeading("核心指标", "与上周、目标值对比"), new WritingHeading("异常与原因", "已知原因 / 待查"), new WritingHeading("下周关注", "需要谁做什么"), new WritingHeading("口径说明", "数据来源与口径变化") }),
        new("minutes", "评审纪要模版", "评审纪要", "member", "评审会、决策会结束后 24 小时内。", new WritingHeading[] { new WritingHeading("结论", "通过 / 有条件通过 / 不通过"), new WritingHeading("讨论要点", "分歧点与各方理由"), new WritingHeading("行动项", "事项、负责人、截止时间"), new WritingHeading("遗留问题", "下次评审再议") }),
    };
    public static WritingTemplate? Find(string id) => All.FirstOrDefault(t => t.Id == id);
}
