using System.Collections.Concurrent;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 内存 Run 队列 - Redis 不可用时的 fallback
/// 注意：仅用于开发环境，不支持分布式场景
/// </summary>
public class MemoryRunQueue : IRunQueue
{
    private readonly ConcurrentDictionary<string, ConcurrentQueue<string>> _queues = new();

    public Task EnqueueAsync(string kind, string runId, CancellationToken ct = default)
    {
        var queue = _queues.GetOrAdd(kind, _ => new ConcurrentQueue<string>());
        queue.Enqueue(runId);
        return Task.CompletedTask;
    }

    public async Task<string?> DequeueAsync(string kind, TimeSpan timeout, CancellationToken ct = default)
    {
        var queue = _queues.GetOrAdd(kind, _ => new ConcurrentQueue<string>());
        var deadline = DateTime.UtcNow.Add(timeout);

        while (DateTime.UtcNow < deadline && !ct.IsCancellationRequested)
        {
            if (queue.TryDequeue(out var runId))
            {
                return runId;
            }
            await Task.Delay(100, ct);
        }

        return null;
    }
}
