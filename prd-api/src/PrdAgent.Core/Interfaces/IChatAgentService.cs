using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 通用对话智能体的适配层。
///
/// 这一层刻意很薄：它不实现任何对话循环——循环、上下文管理、工具调用协议
/// 全在 agent 运行时里的官方 SDK（见 doc/design.platform.chat-agent.md「写与不写的分界线」）。
/// 本服务只做四件事：管会话与消息、把一轮对话转发给运行时、把运行时事件翻译成落库事件、
/// 提供按序号续订的读取口。
/// </summary>
public interface IChatAgentService
{
    Task<IReadOnlyList<ChatAgentSessionView>> ListSessionsAsync(string userId, CancellationToken ct);

    Task<ChatAgentSessionView> CreateSessionAsync(string userId, string? title, string? model, CancellationToken ct);

    Task<ChatAgentSessionView?> GetSessionAsync(string userId, string sessionId, CancellationToken ct);

    Task<ChatAgentSessionView?> RenameSessionAsync(string userId, string sessionId, string title, CancellationToken ct);

    Task<bool> DeleteSessionAsync(string userId, string sessionId, CancellationToken ct);

    Task<IReadOnlyList<ChatAgentMessageView>> ListMessagesAsync(
        string userId, string sessionId, int limit, CancellationToken ct);

    /// <summary>
    /// 收下一句用户输入：落库、开一轮、入队。立刻返回，不在 HTTP 请求里等模型
    /// （服务端权威：客户端断开不取消这一轮）。
    /// </summary>
    Task<ChatAgentTurnAccepted> SendMessageAsync(
        string userId, string sessionId, string content, CancellationToken ct);

    /// <summary>后台 worker 调用：真正把这一轮转给运行时并把事件写回。</summary>
    Task RunTurnAsync(string sessionId, string turnId, CancellationToken ct);

    /// <summary>
    /// 启动收敛：把上一次进程留下的「还在跑」的轮次判死。
    ///
    /// 硬杀（OOM / 容器直接替换）时没有任何代码有机会跑收尾，会话的 RunningTurnId
    /// 会永远留着——页面一直显示在跑、再也发不出下一句，只能删会话。这一步是它的唯一出路。
    /// 只收本部署作用域内、且开始时间早于本进程启动的轮次（共享库里别人的轮次不许碰）。
    /// </summary>
    /// <returns>被判死的轮次数。</returns>
    Task<int> ReconcileInterruptedTurnsAsync(DateTime processStartedAt, CancellationToken ct);

    /// <summary>按序号读事件，用于 SSE 续订。</summary>
    Task<ChatAgentEventPage> ReadEventsAsync(
        string userId, string sessionId, long afterSeq, int limit, CancellationToken ct);
}

public sealed record ChatAgentSessionView(
    string Id,
    string Title,
    string? Model,
    string EffectiveModel,
    bool Running,
    long EventSeq,
    long? RunningTurnStartSeq,
    DateTime CreatedAt,
    DateTime UpdatedAt);

public sealed record ChatAgentMessageView(
    string Id,
    string TurnId,
    string Role,
    string Content,
    string Status,
    string? Error,
    string? ErrorCode,
    long? InputTokens,
    long? OutputTokens,
    DateTime CreatedAt,
    DateTime? CompletedAt);

public sealed record ChatAgentEventView(
    long Seq,
    string TurnId,
    string Type,
    string PayloadJson,
    DateTime CreatedAt);

/// <summary>读一页事件的结果。Running 决定 SSE 是继续挂着还是可以收流。</summary>
public sealed record ChatAgentEventPage(
    IReadOnlyList<ChatAgentEventView> Events,
    long LastSeq,
    bool Running);

public sealed record ChatAgentTurnAccepted(
    string TurnId,
    string UserMessageId,
    string AssistantMessageId,
    long Seq);

/// <summary>把一轮对话从 HTTP 请求生命周期里挪出去的进程内队列。</summary>
public interface IChatAgentTurnQueue
{
    ValueTask EnqueueAsync(ChatAgentTurnJob job, CancellationToken ct);

    IAsyncEnumerable<ChatAgentTurnJob> DequeueAsync(CancellationToken ct);
}

public sealed record ChatAgentTurnJob(string SessionId, string TurnId);
