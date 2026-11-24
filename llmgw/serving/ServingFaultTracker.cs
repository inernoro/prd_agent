using PrdAgent.Core.Diagnostics;

namespace PrdAgent.LlmGatewayHost;

/// <summary>
/// serving 进程的未处理异常与真实请求计数。
///
/// 计数口径本身在 <see cref="ProcessFaultTracker"/>（PrdAgent.Core）里——
/// prd-api 那一侧用的是同一个类。两个进程物理隔离是刻意的，但「怎么数」
/// 只该有一份判据：两份几乎一样的滚动计数器迟早会在窗口语义上漂开。
///
/// 这里留一个子类而不是直接用基类，是为了让 serving 侧的类型名在日志、
/// DI 注册与守卫里仍然自解释。
/// </summary>
public sealed class ServingFaultTracker : ProcessFaultTracker
{
    public ServingFaultTracker(int windowMinutes = DefaultWindowMinutes, Func<DateTime>? now = null)
        : base(windowMinutes, now)
    {
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

    /// <summary>
    /// 探针与运维自己那几条路径不算「真实调用」。
    ///
    /// 少了这一条排除，6 小时窗口里永远有那么一两次探针请求，
    /// 「零真实调用」这个最要紧的信号就永远出不来——被动监控又变回一条恒绿的假判据。
    /// </summary>
    private static bool IsProbePath(PathString path)
    {
        if (!path.HasValue) return false;
        var value = path.Value!;
        return value.StartsWith("/gw/v1/healthz", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/gw/v1/readyz", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/gw/v1/livez", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/metrics", StringComparison.OrdinalIgnoreCase);
    }

    public async Task InvokeAsync(HttpContext context)
    {
        if (!IsProbePath(context.Request.Path)) _tracker.RecordRequest();
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
