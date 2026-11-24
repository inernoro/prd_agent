using System.Collections.Concurrent;

namespace PrdAgent.Core.Diagnostics;

/// <summary>
/// 进程级的「最近有没有崩过、有没有人用过」滚动计数（2026-09-09 起，规则 degradation-must-alarm）。
///
/// 为什么需要它：那次 Quickstart 报 500 的事故里，容器日志明明白白写着
/// 「An unhandled exception was thrown by the application」，但没有任何闸门读过它——
/// 前端优雅降级把故障翻译成了一次表面成功，全部验收判绿。
/// 把「最近有没有崩过」变成一个**能被机器定量读取**的数，才有闸可设。
///
/// 这是这套监控里最值钱的一条判据：它不需要为每个功能单独写探针，
/// 「页面看着好、后台在炸」的同类故障全部一次落网。
///
/// 放在 Core 而不是各进程各写一份：llmgw serving 与 prd-api 是两个独立部署单元
/// （物理隔离是刻意的），但「怎么数」这件事只该有一份判据——两份几乎一样的滚动
/// 计数器迟早会在窗口语义上漂开（predicate-and-wiring-discipline 形状 3）。
/// 两边都已引用 PrdAgent.Core，共用它不破坏隔离：共享的是代码，不是状态。
///
/// 窗口必须 ≥ 探测间隔，否则异常发生在窗口之外，探针读到 0 会误判成健康。
/// </summary>
public class ProcessFaultTracker
{
    /// <summary>默认窗口 6 小时，对齐常设轻探针的探测间隔。改动其一必须同时改另一个。</summary>
    public const int DefaultWindowMinutes = 360;

    private readonly ConcurrentQueue<DateTime> _occurrences = new();
    private readonly RollingMinuteCounter _requests;
    private readonly TimeSpan _window;
    private readonly Func<DateTime> _now;
    private long _totalSinceStart;

    public ProcessFaultTracker(int windowMinutes = DefaultWindowMinutes, Func<DateTime>? now = null)
    {
        var minutes = windowMinutes <= 0 ? DefaultWindowMinutes : windowMinutes;
        _window = TimeSpan.FromMinutes(minutes);
        _now = now ?? (() => DateTime.UtcNow);
        _requests = new RollingMinuteCounter(minutes, () => _now());
    }

    public int WindowMinutes => (int)_window.TotalMinutes;

    /// <summary>进程启动以来的累计数。窗口内计数回落时，它仍能说明「这个实例崩过」。</summary>
    public long TotalSinceStart => Interlocked.Read(ref _totalSinceStart);

    public void Record()
    {
        _occurrences.Enqueue(_now());
        Interlocked.Increment(ref _totalSinceStart);
        Trim();
    }

    /// <summary>
    /// 记一次真实业务请求（探针自己那几条路径不算，见各进程的中间件）。
    ///
    /// 这是「零异常」这条判据的**分母**：窗口里一次调用都没有时，
    /// 「零异常」和「全部成功」长得一模一样，判成健康就是假绿
    /// （degradation-must-alarm：被动观测样本为 0 时绿灯不作数）。
    /// </summary>
    public void RecordRequest() => _requests.Record();

    /// <summary>窗口内的未处理异常数。这是探针断言 == 0 的那个观测值。</summary>
    public int CountWithinWindow()
    {
        Trim();
        return _occurrences.Count;
    }

    /// <summary>窗口内的真实业务请求数。0 = 这段时间根本没人用过。</summary>
    public long RequestsWithinWindow() => _requests.CountWithinWindow();

    /// <summary>
    /// 丢弃窗口外的记录。
    ///
    /// 队列按入队时间天然有序，所以从头看一个丢一个即可；
    /// 不做全量扫描，避免一次异常风暴把这个方法本身变成负担。
    /// </summary>
    private void Trim()
    {
        var cutoff = _now() - _window;
        while (_occurrences.TryPeek(out var oldest) && oldest < cutoff)
        {
            if (!_occurrences.TryDequeue(out _)) break;
        }
    }
}

/// <summary>
/// 按分钟分桶的滚动计数（环形数组，内存恒定）。
///
/// 异常可以一条一条存（它们本该很少）；请求不行——6 小时的流量逐条存 DateTime
/// 会让这个观测组件自己变成负担。每分钟一个格子、总共 windowMinutes 个格子，
/// 内存与流量无关。
///
/// 代价是边界精度到分钟：最老那一格可能有不到一分钟落在窗口之外。
/// 对「这 6 小时有没有人用过」这个问题，这点误差无关紧要。
/// </summary>
public sealed class RollingMinuteCounter
{
    private readonly long[] _counts;
    private readonly long[] _minutes;
    private readonly int _size;
    private readonly Func<DateTime> _now;
    private readonly object _gate = new();

    public RollingMinuteCounter(int windowMinutes, Func<DateTime> now)
    {
        _size = windowMinutes <= 0 ? 1 : windowMinutes;
        _counts = new long[_size];
        _minutes = new long[_size];
        for (var i = 0; i < _size; i++) _minutes[i] = long.MinValue;
        _now = now;
    }

    private static long MinuteOf(DateTime t) => t.Ticks / TimeSpan.TicksPerMinute;

    public void Record()
    {
        var minute = MinuteOf(_now());
        var slot = (int)(((minute % _size) + _size) % _size);
        lock (_gate)
        {
            // 格子被上一圈的分钟占着 → 那是窗口外的旧数据，直接覆盖而不是累加。
            if (_minutes[slot] != minute)
            {
                _minutes[slot] = minute;
                _counts[slot] = 0;
            }
            _counts[slot]++;
        }
    }

    public long CountWithinWindow()
    {
        var oldest = MinuteOf(_now()) - _size + 1;
        long total = 0;
        lock (_gate)
        {
            for (var i = 0; i < _size; i++)
            {
                if (_minutes[i] >= oldest) total += _counts[i];
            }
        }
        return total;
    }
}
