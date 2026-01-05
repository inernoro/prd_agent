using System.Collections.Concurrent;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

public sealed class InMemoryRunQueue : IRunQueue
{
    private readonly ConcurrentDictionary<string, ConcurrentQueue<string>> _queues = new();

    private static string Key(string kind) => (kind ?? string.Empty).Trim();

    public Task EnqueueAsync(string kind, string runId, CancellationToken ct = default)
    {
        var id = (runId ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(id)) return Task.CompletedTask;
        _queues.GetOrAdd(Key(kind), _ => new ConcurrentQueue<string>()).Enqueue(id);
        return Task.CompletedTask;
    }

    public async Task<string?> DequeueAsync(string kind, TimeSpan timeout, CancellationToken ct = default)
    {
        var q = _queues.GetOrAdd(Key(kind), _ => new ConcurrentQueue<string>());
        if (q.TryDequeue(out var id)) return id;
        if (timeout <= TimeSpan.Zero) return null;
        var end = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < end)
        {
            ct.ThrowIfCancellationRequested();
            if (q.TryDequeue(out id)) return id;
            await Task.Delay(50, ct);
        }
        return null;
    }
}


