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

    /// <summary>
    /// 本进程曾经握着、但令牌已经过期的 Run。
    ///
    /// 为什么要单独记一份：Worker 只认领 <see cref="HeldRunIds"/> 里的 Run，而过期条目
    /// 在那里会被顺手清掉——于是「Start 成功了、下一次轮询前令牌刚好过期」这条 Run
    /// 既进不了认领列表、也就永远走不到 ExecuteRunAsync 里那条「没令牌就判失败」的路，
    /// 在库里永远停在 running。
    ///
    /// 只记本进程握过的，不去扫库里所有 running：那些可能属于别的部署，替它们判死
    /// 正是 cross-project-isolation 台账里反复出事的那种越界。
    /// </summary>
    private readonly ConcurrentDictionary<string, byte> _expiredRunIds = new();

    /// <summary>暂存跳转前生成的 PKCE verifier，等回调时取用。</summary>
    public void StashVerifier(string state, string verifier, DateTime expiresAt)
        => _verifiers[state] = new Entry(verifier, expiresAt);

    /// <summary>
    /// 读 verifier，但**不删**。
    ///
    /// 删的时机不能是「开始换票」，只能是「换票有了确定结果」。请求压根没到源站
    /// （DNS / TLS / 连不上）时授权码一条都没被消费，此时把 verifier 删掉，等于把这次
    /// 本来还能重试的授权判了死刑——前端那个「重试」按钮会永远拿到「这次授权已失效」。
    /// 一次性由 <see cref="ForgetVerifier"/> 在确定结果之后落实。
    /// </summary>
    public string? PeekVerifier(string state)
    {
        if (!_verifiers.TryGetValue(state, out var entry)) return null;
        if (entry.ExpiresAt <= DateTime.UtcNow)
        {
            _verifiers.TryRemove(state, out _);
            return null;
        }
        return entry.Value;
    }

    /// <summary>
    /// 作废 verifier。只在**源站已经应答**之后调用——那一刻授权码无论成败都已在源站作废，
    /// 手里这个 verifier 再也换不出任何东西，留着只是一份没用的状态。
    /// </summary>
    public void ForgetVerifier(string state) => _verifiers.TryRemove(state, out _);

    public void PutExportToken(string runId, string token, DateTime expiresAt)
        => _exportTokens[runId] = new Entry(token, expiresAt);

    public string? GetExportToken(string runId)
    {
        if (!_exportTokens.TryGetValue(runId, out var entry)) return null;
        if (entry.ExpiresAt <= DateTime.UtcNow)
        {
            _exportTokens.TryRemove(runId, out _);
            _expiredRunIds[runId] = 0;
            return null;
        }
        return entry.Value;
    }

    /// <summary>Run 进终态就把令牌丢掉，不留到过期。</summary>
    public void Forget(string runId)
    {
        _exportTokens.TryRemove(runId, out _);
        _expiredRunIds.TryRemove(runId, out _);
    }

    /// <summary>
    /// 取走「本进程握过、令牌已过期」的 Run id，取过即清。Worker 拿它把这些 Run
    /// 落成失败终态——否则它们会永远停在 running。
    /// </summary>
    public IReadOnlyCollection<string> DrainExpiredRunIds()
    {
        var ids = _expiredRunIds.Keys.ToList();
        foreach (var id in ids) _expiredRunIds.TryRemove(id, out _);
        return ids;
    }

    /// <summary>当前进程持有令牌的 Run —— Worker 只认领这些。</summary>
    public IReadOnlyCollection<string> HeldRunIds
    {
        get
        {
            var now = DateTime.UtcNow;
            foreach (var (key, entry) in _exportTokens)
            {
                // 清掉的同时记一笔，让 Worker 有机会把对应的 Run 落终态。
                if (entry.ExpiresAt <= now && _exportTokens.TryRemove(key, out _)) _expiredRunIds[key] = 0;
            }
            foreach (var (key, entry) in _verifiers)
            {
                if (entry.ExpiresAt <= now) _verifiers.TryRemove(key, out _);
            }
            return _exportTokens.Keys.ToList();
        }
    }
}
