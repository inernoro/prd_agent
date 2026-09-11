using PrdAgent.Core.Diagnostics;

namespace PrdAgent.Api.Middleware;

/// <summary>
/// MAP 后端进程的未处理异常与真实请求计数。
///
/// 计数口径在 <see cref="ProcessFaultTracker"/>（PrdAgent.Core），与 llmgw serving
/// 共用同一份——两个进程物理隔离是刻意的，但「怎么数」只该有一份判据。
/// 这里留一个子类，是为了让类型名在 DI 与日志里自解释。
/// </summary>
public sealed class ApiFaultTracker : ProcessFaultTracker
{
    public ApiFaultTracker(int windowMinutes = DefaultWindowMinutes, Func<DateTime>? now = null)
        : base(windowMinutes, now)
    {
    }
}

/// <summary>
/// 把穿透整个管道的异常记进 <see cref="ApiFaultTracker"/>，然后**原样抛回去**。
///
/// 只记不吞：吞掉会改变现有的错误响应行为，那是另一件事，不该由一个观测组件顺手做。
/// 位置必须在管道最外层——被内层组件处理掉的异常不会走到这里，
/// 而 2026-09-09 那次事故的异常正是一路穿透到 Kestrel 才被记录的。
/// </summary>
public sealed class ApiFaultTrackingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ApiFaultTracker _tracker;

    public ApiFaultTrackingMiddleware(RequestDelegate next, ApiFaultTracker tracker)
    {
        _next = next;
        _tracker = tracker;
    }

    /// <summary>
    /// 探针与静态资源不算「真实调用」。
    ///
    /// 少了这条排除，6 小时窗口里永远有那么几次探针请求，
    /// 「零真实调用」这个最要紧的信号就永远出不来——被动监控又变回一条恒绿的假判据。
    /// </summary>
    public static bool IsProbePath(PathString path)
    {
        if (!path.HasValue) return false;
        var value = path.Value!;
        return value.StartsWith("/health", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/api/health", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/api/healthz", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("/api/v", StringComparison.OrdinalIgnoreCase)
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
