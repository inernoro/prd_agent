using System.Collections.Concurrent;
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

    /// <summary>在跑的轮次。停机时要等它们把「这一轮失败了」写完再放行（server-authority 规则 5）。</summary>
    private readonly ConcurrentDictionary<Task, byte> _inFlight = new();

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
        await ReconcileAsync(stoppingToken);

        await foreach (var job in _queue.DequeueAsync(stoppingToken))
        {
            // 每个 job 独立起一个任务：一轮对话可能跑几分钟，串行会让后面的人干等。
            var task = Task.Run(async () =>
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
            // 先登记再挂摘除回调：反过来的话，任务若已跑完，摘除会早于登记，条目永远留着。
            _inFlight.TryAdd(task, 0);
            _ = task.ContinueWith(t => _inFlight.TryRemove(t, out _), TaskScheduler.Default);
        }
    }

    /// <summary>
    /// 停机时先让基类取消 stoppingToken（在跑的轮次据此走「被打断」收尾），
    /// 再等这些收尾真的写完。不等的话进程会在写库之前退出，会话的「在跑」标记就留在库里，
    /// 用户下次进来看到一个永远转圈、再也发不出话的会话。
    /// </summary>
    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        await base.StopAsync(cancellationToken);

        var pending = _inFlight.Keys.ToArray();
        if (pending.Length == 0) return;

        _logger.LogInformation("[ChatAgent] 停机：等待 {Count} 轮把中断收尾写完", pending.Length);
        try
        {
            // 收尾只是几次写库，给它一点时间；宿主的停机预算耗尽也不硬等。
            await Task.WhenAll(pending).WaitAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // 没等到也不要紧：下次启动的收敛会把它们判死（ReconcileInterruptedTurnsAsync）。
            _logger.LogWarning("[ChatAgent] 停机预算用尽，仍有轮次未收尾，交给下次启动收敛");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "[ChatAgent] 停机等待轮次收尾时出错");
        }
    }

    private async Task ReconcileAsync(CancellationToken ct)
    {
        try
        {
            using var scope = _scopeFactory.CreateScope();
            var chat = scope.ServiceProvider.GetRequiredService<IChatAgentService>();
            await chat.ReconcileInterruptedTurnsAsync(DateTime.UtcNow, ct);
        }
        catch (Exception ex)
        {
            // 收敛失败不该挡住 worker 起来：新的轮次照跑，老的下次再收。
            _logger.LogError(ex, "[ChatAgent] 启动收敛失败");
        }
    }
}
