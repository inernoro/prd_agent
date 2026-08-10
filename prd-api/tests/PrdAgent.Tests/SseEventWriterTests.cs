using System.Text;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// SSE 写入器的守卫。
///
/// 存在的直接原因是一次真实事故（2026-08-10，PR #1351 第六轮修复）：为了防止心跳与网关
/// chunk 交错撕帧加了 SemaphoreSlim，却漏写 Release —— 第二个事件起永久阻塞，
/// **整个提问功能全挂**，而 CI 依然全绿，因为当时没有任何一条用例真的驱动过 SSE 写入。
///
/// 所以这里的第一条用例就是「连写两条不许卡住」。它必须能在把 Release 删掉时超时变红。
/// </summary>
public class SseEventWriterTests
{
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    private static SseEventWriter Writing(StringBuilder sink) =>
        new(frame => { sink.Append(frame); return Task.CompletedTask; }, () => Task.CompletedTask);

    /// <summary>
    /// 核心用例：写完一条之后锁必须放开。删掉 Release 这条会超时。
    /// </summary>
    [Fact]
    public async Task 连写多条不会卡住()
    {
        var sink = new StringBuilder();
        var writer = Writing(sink);

        var run = Task.Run(async () =>
        {
            await writer.WriteAsync("session", new { sessionId = "s1" });
            await writer.WriteAsync("phase", new { phase = "preparing" });
            await writer.WriteAsync("typing", new { text = "你好" });
            await writer.WriteAsync("done", new { elapsedMs = 1 });
        });

        var finished = await Task.WhenAny(run, Task.Delay(Timeout));
        Assert.True(finished == run, "连续写入被阻塞了——多半是信号量没有释放");
        await run;

        Assert.Contains("event: session", sink.ToString());
        Assert.Contains("event: done", sink.ToString());
    }

    [Fact]
    public async Task 事件帧格式正确_两个换行收尾()
    {
        var sink = new StringBuilder();
        await Writing(sink).WriteAsync("phase", new { phase = "answering" });

        Assert.Equal("event: phase\ndata: {\"phase\":\"answering\"}\n\n", sink.ToString());
    }

    [Fact]
    public async Task 字段名走驼峰()
    {
        var sink = new StringBuilder();
        await Writing(sink).WriteAsync("model", new { ActualModel = "gpt", PlatformName = "openai" });

        Assert.Contains("\"actualModel\"", sink.ToString());
        Assert.Contains("\"platformName\"", sink.ToString());
    }

    // ── 断线容忍 ──────────────────────────────────────────────

    public static TheoryData<Exception> DisconnectExceptions => new()
    {
        new ObjectDisposedException("resp"),
        new OperationCanceledException(),
        new IOException("connection reset by peer"),
        new InvalidOperationException("response already completed"),
    };

    /// <summary>
    /// 核心用例：连接层失败不许抛给调用方。
    /// 抛出去就会打断生成循环，「客户端断开不取消服务端任务」这条承诺当场作废，
    /// 落库的是半截答案——而 IOException 恰恰是最常见的断开形态。
    /// </summary>
    [Theory]
    [MemberData(nameof(DisconnectExceptions))]
    public async Task 断线类异常被吞掉且标记对端已走(Exception disconnect)
    {
        var writer = new SseEventWriter(_ => throw disconnect, () => Task.CompletedTask);

        await writer.WriteAsync("typing", new { text = "x" });

        Assert.True(writer.ClientGone);
    }

    [Fact]
    public async Task 标记之后不再尝试写()
    {
        var attempts = 0;
        var writer = new SseEventWriter(
            _ => { attempts++; throw new IOException("gone"); },
            () => Task.CompletedTask);

        await writer.WriteAsync("typing", new { text = "1" });
        await writer.WriteAsync("typing", new { text = "2" });
        await writer.WriteAsync("typing", new { text = "3" });

        Assert.Equal(1, attempts);
    }

    /// <summary>
    /// 断线之后锁也必须放开——否则「对端走了」会退化成「整个请求卡死」，
    /// 比原来的问题更糟。
    /// </summary>
    [Fact]
    public async Task 断线之后仍能继续调用而不卡住()
    {
        var writer = new SseEventWriter(_ => throw new IOException("gone"), () => Task.CompletedTask);

        var run = Task.Run(async () =>
        {
            await writer.WriteAsync("typing", new { text = "1" });
            await writer.WriteAsync("typing", new { text = "2" });
        });

        var finished = await Task.WhenAny(run, Task.Delay(Timeout));
        Assert.True(finished == run, "断线路径把锁漏掉了");
        await run;
    }

    /// <summary>非连接类异常属于真 bug，必须照常抛出，不许被"断线"掩盖。</summary>
    [Fact]
    public async Task 非断线异常照常抛出()
    {
        var writer = new SseEventWriter(
            _ => throw new FormatException("这不是断线"),
            () => Task.CompletedTask);

        await Assert.ThrowsAsync<FormatException>(
            () => writer.WriteAsync("typing", new { text = "x" }));
    }

    [Fact]
    public async Task flush 失败同样按断线处理()
    {
        var writer = new SseEventWriter(
            _ => Task.CompletedTask,
            () => throw new IOException("flush failed"));

        await writer.WriteAsync("typing", new { text = "x" });

        Assert.True(writer.ClientGone);
    }

    /// <summary>
    /// 并发写不许交错：心跳循环与网关 chunk 是两个独立写者，
    /// 帧被撕成两半前端就解析不出来了。
    /// </summary>
    [Fact]
    public async Task 并发写入不交错()
    {
        var sink = new StringBuilder();
        var writer = new SseEventWriter(
            async frame =>
            {
                // 在帧中间让出线程，制造交错的机会
                sink.Append(frame[..10]);
                await Task.Yield();
                sink.Append(frame[10..]);
            },
            () => Task.CompletedTask);

        await Task.WhenAll(
            Enumerable.Range(0, 20).Select(i => writer.WriteAsync("typing", new { text = i })));

        var text = sink.ToString();
        var frames = text.Split("\n\n", StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(20, frames.Length);
        Assert.All(frames, f => Assert.StartsWith("event: typing", f));
    }
}
