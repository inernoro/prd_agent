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

    /// <summary>
    /// 系统提示词。仍然不预设人设——加的只有一段路由说明：
    /// 平台里那些专业智能体现在是工具，得告诉它们什么时候该转派、转派完怎么说话，
    /// 否则它会自己硬写一版（该转不转），或者见谁都转（不该转也转）。
    /// </summary>
    public string SystemPrompt { get; set; } =
        "你是这个平台内置的通用助手。用中文回答，直接给结论，不要绕。" +
        "不知道就说不知道，不要编造事实、链接或数据。" +
        "平台里的专业智能体已经是你的工具：遇到它们的本行（工具描述里写明了什么时候该用），" +
        "直接调用，不要自己硬写一版，也不要反问用户「你要用哪个智能体」——挑谁是你的事。" +
        "本行之外的普通问答、总结、翻译由你自己完成，不要为了用工具而用工具。" +
        "转派拿到结果后，如实说明这是哪个智能体做的，不要把它的产出说成自己写的。" +
        "用户询问知识库内容时，先用 kb_search 的 semantic 模式检索，再用 kb_read 核对原文。" +
        "只根据本轮有权限读取的原文回答，逐项附上工具返回的 source.uri Markdown 链接与原句；不要编造链接。" +
        "没有证据就明确说知识库未找到依据；检索失败时说明原因，不能把自身常识当成知识库结论。" +
        "只有用户明确要求将指定文档建立检索索引时才调用 kb_index，不能自行遍历或重建知识库。";

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

    /// <summary>
    /// 暴露给这次对话的工具白名单。
    ///
    /// 原契约钉死在四把（出图、存知识库、搜知识库、读知识库），并写明「想加第五把必须先经决策者同意」。
    /// 2026-08-07 决策者明确要求「智能体应该被动选中，封装成技能交给通用智能体调用」，
    /// 据此扩到七把：新增的三把是把平台已有专业智能体包成的转派工具（文学 / 缺陷 / PRD）。
    /// 这是一次**显式批准的扩范围**，不是悄悄加的——记在这里，下一个人不必再考古。
    ///
    /// 视觉创作刻意没有进来：出图能力已经由 chat_generate_image 覆盖（同一条平台出图流水线），
    /// 再登一把只会让模型面对两把同功能的工具。判据见 AgentCapabilityRegistry 里视觉那条的注释。
    ///
    /// 2026-11-12 用户明确要求知识入库到原文引用闭环，据此新增第八把 kb_index，限明确指定的单篇索引；不允许自动全库重建。
    /// </summary>
    public List<string> Tools { get; set; } = new()
    {
        "chat_generate_image",
        "chat_save_note",
        "kb_search",
        "kb_read",
        "kb_index",
        "agent_literary_write",
        "agent_defect_extract",
        "agent_prd_analyze",
    };
}
