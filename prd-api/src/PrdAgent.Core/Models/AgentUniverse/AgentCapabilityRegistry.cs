namespace PrdAgent.Core.Models.AgentUniverse;

/// <summary>
/// 智能体能力契约注册表（SSOT）。
///
/// 新增/修改一个智能体在"智能体宇宙"里的输入输出契约只改这一处；前端通过
/// GET /api/agent-universe/capabilities 自动同步，无需在前端重复声明。
///
/// 约定：<see cref="AgentInvokeModes.Generation"/> 的智能体必须有对应 <c>IAgentAdapter</c>
/// 支持其 <see cref="AgentCapability.DefaultAction"/>，否则 AgentUniverseController 会降级为
/// chat（用 <see cref="AgentCapability.SystemPrompt"/> 走通用文本链路）。
/// </summary>
public static class AgentCapabilityRegistry
{
    public static readonly IReadOnlyList<AgentCapability> All = new List<AgentCapability>
    {
        // ── 生成型：文字 → 图片（路由到 VisualAgentAdapter.text2img，产出真实图片 artifact）──
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
            SystemPrompt = "你是一位视觉设计专家，帮助用户描述和规划视觉创作需求，提供设计建议和创意方向。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Agents.VisualChat,
        },

        // ── 文学：文档/文字 → 改写后的文本（图文一体为后续能力，先以聊天流交付）──
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
            SystemPrompt = "你是一位文学创作专家，擅长各类文体的创作和润色。可以把给定的文档改写成更有感染力的叙事、散文、故事，也可以续写、润色、调整文风。请直接输出成品文本，不要附加多余说明。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Agents.LiteraryChat,
        },

        // ── 缺陷：文档/描述 → 结构化缺陷（表单形态）──
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
            SystemPrompt = "你是一位质量保证专家，擅长缺陷分析。请从用户给定的内容中提取结构化的缺陷信息，包含：标题、描述、复现步骤、预期结果、实际结果、严重程度、影响范围，并以清晰的 Markdown 结构输出。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Agents.DefectChat,
        },

        // ── 周报：文档 → 周报草稿（聊天流）──
        new()
        {
            AgentKey = "report-agent",
            Name = "周报智能体",
            Description = "基于文档生成 / 汇总周报，结构化呈现完成项与计划",
            Icon = "FileBarChart",
            Accent = "#60A5FA",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Text },
            InvokeMode = AgentInvokeModes.Chat,
            Interaction = AgentInteractions.ChatStream,
            DefaultAction = string.Empty,
            InputHint = "让我基于这篇文档生成或汇总一份周报",
            ActionLabel = "发送",
            SystemPrompt = "你是一位周报撰写专家。请基于用户提供的内容，输出结构清晰的周报，包含：本周完成、关键进展、风险/阻塞、下周计划。语言精炼、突出重点。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Orchestration.Chat,
        },

        // ── 任务树：文档 → 任务层级（聊天流，结构化文本）──
        new()
        {
            AgentKey = "task-tree-agent",
            Name = "任务树智能体",
            Description = "从文档中抽取任务层级，拆解为可执行的子任务",
            Icon = "Layers",
            Accent = "#38BDF8",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Structured, AgentDataKinds.Text },
            InvokeMode = AgentInvokeModes.Structured,
            Interaction = AgentInteractions.FormSubmit,
            DefaultAction = string.Empty,
            InputHint = "让我把这篇文档拆解成任务树",
            ActionLabel = "拆解任务",
            SystemPrompt = "你是一位任务拆解专家。请把用户提供的内容拆解为层级化的任务树，用缩进的 Markdown 列表表示父子关系，每个叶子任务应当可独立执行、可验收。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Orchestration.Chat,
        },

        // ── 项目管理：文档 → 拆解与排期（聊天流）──
        new()
        {
            AgentKey = "pm-agent",
            Name = "项目管理智能体",
            Description = "把需求拆解为里程碑与任务，给出排期与依赖建议",
            Icon = "Briefcase",
            Accent = "#818CF8",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Text },
            InvokeMode = AgentInvokeModes.Chat,
            Interaction = AgentInteractions.ChatStream,
            DefaultAction = string.Empty,
            InputHint = "让我把这篇文档拆成里程碑、任务与排期",
            ActionLabel = "发送",
            SystemPrompt = "你是一位资深项目经理。请把用户提供的需求拆解为里程碑和任务，标注优先级、依赖关系和大致排期，输出结构化的 Markdown。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Orchestration.Chat,
        },

        // ── 行政秘书（毒舌秘书）：文档 → MECE 梳理（聊天流）──
        new()
        {
            AgentKey = "pa-agent",
            Name = "行政秘书智能体",
            Description = "按 MECE 原则梳理文档，直指问题、责任到人",
            Icon = "ClipboardList",
            Accent = "#F472B6",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Text },
            InvokeMode = AgentInvokeModes.Chat,
            Interaction = AgentInteractions.ChatStream,
            DefaultAction = string.Empty,
            InputHint = "让我用 MECE 原则梳理这篇文档",
            ActionLabel = "发送",
            SystemPrompt = "你是一位高效的执行助理，奉行 MECE 原则。请把用户提供的内容梳理成相互独立、完全穷尽的要点，直面问题、抓主要矛盾、责任到人，语言直率不含糊。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Orchestration.Chat,
        },

        // ── PRD 分析师：文档 → 需求解读（聊天流）──
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
            DefaultAction = "answer_question",
            InputHint = "问我关于这篇 PRD 的任何问题，或让我找出缺口",
            ActionLabel = "发送",
            SystemPrompt = "你是一位专业的产品经理，擅长 PRD 分析和需求解读。帮助用户分析需求文档，发现潜在问题、逻辑缺口和遗漏，回答产品相关问题。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Agents.PrdChat,
        },

        // ── 通用工具型（聊天流）──
        new()
        {
            AgentKey = "code-reviewer",
            Name = "代码审查",
            Description = "审查代码质量、Bug、安全与性能问题",
            Icon = "Code",
            Accent = "#A3E635",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Text },
            InvokeMode = AgentInvokeModes.Chat,
            Interaction = AgentInteractions.ChatStream,
            DefaultAction = string.Empty,
            InputHint = "把代码贴进来，或让我审查这篇文档里的代码",
            ActionLabel = "发送",
            SystemPrompt = "你是一位资深的代码审查专家。分析代码质量、可读性、可维护性，发现潜在 Bug、安全漏洞和性能问题，给出改进建议。请用结构化方式输出：问题严重程度（Critical/Warning/Info）、问题描述、建议方案。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Orchestration.Chat,
        },
        new()
        {
            AgentKey = "translator",
            Name = "翻译",
            Description = "中英日韩多语言互译，保持术语一致",
            Icon = "Languages",
            Accent = "#2DD4BF",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Text },
            InvokeMode = AgentInvokeModes.Chat,
            Interaction = AgentInteractions.ChatStream,
            DefaultAction = string.Empty,
            InputHint = "把要翻译的内容贴进来，或翻译这篇文档",
            ActionLabel = "翻译",
            SystemPrompt = "你是一位专业的多语言翻译专家，精通中英日韩等主要语言。准确传达原文含义，符合目标语言表达习惯，专业术语保持一致。自动检测源语言，默认翻译为中文（源语言是中文则译为英文）。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Orchestration.Chat,
        },
        new()
        {
            AgentKey = "summarizer",
            Name = "内容摘要",
            Description = "从长文本提取核心要点与关键数据",
            Icon = "Sparkles",
            Accent = "#FBBF24",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Text },
            InvokeMode = AgentInvokeModes.Chat,
            Interaction = AgentInteractions.ChatStream,
            DefaultAction = string.Empty,
            InputHint = "让我把这篇文档浓缩成核心要点",
            ActionLabel = "摘要",
            SystemPrompt = "你是一位内容摘要专家。识别核心主题与关键论点，提取重要数据、事实和结论，保持逻辑连贯。按以下格式输出：**核心要点**（3-5 个）、**详细摘要**、**关键数据**。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Orchestration.Chat,
        },
        new()
        {
            AgentKey = "data-analyst",
            Name = "数据分析",
            Description = "解读数据趋势、异常，给出可视化建议",
            Icon = "BarChart3",
            Accent = "#34D399",
            Inputs = new[] { AgentDataKinds.Text, AgentDataKinds.Document },
            Outputs = new[] { AgentDataKinds.Text },
            InvokeMode = AgentInvokeModes.Chat,
            Interaction = AgentInteractions.ChatStream,
            DefaultAction = string.Empty,
            InputHint = "把数据贴进来，或让我分析这篇文档里的数据",
            ActionLabel = "分析",
            SystemPrompt = "你是一位数据分析专家。分析数据趋势、异常和模式，提供统计分析思路，推荐合适的可视化图表，给出数据驱动的业务洞察。结构化输出：分析思路、关键发现、可视化建议、行动建议。",
            ChatAppCallerCode = AppCallerRegistry.AiToolbox.Orchestration.Chat,
        },
    };

    /// <summary>按 agentKey 查找能力契约，找不到返回 null。</summary>
    public static AgentCapability? Find(string? agentKey)
        => string.IsNullOrWhiteSpace(agentKey)
            ? null
            : All.FirstOrDefault(c => c.AgentKey == agentKey);
}
