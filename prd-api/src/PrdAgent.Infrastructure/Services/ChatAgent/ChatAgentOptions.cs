namespace PrdAgent.Infrastructure.Services.ChatAgent;

/// <summary>
/// 通用对话智能体的运行参数。全部是「传给运行时的入参」，不是我们自己实现的机制——
/// 轮数上限、超时、模型都由官方 SDK 按这些值执行。
/// </summary>
public sealed class ChatAgentOptions
{
    public const string SectionName = "ChatAgent";

    /// <summary>平台默认模型。会话未指定 Model 时用它；值原样透传给运行时。</summary>
    public string Model { get; set; } = "claude-opus-4-5";

    /// <summary>系统提示词。刻意短：通用对话不预设人设，人设是明确不做的事之一。</summary>
    public string SystemPrompt { get; set; } =
        "你是这个平台内置的通用助手。用中文回答，直接给结论，不要绕。" +
        "不知道就说不知道，不要编造事实、链接或数据。";

    /// <summary>单轮最大 token。</summary>
    public int MaxTokens { get; set; } = 4096;

    /// <summary>
    /// 交给运行时的轮数硬上限。阶段一零工具，模型本来就不会多轮循环；
    /// 留有余量是为了阶段二挂上工具后不用再调这里。
    /// </summary>
    public int MaxTurns { get; set; } = 8;

    /// <summary>单轮超时秒数。超过由运行时收尾，我们把它翻译成一条失败事件。</summary>
    public int TimeoutSeconds { get; set; } = 300;

    /// <summary>带给运行时的历史消息条数上限，防止长会话把上下文撑爆。</summary>
    public int HistoryLimit { get; set; } = 40;

    /// <summary>标题自动截取长度。</summary>
    public int TitleLength { get; set; } = 20;
}
