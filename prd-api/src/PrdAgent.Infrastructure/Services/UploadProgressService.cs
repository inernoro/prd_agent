using System.Text.Json;
using Microsoft.Extensions.Logging;
using PrdAgent.Core.Interfaces;
using StackExchange.Redis;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 上传解包进度的 Redis 实现。
///
/// 三条纪律，缺一条都会让「加个进度」变成「上传更慢了 / 上传挂了」：
///   1. 全部异常吞掉——进度是辅助信息，Redis 抖一下不该让上传本身失败。
///   2. 写入节流——解包循环一秒能跑几百个文件，每个都写一次 Redis 会把上传拖慢。
///   3. TTL 兜底——前端崩了 / 关标签页了，没人来 Complete，键不能永远留着。
/// </summary>
public class UploadProgressService : IUploadProgressService
{
    /// <summary>两次写入之间至少隔这么久。前端 1s 轮询一次，250ms 的粒度绰绰有余。</summary>
    private static readonly TimeSpan WriteThrottle = TimeSpan.FromMilliseconds(250);

    /// <summary>没人来 Complete 时键自己过期。取 30 分钟：比最慢的大包上传还长一截。</summary>
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(30);

    private readonly ConnectionMultiplexer _redis;
    private readonly ILogger<UploadProgressService> _logger;

    /// <summary>
    /// 每个 uploadId 上一次真正写 Redis 的时刻，用于节流。
    ///
    /// 用普通 Dictionary + lock 而不是 ConcurrentDictionary：这里除了读写还要**清理**
    /// （否则长期运行的进程会把每个上传过的 uploadId 都留在内存里，是一条慢性泄漏），
    /// 而「读-改-清」需要在同一把锁下才不打架。
    /// </summary>
    private readonly Dictionary<string, DateTime> _lastWrite = new();
    private readonly object _lastWriteLock = new();

    public UploadProgressService(ConnectionMultiplexer redis, ILogger<UploadProgressService> logger)
    {
        _redis = redis;
        _logger = logger;
    }

    private static string Key(string uploadId) => $"webpage:upload:{uploadId}";

    public async Task ReportAsync(string? uploadId, UploadProgressSnapshot snapshot, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(uploadId)) return;

        // 收尾那一帧必须写下去，不能被节流吃掉——它是前端唯一的停止信号
        if (!snapshot.Finished && !ShouldWrite(uploadId)) return;

        try
        {
            var db = _redis.GetDatabase();
            await db.StringSetAsync(Key(uploadId), JsonSerializer.Serialize(snapshot), Ttl);
        }
        catch (Exception ex)
        {
            // 只在 debug 级别记：解包循环里调用极频繁，Redis 掉线时用 warning 会瞬间刷爆日志
            _logger.LogDebug(ex, "上传进度：写入失败 uploadId={UploadId}", uploadId);
        }
    }

    public async Task<UploadProgressSnapshot?> GetAsync(string uploadId, CancellationToken ct = default)
    {
        try
        {
            var db = _redis.GetDatabase();
            var raw = await db.StringGetAsync(Key(uploadId));
            if (raw.IsNullOrEmpty) return null;
            return JsonSerializer.Deserialize<UploadProgressSnapshot>(raw!);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "上传进度：读取失败 uploadId={UploadId}", uploadId);
            return null;
        }
    }

    public async Task CompleteAsync(string? uploadId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(uploadId)) return;

        lock (_lastWriteLock) _lastWrite.Remove(uploadId);

        try
        {
            var db = _redis.GetDatabase();
            var raw = await db.StringGetAsync(Key(uploadId));
            // 保留最后一帧的计数，只把 Finished 翻成 true：
            // 直接删键会让还没轮询到的前端读到 null，分不清「结束了」和「还没开始」
            var snap = raw.IsNullOrEmpty
                ? new UploadProgressSnapshot()
                : (JsonSerializer.Deserialize<UploadProgressSnapshot>(raw!) ?? new UploadProgressSnapshot());
            snap.Finished = true;
            // 结束后短 TTL：给前端最后一次轮询留出取走的窗口，不长留
            await db.StringSetAsync(Key(uploadId), JsonSerializer.Serialize(snap), TimeSpan.FromMinutes(1));
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "上传进度：收尾失败 uploadId={UploadId}", uploadId);
        }
    }

    /// <summary>节流判定 + 顺手清理过期条目，防止 _lastWrite 无限增长。</summary>
    private bool ShouldWrite(string uploadId)
    {
        var now = DateTime.UtcNow;
        lock (_lastWriteLock)
        {
            if (_lastWrite.TryGetValue(uploadId, out var last) && now - last < WriteThrottle)
                return false;

            _lastWrite[uploadId] = now;

            // 字典变大时顺手扫一遍，把早就结束（超过 TTL）的 id 清掉。
            // 阈值给得高一点，正常并发量下这条分支几乎不会走到。
            if (_lastWrite.Count > 256)
            {
                var stale = _lastWrite.Where(kv => now - kv.Value > Ttl).Select(kv => kv.Key).ToList();
                foreach (var k in stale) _lastWrite.Remove(k);
            }

            return true;
        }
    }
}
