using System.Text.Json.Serialization;

namespace PrdAgent.Core.Models.AgentUniverse;

/// <summary>
/// 智能体能力契约（Agent Capability Contract）—— 智能体宇宙的"入口/出口"统一描述。
///
/// 每个智能体声明四件事：接受什么输入、产出什么输出、以什么模式被调用、前端该渲染什么交互。
/// 这是前后端共享的 SSOT：后端 <see cref="AgentCapabilityRegistry"/> 是权威源，前端通过
/// GET /api/agent-universe/capabilities 消费，禁止前端再维护一份业务映射表（frontend-architecture.md）。
///
/// 调用模式（<see cref="InvokeMode"/>）决定后端把请求路由到 <c>IAgentAdapter</c>（真实生图/结构化）
/// 还是通用 chat 链路；交互形态（<see cref="Interaction"/>）决定前端渲染聊天流 / 文生图 / 表单。
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

    /// <summary>调用模式（取值见 <see cref="AgentInvokeModes"/>）：决定后端路由到适配器还是通用 chat。</summary>
    public string InvokeMode { get; set; } = AgentInvokeModes.Chat;

    /// <summary>前端交互形态（取值见 <see cref="AgentInteractions"/>）。</summary>
    public string Interaction { get; set; } = AgentInteractions.ChatStream;

    /// <summary>默认适配器动作（IAgentAdapter 的 action，如 text2img）。仅 generation/structured 模式有意义。</summary>
    public string DefaultAction { get; set; } = string.Empty;

    /// <summary>输入框占位提示，引导用户该输入什么。</summary>
    public string InputHint { get; set; } = string.Empty;

    /// <summary>提交按钮文案（如"生成图片" / "发送" / "提取缺陷"）。</summary>
    public string ActionLabel { get; set; } = "发送";

    /// <summary>
    /// chat 模式的系统提示词。仅后端使用，<see cref="JsonIgnore"/> 禁止下发前端
    /// （避免泄露 prompt + 保持前端无业务逻辑）。
    /// </summary>
    [JsonIgnore]
    public string SystemPrompt { get; set; } = string.Empty;

    /// <summary>
    /// chat 模式使用的 AppCallerCode（来自 AppCallerRegistry）。仅后端使用，不下发前端。
    /// </summary>
    [JsonIgnore]
    public string ChatAppCallerCode { get; set; } = string.Empty;
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

/// <summary>调用模式常量。</summary>
public static class AgentInvokeModes
{
    /// <summary>流式文本对话（走 LLM Gateway chat）。</summary>
    public const string Chat = "chat";

    /// <summary>媒体生成（图片/视频），路由到对应 IAgentAdapter 产出 artifact。</summary>
    public const string Generation = "generation";

    /// <summary>结构化抽取（JSON / 缺陷字段 / 表单），输出带结构的文本。</summary>
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
