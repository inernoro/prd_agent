using System.Threading.Channels;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.ChatAgent;

/// <summary>
/// 进程内的一轮对话队列。作用只有一个：把模型这段等待从 HTTP 请求生命周期里挪出去，
/// 于是用户刷新或关掉页面，这一轮照样跑完（服务端权威）。
/// 需要跨实例时换成 Redis 队列即可，对外接口不变。
/// </summary>
public sealed class InMemoryChatAgentTurnQueue : IChatAgentTurnQueue
{
    private readonly Channel<ChatAgentTurnJob> _channel = Channel.CreateUnbounded<ChatAgentTurnJob>(
        new UnboundedChannelOptions { SingleReader = false, SingleWriter = false });

    public ValueTask EnqueueAsync(ChatAgentTurnJob job, CancellationToken ct) =>
        _channel.Writer.WriteAsync(job, ct);

    public IAsyncEnumerable<ChatAgentTurnJob> DequeueAsync(CancellationToken ct) =>
        _channel.Reader.ReadAllAsync(ct);
}
