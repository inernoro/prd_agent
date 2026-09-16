using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests;

/// <summary>
/// 精读稿生成的两条接线守卫。
///
/// 为什么是源码扫描而不是行为测试：这两条都在 Controller 的 SSE 方法里，要行为测试得
/// 先把整条网关链路桩起来。而它们要防的恰恰是「删掉之后什么都不会红」——
/// 那正是 `predicate-and-wiring-discipline` 形状 2 与形状 10 的定义，所以这里要的
/// 就是「那根线还在不在」。
///
/// 第一条最要紧：网关的失败是**一个块**不是一个异常（`LlmGateway` 中途断流时走
/// `yield return Fail(...)` 再 `yield break`，`await foreach` 正常结束、catch 一个都不进）。
/// 不认这个块，buffer 里那半篇就会被当成写完了落库成公共稿子，此后每个点进来的人
/// 都读到一篇断在半句话上的东西，判据还认为它是新鲜的。
/// </summary>
public class BookshelfDigestStreamGuardTests
{
    private static string ControllerSource()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(
                dir.FullName, "prd-api", "src", "PrdAgent.Api",
                "Controllers", "Api", "BookshelfController.cs");
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            dir = dir.Parent;
        }
        throw new FileNotFoundException("定位不到 BookshelfController.cs——守卫本身失效了，请修这里而不是删掉它");
    }

    [Fact(DisplayName = "精读稿的流式循环必须认 GatewayChunkType.Error，否则半篇稿子会落库成公共内容")]
    public void DigestStream_MustHandleErrorChunk()
    {
        var src = ControllerSource();
        src.ShouldContain(
            "GatewayChunkType.Error",
            customMessage: "循环里没有处理 Error 块：网关中途断流不抛异常，半篇稿子会被当成功落库");
    }

    [Fact(DisplayName = "出现过 Error 块就不许落库")]
    public void DigestStream_MustNotPersistAfterError()
    {
        var src = ControllerSource();

        // 判据是行为而不是某个变量名：Error 块之后必须存在一条「带着这个状态提前 return」的路径，
        // 且它排在 ReplaceOneAsync 之前。
        var errorBranch = src.IndexOf("STREAM_FAILED", StringComparison.Ordinal);
        errorBranch.ShouldBeGreaterThan(
            -1,
            customMessage: "找不到中断后的提前返回分支：流断了却照样往下走到写库");

        var persist = src.IndexOf("BookDigests.ReplaceOneAsync", StringComparison.Ordinal);
        persist.ShouldBeGreaterThan(-1, customMessage: "找不到写库调用，守卫的判据已经过期，请修守卫");
        errorBranch.ShouldBeLessThan(
            persist,
            customMessage: "中断分支排在写库之后，挡不住半篇稿子落库");
    }

    [Fact(DisplayName = "材料整份不可用要与「书单里没有这本书」分开报")]
    public void DigestStream_MustDistinguishContextUnavailable()
    {
        var src = ControllerSource();
        src.ShouldContain(
            "IsContextUnavailable",
            customMessage: "两种情形压成同一句 404：运维会照着「内容问题」去查一个部署问题，永远查不到");

        var unavailable = src.IndexOf("CONTEXT_UNAVAILABLE", StringComparison.Ordinal);
        var notFound = src.IndexOf("\"NOT_FOUND\"", StringComparison.Ordinal);
        unavailable.ShouldBeGreaterThan(-1, customMessage: "没有 CONTEXT_UNAVAILABLE 这个错误码");
        notFound.ShouldBeGreaterThan(-1, customMessage: "找不到 NOT_FOUND，守卫判据已过期");
        unavailable.ShouldBeLessThan(
            notFound,
            customMessage: "材料不可用的判断排在 NOT_FOUND 之后，永远走不到");
    }

    [Fact(DisplayName = "精读稿的 SSE 必须有 keepalive 心跳，且写入是串行的")]
    public void DigestStream_MustHeartbeat()
    {
        var src = ControllerSource();

        src.ShouldContain(
            "\"heartbeat\"",
            customMessage: "没有心跳：这条流开头解析模型池、推理模型吐首字之前都是长静默，"
                + "nginx/CDN 会按空闲超时掐掉连接，而后端拿 CancellationToken.None 继续烧完并落库");

        src.ShouldContain(
            "_sseWriteLock",
            customMessage: "心跳与主循环同时往一个 Response 写却没有锁：客户端会收到交织的半行");

        // 心跳只在真静默时发：正文流起来之后不该继续插事件
        src.ShouldContain(
            "_lastSseWriteTicks",
            customMessage: "心跳没有按「距上次写入多久」判断，会在正文流动时也插进去");
    }
}
