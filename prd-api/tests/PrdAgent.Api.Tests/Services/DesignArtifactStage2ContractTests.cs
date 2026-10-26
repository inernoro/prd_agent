using System.Security.Cryptography;
using System.Text;
using PrdAgent.Api.Services;
using PrdAgent.Core.Models;
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

    [Fact]
    public void OpenDesign最终受信产物留给服务端持久化但不进入用户事件流()
    {
        var html = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html lang=\"zh-CN\"><head><title>阶段二产物</title></head><body><main>已完成页面</main></body></html>");
        var bytes = Encoding.UTF8.GetBytes(html);
        var files = new[]
        {
            new DesignWorkspaceFile(
                "index.html",
                Convert.ToBase64String(bytes),
                Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(),
                bytes.LongLength,
                "text/html; charset=utf-8"),
        };
        var output = new StringBuilder();
        var run = new DesignArtifactRun { Runtime = DesignArtifactRuntimes.OpenDesign };
        var chunk = new DesignArtifactExecutorChunk("delta", html, files);

        var suppressedFromPublicStream = HostedSiteEditRunWorker.ConsumePrivateOpenDesignChunk(run, chunk, output);
        var persistedHtml = HostedSiteEditRunWorker.HardenExecutorOutput(output.ToString(), files);

        Assert.True(suppressedFromPublicStream);
        Assert.Equal(html, persistedHtml);
    }

    [Theory]
    [InlineData("delta")]
    [InlineData("thinking")]
    public void OpenDesign原始模型文本不进入服务端产物或用户事件流(string type)
    {
        const string privateModelText = "内部模型原始内容不得展示";
        var output = new StringBuilder();
        var run = new DesignArtifactRun { Runtime = DesignArtifactRuntimes.OpenDesign };
        var chunk = new DesignArtifactExecutorChunk(type, privateModelText);

        var suppressedFromPublicStream = HostedSiteEditRunWorker.ConsumePrivateOpenDesignChunk(run, chunk, output);

        Assert.True(suppressedFromPublicStream);
        Assert.Empty(output.ToString());
    }

    [Fact]
    public void OpenDesign空或不一致的受信结果包仍然失败()
    {
        var run = new DesignArtifactRun { Runtime = DesignArtifactRuntimes.OpenDesign };
        var emptyOutput = new StringBuilder();
        var emptyFiles = Array.Empty<DesignWorkspaceFile>();

        Assert.True(HostedSiteEditRunWorker.ConsumePrivateOpenDesignChunk(
            run,
            new DesignArtifactExecutorChunk("delta", "不应采纳", emptyFiles),
            emptyOutput));
        Assert.Empty(emptyOutput.ToString());
        Assert.Throws<InvalidOperationException>(() =>
            HostedSiteEditRunWorker.HardenExecutorOutput(emptyOutput.ToString(), emptyFiles));

        var packagedHtml = HostedSiteRevisionRules.HardenGeneratedHtml(
            "<!doctype html><html><head><title>原产物</title></head><body>原产物</body></html>");
        var packagedBytes = Encoding.UTF8.GetBytes(packagedHtml);
        var files = new[]
        {
            new DesignWorkspaceFile(
                "index.html",
                Convert.ToBase64String(packagedBytes),
                Convert.ToHexString(SHA256.HashData(packagedBytes)).ToLowerInvariant(),
                packagedBytes.LongLength,
                "text/html; charset=utf-8"),
        };
        var mismatchedOutput = new StringBuilder();
        Assert.True(HostedSiteEditRunWorker.ConsumePrivateOpenDesignChunk(
            run,
            new DesignArtifactExecutorChunk(
                "delta",
                packagedHtml.Replace("原产物", "被替换", StringComparison.Ordinal),
                files),
            mismatchedOutput));
        Assert.Throws<InvalidOperationException>(() =>
            HostedSiteEditRunWorker.HardenExecutorOutput(mismatchedOutput.ToString(), files));
    }
}
