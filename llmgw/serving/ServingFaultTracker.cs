using System.Collections.Concurrent;

namespace PrdAgent.LlmGatewayHost;

/// <summary>
/// 未处理异常的滚动计数（2026-09-09，规则 degradation-must-alarm）。
///
/// 为什么需要它：那次 Quickstart 报 500 的事故里，容器日志明明白白写着
/// 「An unhandled exception was thrown by the application」，但没有任何闸门读过它——
/// 前端优雅降级把故障翻译成了一次表面成功，全部验收判绿。
/// 把「最近有没有崩过」变成一个**能被机器定量读取**的数，才有闸可设。
///
/// 这是这套监控里最值钱的一条判据：它不需要为每个功能单独写探针，
/// 「页面看着好、后台在炸」的同类故障全部一次落网。
///
/// 窗口必须 ≥ 探测间隔，否则异常发生在窗口之外，探针读到 0 会误判成健康。
/// 默认 360 分钟正是对齐 cds-monitors.yml 里 6 小时的常设探测间隔——
/// 改动其一必须同时改另一个。
/// </summary>
public sealed class ServingFaultTracker
{
    public const int DefaultWindowMinutes = 360;

    private readonly ConcurrentQueue<DateTime> _occurrences = new();
    private readonly TimeSpan _window;
    private readonly Func<DateTime> _now;
    private long _totalSinceStart;

    public ServingFaultTracker(int windowMinutes = DefaultWindowMinutes, Func<DateTime>? now = null)
    {
        _window = TimeSpan.FromMinutes(windowMinutes <= 0 ? DefaultWindowMinutes : windowMinutes);
        _now = now ?? (() => DateTime.UtcNow);
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

    /// <summary>窗口内的未处理异常数。这是探针断言 == 0 的那个观测值。</summary>
    public int CountWithinWindow()
    {
        Trim();
        return _occurrences.Count;
    }

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
/// 把穿透整个管道的异常记进 <see cref="ServingFaultTracker"/>，然后**原样抛回去**。
///
/// 只记不吞：吞掉会改变现有的错误响应行为，那是另一件事，不该由一个观测组件顺手做。
/// 位置必须在管道最外层，否则被内层组件处理掉的异常不会走到这里——
/// 而那次事故的异常正是一路穿透到 Kestrel 才被记录的。
/// </summary>
public sealed class ServingFaultTrackingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ServingFaultTracker _tracker;

    public ServingFaultTrackingMiddleware(RequestDelegate next, ServingFaultTracker tracker)
    {
        _next = next;
        _tracker = tracker;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (Exception)
        {
            _tracker.Record();
            throw;
        }
    }
}
