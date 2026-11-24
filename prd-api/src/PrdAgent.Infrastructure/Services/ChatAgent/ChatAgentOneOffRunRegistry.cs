using System.Collections.Concurrent;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.ChatAgent;

/// <summary>
/// 进程内的一次性转派身份台账。
///
/// 两条保命线：
/// 1. 转派结束一定 Release（调用方写在 finally 里），身份不悬挂。
/// 2. 即便 Release 没跑到（进程被硬杀前的残留、异常路径），读取时按 TTL 过期，
///    不会留下一个可以被后来的 runId 蹭到的旧身份。
/// </summary>
public sealed class ChatAgentOneOffRunRegistry : IChatAgentOneOffRunRegistry
{
    /// <summary>身份最长存活时间。取值与 ChatAgentOptions.TimeoutSeconds 同量级，留一倍余量。</summary>
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(15);

    private readonly ConcurrentDictionary<string, (string UserId, DateTime ExpiresAt)> _runs = new(StringComparer.Ordinal);

    public void Register(string runId, string userId)
    {
        if (string.IsNullOrWhiteSpace(runId) || string.IsNullOrWhiteSpace(userId)) return;
        Sweep();
        _runs[runId] = (userId, DateTime.UtcNow + Ttl);
    }

    public void Release(string runId)
    {
        if (string.IsNullOrWhiteSpace(runId)) return;
        _runs.TryRemove(runId, out _);
    }

    public string? TryResolveUserId(string? runId)
    {
        if (string.IsNullOrWhiteSpace(runId)) return null;
        if (!_runs.TryGetValue(runId!, out var entry)) return null;
        if (entry.ExpiresAt <= DateTime.UtcNow)
        {
            _runs.TryRemove(runId!, out _);
            return null;
        }
        return entry.UserId;
    }

    /// <summary>登记时顺手清过期项。转派是低频操作，不值得再养一个定时器。</summary>
    private void Sweep()
    {
        if (_runs.IsEmpty) return;
        var now = DateTime.UtcNow;
        foreach (var pair in _runs)
        {
            if (pair.Value.ExpiresAt <= now) _runs.TryRemove(pair.Key, out _);
        }
    }
}
