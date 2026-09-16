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

    [Fact(DisplayName = "没见过 Done 块就不许落库，且这道判断排在写库之前")]
    public void DigestStream_MustRequireTerminalChunk()
    {
        var src = ControllerSource();

        src.ShouldContain(
            "GatewayChunkType.Done",
            customMessage: "循环没有记录终止块：API 与 serving 之间的 SSE 干净断开时，"
                + "await foreach 正常结束、没有异常也没有 Error 块，半篇稿子会被当成写完了落库");

        var truncated = src.IndexOf("STREAM_TRUNCATED", StringComparison.Ordinal);
        truncated.ShouldBeGreaterThan(-1, customMessage: "找不到「没有正常收尾」的提前返回分支");

        var persist = src.IndexOf("BookDigests.ReplaceOneAsync", StringComparison.Ordinal);
        persist.ShouldBeGreaterThan(-1, customMessage: "找不到写库调用，守卫判据已过期，请修守卫");
        truncated.ShouldBeLessThan(
            persist,
            customMessage: "这道判断排在写库之后，挡不住半篇稿子落库");
    }

    [Fact(DisplayName = "SSE 写入必须把「读的人走了」的三种异常都吞掉，包括 IOException")]
    public void SseWrite_MustSwallowDisconnectExceptions()
    {
        var src = ControllerSource();

        /*
         * 少认哪一种都一样：异常从写的那一步冒回生成循环，停掉对网关流的消费，
         * 连带跳过落库——钱花了、模型也吐完了，库里什么都没有，下一个人点进来再烧一次。
         *
         * IOException 是最容易漏的那个：规则原文只点了取消与释放两种，
         * 而客户端关标签页时 Kestrel 实际抛的就是它。
         */
        foreach (var ex in new[] { "OperationCanceledException", "ObjectDisposedException", "IOException" })
        {
            src.ShouldContain(
                $"catch ({ex})",
                customMessage: $"SSE 写入没有捕获 {ex}：读者一断开就会把整篇生成连带落库一起掐掉");
        }
    }

    [Fact(DisplayName = "连接断过之后不许再往那个 socket 写")]
    public void SseWrite_MustStopWritingAfterBroken()
    {
        var src = ControllerSource();
        src.ShouldContain(
            "if (_sseBroken) return;",
            customMessage: "断开后仍会继续尝试写：每个后续事件与每次心跳都要再撞一次已经破掉的连接");
        src.ShouldContain(
            "_sseBroken = true;",
            customMessage: "捕获到断开却没有置位，那个短路判据永远不成立");
    }

    [Fact(DisplayName = "落库前必须重新读一次本作用域那一行，否则并发首写会撞 _id 不可变")]
    public void DigestPersist_MustReReadBeforeReplace()
    {
        var src = ControllerSource();

        /*
         * 生成要几分钟，而「库里有没有这一行」那一眼是生成**之前**取的。
         * 期间另一个读者先写成了的话，Replace 的 filter 会匹配上他那一行，
         * 而手上这份带的是新造的 Guid——Mongo 以 code 66 拒绝（_id 不可变）。
         * 那不是撞唯一索引，撞键那个 catch 接不住，读者烧完一整篇只拿到 SAVE_FAILED。
         *
         * 判据要的是「那一眼在 Replace 之前」，不是「文件里有这个词」。
         */
        var reread = src.IndexOf("var latestExisting", StringComparison.Ordinal);
        var persist = src.IndexOf("BookDigests.ReplaceOneAsync", StringComparison.Ordinal);
        reread.ShouldBeGreaterThan(-1, customMessage: "落库前没有重新读一次，并发首写会撞 _id 不可变");
        persist.ShouldBeGreaterThan(-1, customMessage: "找不到写库调用，守卫判据已过期，请修守卫");
        reread.ShouldBeLessThan(persist, customMessage: "那一眼排在写库之后，挡不住并发首写");

        src.ShouldContain(
            "x.BookId == id && x.DeploymentSlug == scope",
            customMessage: "这一眼没有按部署作用域过滤：拿权威那份的 _id 去 Replace 就是预览改写权威数据");
    }

    [Fact(DisplayName = "撞 _id 不可变（code 66）要和撞唯一索引同样当成「有人抢先写了」")]
    public void DigestPersist_MustHandleImmutableIdRace()
    {
        var src = ControllerSource();

        // re-read 与 replace 之间仍有一丝窗口收不干净，必须由 catch 兜住：
        // 两个人同时点开一本没稿子的书，本来就该有一个人的产物被丢弃，但他不该看到报错。
        src.ShouldContain(
            "mwe.WriteError?.Code == 66",
            customMessage: "没有把 _id 不可变当成并发写race：那个读者会烧完一整篇再拿到 SAVE_FAILED");
    }
}
