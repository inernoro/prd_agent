using PrdAgent.Core.Interfaces;

namespace PrdAgent.Api.Services;

/// <summary>
/// 把排队的对话轮次跑掉。它不实现任何对话逻辑——只是把 job 交给适配层，
/// 由适配层转给 agent 运行时。放在这里是为了让一轮对话脱离 HTTP 请求生命周期。
/// </summary>
public sealed class ChatAgentTurnWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IChatAgentTurnQueue _queue;
    private readonly ILogger<ChatAgentTurnWorker> _logger;

    public ChatAgentTurnWorker(
        IServiceScopeFactory scopeFactory,
        IChatAgentTurnQueue queue,
        ILogger<ChatAgentTurnWorker> logger)
    {
        _scopeFactory = scopeFactory;
        _queue = queue;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var job in _queue.DequeueAsync(stoppingToken))
        {
            // 每个 job 独立起一个任务：一轮对话可能跑几分钟，串行会让后面的人干等。
            _ = Task.Run(async () =>
            {
                try
                {
                    using var scope = _scopeFactory.CreateScope();
                    var chat = scope.ServiceProvider.GetRequiredService<IChatAgentService>();
                    await chat.RunTurnAsync(job.SessionId, job.TurnId, stoppingToken);
                }
                catch (Exception ex)
                {
                    // RunTurnAsync 内部已把失败落库成事件；这里只兜底日志，
                    // 避免异常逃逸把整个 worker 拖挂。
                    _logger.LogError(ex,
                        "[ChatAgent] 轮次 worker 异常 session={SessionId} turn={TurnId}",
                        job.SessionId, job.TurnId);
                }
            }, CancellationToken.None);
        }
    }
}
