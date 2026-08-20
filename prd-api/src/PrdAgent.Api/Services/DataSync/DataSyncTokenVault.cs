using System.Collections.Concurrent;

namespace PrdAgent.Api.Services.DataSync;

/// <summary>
/// 导出令牌与 PKCE verifier 的进程内暂存。
///
/// 为什么**不落库**：这两样东西都是「凭这个就能把源站的数据拉走」的凭据。落库就等于
/// 在共享的 Mongo 里长期存一份可重放的访问权——本仓库已经为「共享库里的东西人人可见」
/// 吃过亏（见 cross-project-isolation 的事故台账）。放内存的代价是进程重启后这次同步
/// 作废、需要重新授权；而「重新授权」恰恰就是这个功能的设计意图，不是缺陷。
///
/// 顺带的好处：只有持有令牌的那个进程能执行这条 Run，于是 Worker 的认领条件天然带
/// 部署作用域，不会出现「另一台部署的旧构建抢走这条 Run」那类事故。
/// </summary>
public sealed class DataSyncTokenVault
{
    private sealed record Entry(string Value, DateTime ExpiresAt);

    private readonly ConcurrentDictionary<string, Entry> _exportTokens = new();
    private readonly ConcurrentDictionary<string, Entry> _verifiers = new();

    /// <summary>暂存跳转前生成的 PKCE verifier，等回调时取用。</summary>
    public void StashVerifier(string state, string verifier, DateTime expiresAt)
        => _verifiers[state] = new Entry(verifier, expiresAt);

    /// <summary>取出并删除 verifier：一次授权只该用一次，取过就不该再取到。</summary>
    public string? TakeVerifier(string state)
    {
        if (!_verifiers.TryRemove(state, out var entry)) return null;
        return entry.ExpiresAt > DateTime.UtcNow ? entry.Value : null;
    }

    public void PutExportToken(string runId, string token, DateTime expiresAt)
        => _exportTokens[runId] = new Entry(token, expiresAt);

    public string? GetExportToken(string runId)
    {
        if (!_exportTokens.TryGetValue(runId, out var entry)) return null;
        if (entry.ExpiresAt <= DateTime.UtcNow)
        {
            _exportTokens.TryRemove(runId, out _);
            return null;
        }
        return entry.Value;
    }

    /// <summary>Run 进终态就把令牌丢掉，不留到过期。</summary>
    public void Forget(string runId) => _exportTokens.TryRemove(runId, out _);

    /// <summary>当前进程持有令牌的 Run —— Worker 只认领这些。</summary>
    public IReadOnlyCollection<string> HeldRunIds
    {
        get
        {
            var now = DateTime.UtcNow;
            foreach (var (key, entry) in _exportTokens)
            {
                if (entry.ExpiresAt <= now) _exportTokens.TryRemove(key, out _);
            }
            foreach (var (key, entry) in _verifiers)
            {
                if (entry.ExpiresAt <= now) _verifiers.TryRemove(key, out _);
            }
            return _exportTokens.Keys.ToList();
        }
    }
}
