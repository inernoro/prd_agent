using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 通用对话智能体的会话。
///
/// 刻意与 InfraAgentSession 分开：那一套绑着基础设施运维的连接、工作区与审批语义，
/// 混进通用对话会互相污染，日后谁都不敢动（见 doc/design.platform.chat-agent.md 取舍五）。
/// 本模型只有「谁的会话、叫什么、现在有没有在跑」三件事。
/// </summary>
[BsonIgnoreExtraElements]
public class ChatAgentSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>会话归属用户。列表与读写一律按这个字段过滤，不做跨用户可见。</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>会话标题。首条用户消息自动截取，可改名。</summary>
    public string Title { get; set; } = "新会话";

    /// <summary>
    /// 本会话使用的模型。为空表示跟随平台默认（ChatAgentOptions.Model）。
    /// 值原样透传给运行时，再由模型网关按模型池路由。
    /// </summary>
    public string? Model { get; set; }

    /// <summary>
    /// 当前正在跑的轮次 Id；为空表示空闲。
    /// 事件流据此判断「追平之后是继续等还是可以收流」。
    /// </summary>
    public string? RunningTurnId { get; set; }

    /// <summary>
    /// 当前这一轮的起始事件序号（turn_started 那条的 Seq）。
    /// 断线重连时前端从这里起订，正好补齐本轮增量：
    /// 既不会漏掉长回答的前半段，也不会把上一轮的增量灌进这一轮。
    /// 轮次结束时随 RunningTurnId 一起清空。
    /// </summary>
    public long? RunningTurnStartSeq { get; set; }

    /// <summary>
    /// 会话内事件序号水位线。事件入库前用 $inc 原子自增取号，
    /// 保证断线重连能按 afterSeq 精确续订、不重不漏。
    /// </summary>
    public long EventSeq { get; set; }

    /// <summary>
    /// 部署作用域戳。共享 Mongo 下区分数据来源，避免分支预览与生产互相看见对方的会话
    /// （见 .claude/rules/cross-project-isolation.md 通道 8）。生产为 null。
    /// </summary>
    public string? DeploymentSlug { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除。删除只置位，历史事件与消息保留，便于排障。</summary>
    public bool Deleted { get; set; }
}

/// <summary>
/// 会话里的一条消息。assistant 消息在流式过程中持续累积 Content，done 时定稿。
/// </summary>
[BsonIgnoreExtraElements]
public class ChatAgentMessage
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string SessionId { get; set; } = string.Empty;

    /// <summary>所属轮次。一轮 = 一条用户消息加它触发的一条助手消息。</summary>
    public string TurnId { get; set; } = string.Empty;

    /// <summary>
    /// 轮内序号：用户 0，助手 1。
    /// 一轮的两条消息是同一次批量插入，CreatedAt 可能一模一样，
    /// 只按时间排序会不稳定——端到端自测里就出现过「回答排在提问前面」。
    /// 排序统一按 (CreatedAt, Ordinal)，这一列负责打破同刻并列。
    /// </summary>
    public int Ordinal { get; set; }

    /// <summary>user 或 assistant。</summary>
    public string Role { get; set; } = ChatAgentRoles.User;

    public string Content { get; set; } = string.Empty;

    /// <summary>running / completed / failed。用户消息落库即 completed。</summary>
    public string Status { get; set; } = ChatAgentMessageStatus.Completed;

    /// <summary>失败原因，给用户看的人话；Status=failed 时非空。</summary>
    public string? Error { get; set; }

    /// <summary>失败错误码，便于排障与前端区分「运行时不可用」和「模型报错」。</summary>
    public string? ErrorCode { get; set; }

    public long? InputTokens { get; set; }

    public long? OutputTokens { get; set; }

    public string? DeploymentSlug { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? CompletedAt { get; set; }
}

/// <summary>
/// 会话事件流的一条事件。前端按 Seq 续订，服务端跑完即落库，
/// 客户端断开不影响这条链路继续写（服务端权威）。
/// </summary>
[BsonIgnoreExtraElements]
public class ChatAgentEvent
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string SessionId { get; set; } = string.Empty;

    public string TurnId { get; set; } = string.Empty;

    /// <summary>会话内单调递增序号，来自会话文档的原子自增。</summary>
    public long Seq { get; set; }

    public string Type { get; set; } = ChatAgentEventTypes.TextDelta;

    /// <summary>事件载荷 JSON。类型决定字段，前端按类型解析。</summary>
    public string PayloadJson { get; set; } = "{}";

    public string? DeploymentSlug { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public static class ChatAgentRoles
{
    public const string User = "user";
    public const string Assistant = "assistant";
}

public static class ChatAgentMessageStatus
{
    public const string Running = "running";
    public const string Completed = "completed";
    public const string Failed = "failed";
}

/// <summary>
/// 事件类型。刻意只保留通用对话用得上的这几种——运行时吐回来的其它类型
/// 统一折叠成 log，避免前端为一堆用不上的类型写分支。
/// </summary>
public static class ChatAgentEventTypes
{
    /// <summary>一轮开始，载荷含 turnId 与用户消息 id。</summary>
    public const string TurnStarted = "turn_started";

    /// <summary>模型流式文本增量。</summary>
    public const string TextDelta = "text_delta";

    /// <summary>模型的思考过程（运行时支持时才有）。</summary>
    public const string Thinking = "thinking";

    /// <summary>token 用量。</summary>
    public const string Usage = "usage";

    /// <summary>一轮正常结束，载荷含定稿全文。</summary>
    public const string Done = "done";

    /// <summary>一轮失败，载荷含错误码与人话原因。</summary>
    public const string Error = "error";

    /// <summary>其它运行时事件的兜底，只做诊断展示。</summary>
    public const string Log = "log";
}
