namespace PrdAgent.Core.Models.AgentUniverse;

/// <summary>
/// 智能体能力契约（Agent Capability Contract）—— 智能体宇宙的"入口/出口"统一描述。
///
/// 每个智能体声明四件事：接受什么输入、产出什么输出、以什么模式被调用、前端该渲染什么交互。
/// 这是前后端共享的 SSOT：后端 <see cref="AgentCapabilityRegistry"/> 是权威源，前端通过
/// GET /api/agent-universe/capabilities 消费，禁止前端再维护一份业务映射表（frontend-architecture.md）。
///
/// 关键原则：契约**只描述边界**（I/O + 调用方式），**不携带任何业务行为**（提示词 / 模型）。
/// 业务行为一律由该智能体的真实组件（<c>IAgentAdapter</c>）承载——统一信封只"打通管道"，
/// 绝不在此复制一份提示词去仿冒智能体。这样用户改了智能体配置，本契约无需同步、不会漂移。
/// </summary>
public class AgentCapability
{
    /// <summary>智能体标识（与 IAgentAdapter.AgentKey / appKey 对齐）。</summary>
    public string AgentKey { get; set; } = string.Empty;

    /// <summary>展示名。</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>一句话描述。</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>Lucide 图标名。</summary>
    public string Icon { get; set; } = "Bot";

    /// <summary>主题强调色（hex）。</summary>
    public string Accent { get; set; } = "#60A5FA";

    /// <summary>接受的输入数据类型（取值见 <see cref="AgentDataKinds"/>）。</summary>
    public string[] Inputs { get; set; } = Array.Empty<string>();

    /// <summary>产出的输出数据类型（取值见 <see cref="AgentDataKinds"/>）。</summary>
    public string[] Outputs { get; set; } = Array.Empty<string>();

    /// <summary>调用模式（取值见 <see cref="AgentInvokeModes"/>）：决定输入如何组装给真实适配器。</summary>
    public string InvokeMode { get; set; } = AgentInvokeModes.Chat;

    /// <summary>前端交互形态（取值见 <see cref="AgentInteractions"/>）。</summary>
    public string Interaction { get; set; } = AgentInteractions.ChatStream;

    /// <summary>真实适配器动作（IAgentAdapter 的 action，如 text2img / extract_defect）。统一信封据此路由。</summary>
    public string DefaultAction { get; set; } = string.Empty;

    /// <summary>输入框占位提示，引导用户该输入什么。</summary>
    public string InputHint { get; set; } = string.Empty;

    /// <summary>提交按钮文案（如"生成图片" / "发送" / "提取缺陷"）。</summary>
    public string ActionLabel { get; set; } = "发送";

    /// <summary>
    /// 智能体专属"出站动作"（巧思）：把产出送回它自己的原生系统，而不只是写回文档。
    /// 例：缺陷智能体 → 创建缺陷。选中智能体时前端会展示这些动作作为"智能涌现"提示。
    /// 通用的"替换/追加/另存到当前文档"由前端默认提供，不在此列。
    /// </summary>
    public List<AgentOutboundAction> OutboundActions { get; set; } = new();
}

/// <summary>智能体专属出站动作：产出 → 该智能体的原生系统（缺陷库 / 工作流 / …）。</summary>
public class AgentOutboundAction
{
    /// <summary>动作标识，前端据此路由到对应系统（如 "create-defect"）。</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>按钮文案（如"创建缺陷"）。</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>Lucide 图标名。</summary>
    public string Icon { get; set; } = "Send";

    /// <summary>一句话说明，用于"智能涌现"提示（如"把抽取的缺陷直接建入缺陷库"）。</summary>
    public string Hint { get; set; } = string.Empty;
}

/// <summary>输入/输出数据类型常量。统一前后端对"数据形态"的命名，杜绝各处自定义字符串。</summary>
public static class AgentDataKinds
{
    public const string Text = "text";
    public const string Document = "document";
    public const string Image = "image";
    public const string Audio = "audio";
    public const string Structured = "structured";
    public const string Video = "video";
}

/// <summary>调用模式常量。决定统一信封把"用户指令 + 文档"如何组装给真实适配器。</summary>
public static class AgentInvokeModes
{
    /// <summary>流式文本对话：用户指令 + 参考文档合成后交给适配器。</summary>
    public const string Chat = "chat";

    /// <summary>媒体生成（图片/视频）：用户输入即生成描述（prompt），文档不强制注入。</summary>
    public const string Generation = "generation";

    /// <summary>结构化抽取（JSON / 缺陷字段）：与 chat 同样合成输入，输出带结构。</summary>
    public const string Structured = "structured";

    /// <summary>文档转换（doc→doc，整篇改写）。</summary>
    public const string Transform = "transform";
}

/// <summary>前端交互形态常量。决定 ReprocessChatDrawer 等入口渲染哪种输入/输出 UI。</summary>
public static class AgentInteractions
{
    /// <summary>聊天流：输入指令、流式文本回复、可写回文档。</summary>
    public const string ChatStream = "chat-stream";

    /// <summary>文生图：输入画面描述、生成图片、可插入文档。</summary>
    public const string PromptToImage = "prompt-to-image";

    /// <summary>图文一体：输入文章、一次性产出图文搭配。</summary>
    public const string ArticleToIllustrated = "article-to-illustrated";

    /// <summary>表单提交：填写/粘贴后提交，产出结构化结果。</summary>
    public const string FormSubmit = "form-submit";
}

/// <summary>
/// 智能体可选参数（如视觉的尺寸/模型）。选项一律来自该智能体**真实**的池/模型配置，
/// 绝不编造；只有「确实有多个可选项」时才下发（如果不可选就不给选择器，避免假选项）。
/// 用户在面板上选好后，经统一信封 invoke 的 parameters 透传给真实适配器。
/// </summary>
public class AgentParameter
{
    /// <summary>参数键，透传给适配器 Input（如 "size" / "model"）。</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>展示标签（如「尺寸」「模型」）。</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>控件类型，目前只有 select。</summary>
    public string Type { get; set; } = "select";

    /// <summary>真实可选项。</summary>
    public List<AgentParameterOption> Options { get; set; } = new();

    /// <summary>默认值（取真实选项里的第一个/最高优先级）。</summary>
    public string? Default { get; set; }
}

/// <summary>单个可选项。</summary>
public class AgentParameterOption
{
    public string Value { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
}
