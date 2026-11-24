using System.Text.Json;

namespace PrdAgent.Core.Models;

/// <summary>
/// SSE 事件写入器：串行化 + 断线容忍。
///
/// 抽成独立类而不是留在 Controller 里，是因为它在 Controller 里**测不到**——
/// 那个控制器要 7 个依赖（含具体类型的 MongoDbContext），单测根本构造不出来。
/// 结果就是 2026-08-10 那次事故：为了防止心跳与网关 chunk 交错撕帧加了信号量，
/// 却漏写 Release，第二个事件起永久阻塞——**整个提问功能全挂**，而 CI 全绿，
/// 因为没有任何一条用例真的驱动过 SSE 写入。
///
/// 教训不是"下次仔细点"，是"把它放到测得到的地方"。写入目标以委托注入，
/// 单测传内存缓冲即可完整验证串行、释放、断线三件事。
/// </summary>
public sealed class SseEventWriter
{
    private readonly Func<string, Task> _write;
    private readonly Func<Task> _flush;
    private readonly SemaphoreSlim _lock = new(1, 1);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public SseEventWriter(Func<string, Task> write, Func<Task> flush)
    {
        _write = write;
        _flush = flush;
    }

    /// <summary>
    /// 对端已经走了。置位后不再尝试写，但调用方**必须继续**把任务做完
    /// （server-authority：客户端断开不取消服务端任务）。
    /// </summary>
    public bool ClientGone { get; private set; }

    /// <summary>
    /// 写一个事件。**连接层失败一律吞掉，绝不抛给调用方。**
    ///
    /// 写失败只说明「没人在听了」，而这条请求的价值（完整答案、落库、计费）与有没有人听无关。
    /// 只吞 ObjectDisposed / OperationCanceled 是不够的：Kestrel 在 socket 断开时同样会抛
    /// IOException / InvalidOperationException，那两种冒到外层就会打断生成循环，
    /// 于是「断开不取消」这条承诺在最常见的断开形态上根本不成立。
    /// </summary>
    public async Task WriteAsync(string eventType, object data)
    {
        if (ClientGone) return;

        // 序列化放在锁外：它与连接无关，失败属于真 bug，应当照常抛出。
        var json = JsonSerializer.Serialize(data, JsonOptions);
        var frame = $"event: {eventType}\ndata: {json}\n\n";

        await _lock.WaitAsync();
        try
        {
            await _write(frame);
            await _flush();
        }
        catch (Exception ex) when (IsClientDisconnect(ex))
        {
            ClientGone = true;
        }
        finally
        {
            // 漏掉这一行 = 第二个事件起永久阻塞。事故原文见类注释。
            _lock.Release();
        }
    }

    /// <summary>
    /// 这个异常是不是「对端没了」。Kestrel 对同一件事有好几种抛法，
    /// 漏掉任何一种，断开就会演变成「服务端提前放弃、只落半截答案」。
    /// </summary>
    public static bool IsClientDisconnect(Exception ex) => ex switch
    {
        ObjectDisposedException => true,
        OperationCanceledException => true,
        IOException => true,
        // 响应已完成 / 已中止之后再写会抛这个
        InvalidOperationException => true,
        _ => false,
    };
}
