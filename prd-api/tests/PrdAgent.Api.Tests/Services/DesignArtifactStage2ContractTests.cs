using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 阶段 2 的恢复合同不允许退回到浏览器本地态：Run 必须保存可观测时间，
/// Controller 必须提供用户隔离的活动任务发现与幂等重开入口。
/// </summary>
public sealed class DesignArtifactStage2ContractTests
{
    private static string Source(params string[] relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null)
        {
            var candidate = Path.Combine(new[] { directory.FullName }.Concat(relative).ToArray());
            if (File.Exists(candidate)) return File.ReadAllText(candidate);
            directory = directory.Parent;
        }
        throw new FileNotFoundException(string.Join('/', relative));
    }

    [Fact]
    public void Run持久化首反馈首预览与最近进度时间()
    {
        var model = Source("prd-api", "src", "PrdAgent.Core", "Models", "DesignArtifactRun.cs");
        Assert.Contains("FirstVisibleFeedbackAt", model);
        Assert.Contains("FirstPreviewAt", model);
        Assert.Contains("LastProgressAt", model);
        Assert.Contains("PhaseCode", model);
    }

    [Fact]
    public void 活动任务与冻结输入重开都由服务端权威提供()
    {
        var controller = Source("prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "DesignArtifactsController.cs");
        Assert.Contains("[HttpGet(\"runs/active\")]", controller);
        Assert.Contains("this.GetRequiredUserId()", controller);
        Assert.Contains("[HttpPost(\"runs/{runId}/restart\")]", controller);
        Assert.Contains("RestartedFromRunId", controller);
        Assert.Contains("RestartIdempotencyKeyHash", controller);
    }

    [Fact]
    public void 实时预览保留事件触发与轮询兜底()
    {
        var executor = Source("design-runtime", "opendesign", "src", "executor.ts");
        Assert.Contains("fs.watch", executor);
        Assert.Contains("debounce", executor, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("poll", executor);
        Assert.Contains("close", executor);
    }
}
