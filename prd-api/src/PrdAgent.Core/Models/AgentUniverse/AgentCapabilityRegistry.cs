namespace PrdAgent.Core.Models.AgentUniverse;

/// <summary>
/// 智能体能力契约注册表（SSOT）。
///
/// 这里**只登记有真实组件（IAgentAdapter）的智能体**——契约里的 <see cref="AgentCapability.AgentKey"/>
/// + <see cref="AgentCapability.DefaultAction"/> 必须能被某个 <c>IAgentAdapter.CanHandle</c> 命中，
/// 否则 AgentUniverseController 会明确报错（NO_REAL_AGENT），**绝不降级成硬编码提示词的"假聊天"**。
///
/// 没有真实适配器的能力（周报 / PM / 翻译 / 摘要 等）一律不登记——宁可不暴露，也不伪装。
/// 等它们接入各自真实服务后再按此格式登记。
/// </summary>
public static class AgentCapabilityRegistry
{
    public static readonly IReadOnlyList<AgentCapability> All = new List<AgentCapability>
    {
        // ── 视觉创作：文字 → 图片（路由到 VisualAgentAdapter.text2img，产出真实图片 artifact）──
        new()
        {
            AgentKey = "visual-agent",
            Name = "视觉创作智能体",
            Description = "把文字描述变成图片：文生图、图生图、多图组合",
            Icon = "Image",
            Accent = "#A78BFA",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Image },
            Outputs = new[] { AgentDataKinds.Image },
            InvokeMode = AgentInvokeModes.Generation,
            Interaction = AgentInteractions.PromptToImage,
            DefaultAction = "text2img",
            InputHint = "描述你想要的画面，例如：赛博朋克风格的城市夜景，霓虹灯，雨夜",
            ActionLabel = "生成图片",
        },

        // ── 文学创作：文档/文字 → 改写后的文本（路由到 LiteraryAgentAdapter.write_content）──
        new()
        {
            AgentKey = "literary-agent",
            Name = "文学创作智能体",
            Description = "把文档改写成有感染力的叙事 / 散文 / 故事，可续写润色",
            Icon = "PenLine",
            Accent = "#4ADE80",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Text },
            InvokeMode = AgentInvokeModes.Chat,
            Interaction = AgentInteractions.ChatStream,
            DefaultAction = "write_content",
            InputHint = "告诉我怎么改写、续写或润色这篇文档",
            ActionLabel = "发送",
        },

        // ── 缺陷管理：文档/描述 → 结构化缺陷（路由到 DefectAgentAdapter.extract_defect）──
        new()
        {
            AgentKey = "defect-agent",
            Name = "缺陷管理智能体",
            Description = "从文档/描述中提取结构化缺陷（标题、复现步骤、严重程度）",
            Icon = "Bug",
            Accent = "#FB923C",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Structured, AgentDataKinds.Text },
            InvokeMode = AgentInvokeModes.Structured,
            Interaction = AgentInteractions.FormSubmit,
            DefaultAction = "extract_defect",
            InputHint = "粘贴缺陷描述，或让我从这篇文档提取结构化缺陷",
            ActionLabel = "提取缺陷",
        },

        // ── PRD 解读：文档 → 需求分析（路由到 PrdAgentAdapter.analyze_prd）──
        new()
        {
            AgentKey = "prd-agent",
            Name = "PRD 解读智能体",
            Description = "解读需求文档，发现潜在问题与缺口",
            Icon = "FileText",
            Accent = "#22D3EE",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Text },
            InvokeMode = AgentInvokeModes.Chat,
            Interaction = AgentInteractions.ChatStream,
            DefaultAction = "analyze_prd",
            InputHint = "让我分析这篇 PRD 的完整性、逻辑与缺口",
            ActionLabel = "分析",
        },
    };

    /// <summary>按 agentKey 查找能力契约，找不到返回 null。</summary>
    public static AgentCapability? Find(string? agentKey)
        => string.IsNullOrWhiteSpace(agentKey)
            ? null
            : All.FirstOrDefault(c => c.AgentKey == agentKey);
}
