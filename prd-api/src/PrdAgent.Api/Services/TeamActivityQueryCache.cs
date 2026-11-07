using System.Collections.Concurrent;

namespace PrdAgent.Api.Services;

/// <summary>Bounded short-lived VOC results; concurrent readers share one computation, failures are retryable.</summary>
public sealed class TeamActivityQueryCache<T>(TimeSpan lifetime, TimeProvider? timeProvider = null)
{
    private sealed record Result(T Value, DateTimeOffset CompletedAt);
    private readonly ConcurrentDictionary<string, Lazy<Task<Result>>> _entries = new();
    private readonly TimeProvider _clock = timeProvider ?? TimeProvider.System;

    public async Task<T> GetAsync(string key, Func<Task<T>> compute)
    {
        foreach (var entry in _entries)
        {
            if (entry.Value.IsValueCreated && entry.Value.Value.IsCompletedSuccessfully
                && _clock.GetUtcNow() - entry.Value.Value.Result.CompletedAt >= lifetime)
                Remove(entry.Key, entry.Value);
        }

        // Excess distinct custom windows are served without retention; active entries are never evicted.
        if (_entries.Count >= 128 && !_entries.ContainsKey(key)) return await compute();
        var pending = _entries.GetOrAdd(key, _ => new Lazy<Task<Result>>(async () =>
            new Result(await compute(), _clock.GetUtcNow())));
        try { return (await pending.Value).Value; }
        catch { Remove(key, pending); throw; }
    }

    private void Remove(string key, Lazy<Task<Result>> value) =>
        ((ICollection<KeyValuePair<string, Lazy<Task<Result>>>>)_entries).Remove(new(key, value));
}
