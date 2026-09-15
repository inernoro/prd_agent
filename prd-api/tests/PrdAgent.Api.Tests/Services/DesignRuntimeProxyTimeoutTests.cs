using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 代理上游设计模型时，超时与上游中断是同一件事的两种到达方式：都必须让下游看得出失败。
/// 已发过响应头之后若不中断，Kestrel 会把下游收成一次干净的 200 EOF——OpenDesign 读到的
/// 是「完整的成功」（判据与接线纪律 形状 10：静默降级，坏路和好路产出分不开）。
///
/// 上一轮只给 IOException 那个分支加了 Abort，OperationCanceledException（总截止时间 /
/// 流式空闲上限）那一支漏了——同一条判据的两份写法（形状 3）。这条守卫盯住两支都在。
/// </summary>
public sealed class DesignRuntimeProxyTimeoutTests
{
    [Fact]
    public void BothFailureBranchesAbortOnceTheResponseHasStarted()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null
               && !Directory.Exists(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api")))
            directory = directory.Parent;
        Assert.NotNull(directory);
        var source = File.ReadAllText(Path.Combine(directory!.FullName, "prd-api", "src", "PrdAgent.Api",
            "Controllers", "Api", "DesignArtifactRuntimeController.cs"));

        var timeout = source.IndexOf("catch (OperationCanceledException)", StringComparison.Ordinal);
        Assert.True(timeout > 0, "超时分支不见了，契约可能被挪走了");
        var upstream = source.IndexOf("catch (Exception ex) when (ex is ObjectDisposedException or IOException)",
            StringComparison.Ordinal);
        Assert.True(upstream > timeout, "两个分支的相对位置变了，下面的截取会取错范围");

        var timeoutBody = source[timeout..upstream];
        // companion：确实截到了超时分支（它写 504）。
        Assert.Contains("DESIGN_RUNTIME_MODEL_TIMEOUT", timeoutBody, StringComparison.Ordinal);
        // 调用方自己走了不算失败，仍然只记一条。
        Assert.Contains("HttpContext.RequestAborted.IsCancellationRequested", timeoutBody, StringComparison.Ordinal);
        Assert.True(timeoutBody.Contains("HttpContext.Abort()", StringComparison.Ordinal),
            "超时且已发头时没有中断下游，Kestrel 会把它收成一次干净的 200，超时被抹平");

        var upstreamBody = source[upstream..];
        Assert.Contains("DESIGN_RUNTIME_MODEL_INTERRUPTED", upstreamBody, StringComparison.Ordinal);
        Assert.Contains("HttpContext.Abort()", upstreamBody, StringComparison.Ordinal);
    }
}
