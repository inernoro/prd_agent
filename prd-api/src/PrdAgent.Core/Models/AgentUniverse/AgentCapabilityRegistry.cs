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
            GeneralAgentHint = "通用助手可以直接出图，不用先选它；要用图生图、看图说话这类玩法再点进来。",
            // 刻意不给 ToolName：通用对话已经有 chat_generate_image，走的是同一条平台出图流水线
            // （同样入 image_gen_runs、同样落素材库）。再登一把只会让模型面对两把同功能的工具。
            // 视觉体独有的 img2img / describe_image / compose 尚未成为工具，见 debt.knowledge-base。
        },

        // ── 文学创作：文档/文字 → 改写后的文本（路由到 LiteraryAgentAdapter.write_content）──
        new()
        {
            AgentKey = "literary-agent",
            Name = "文学创作智能体",
            Description = "把文档改写成有感染力的叙事 / 散文 / 故事，可续写润色并生成配图",
            Icon = "PenLine",
            Accent = "#4ADE80",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Text, AgentDataKinds.Image },
            InvokeMode = AgentInvokeModes.Chat,
            Interaction = AgentInteractions.ChatStream,
            DefaultAction = "write_content",
            InputHint = "告诉我怎么改写、续写或润色这篇文档",
            ActionLabel = "发送",
            GeneralAgentHint = "说「改写成故事」「润色一下」这类要求时，通用助手会自己找它。",
            ToolName = "agent_literary_write",
            ToolWhenToUse = "用户要把一段内容改写成叙事/散文/故事，或要续写、润色、换一种笔调重讲时用它。"
                            + "普通的总结、翻译、答疑不要用——那是你自己该做的事。",
            OutboundActions = new()
            {
                new AgentOutboundAction
                {
                    Key = "illustrate",
                    Label = "为这段配图",
                    Icon = "ImagePlus",
                    Hint = "把这段文字构思成插画描述，并在文学创作内生成配图",
                },
            },
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
            GeneralAgentHint = "说「这个有问题，帮我开个单」时，通用助手会自己找它。",
            ToolName = "agent_defect_extract",
            ToolWhenToUse = "用户在描述一个坏掉的行为、或要把一段吐槽/会议记录整理成缺陷单时用它，"
                            + "产出标题、复现步骤、严重程度等结构化字段。只是讨论问题、还没到要开单，不用调。",
            OutboundActions = new()
            {
                new AgentOutboundAction
                {
                    Key = "create-defect",
                    Label = "创建缺陷",
                    Icon = "Bug",
                    Hint = "把抽取的缺陷直接建入缺陷库（标题自动归一，可后续指派）",
                },
            },
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
            GeneralAgentHint = "拿一篇需求文档问「写全了没」时，通用助手会自己找它。",
            ToolName = "agent_prd_analyze",
            ToolWhenToUse = "用户拿来一篇需求文档/PRD，问它写得全不全、有没有漏洞、有哪些没说清的地方时用它。"
                            + "只是让你概括一下文档讲了什么，不用调。",
        },
    };

    /// <summary>
    /// 可被通用对话智能体自己转派的能力（声明了 ToolName 的那些）。
    /// 通用体的工具清单从这里长出来，不另抄一份名单——否则加了能力忘了加工具、
    /// 或者删了能力工具还挂着（形状 2：链路只建一半）。
    /// </summary>
    public static readonly IReadOnlyList<AgentCapability> Delegatable =
        All.Where(c => !string.IsNullOrWhiteSpace(c.ToolName)).ToList();

    /// <summary>按 agentKey 查找能力契约，找不到返回 null。</summary>
    public static AgentCapability? Find(string? agentKey)
        => string.IsNullOrWhiteSpace(agentKey)
            ? null
            : All.FirstOrDefault(c => c.AgentKey == agentKey);
}
