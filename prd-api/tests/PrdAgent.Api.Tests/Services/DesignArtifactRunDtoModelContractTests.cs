using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 同一个 DesignArtifactRun 被两个 Controller 各自投影成 DTO：生成走
/// DesignArtifactsController.ToDto，刷新恢复走 HostedSiteEditsController.ToRunDto。
/// 上一轮只改了前者，后者漏了——流事件只在开头出现一次，刷新之后徽章就再也回不来
/// （判据与接线纪律 形状 3：判据分裂成两份，改一处忘一处不会红）。
///
/// 这里把两份对齐成机械断言：模型可见性要求的两个字段，两个投影都必须带。
/// </summary>
public sealed class DesignArtifactRunDtoModelContractTests
{
    private static readonly (string File, string Projection)[] Projections =
    {
        ("DesignArtifactsController.cs", "生成流的 run DTO"),
        ("HostedSiteEditsController.cs", "刷新恢复读回的 run DTO"),
    };

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public void BothRunProjectionsCarryTheResolvedModel(int index)
    {
        var (file, projection) = Projections[index];
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory != null
               && !Directory.Exists(Path.Combine(directory.FullName, "prd-api", "src", "PrdAgent.Api")))
            directory = directory.Parent;
        Assert.NotNull(directory);

        var path = Path.Combine(directory!.FullName, "prd-api", "src", "PrdAgent.Api",
            "Controllers", "Api", file);
        Assert.True(File.Exists(path), $"找不到 {file}，投影可能被挪走了");
        var source = File.ReadAllText(path);

        Assert.True(source.Contains("run.ResolvedModel", StringComparison.Ordinal),
            $"{projection}（{file}）没有带上 ResolvedModel，刷新之后模型徽章会消失");
        Assert.True(source.Contains("run.ResolvedPlatform", StringComparison.Ordinal),
            $"{projection}（{file}）没有带上 ResolvedPlatform");
        Assert.True(source.Contains("run.RuntimeFailure", StringComparison.Ordinal),
            $"{projection}（{file}）没有带上 RuntimeFailure，刷新后会丢失稳定质量问题码");
        Assert.True(source.Contains("run.LatestPreviewHtml", StringComparison.Ordinal),
            $"{projection}（{file}）没有带上 LatestPreviewHtml，终态失败重开后会丢最后预览");
        Assert.True(source.Contains("run.LatestPreviewRevision", StringComparison.Ordinal),
            $"{projection}（{file}）没有带上 LatestPreviewRevision");
        Assert.True(source.Contains("run.Status == RunStatuses.Error", StringComparison.Ordinal),
            $"{projection}（{file}）在运行中轮询也返回整页预览，会造成持续大响应");
    }

    [Fact]
    public void FailedRunDiscovery_RequiresStructuredFailureAndPersistedPreview()
    {
        var run = new DesignArtifactRun
        {
            Status = RunStatuses.Error,
            RuntimeFailure = new DesignArtifactRuntimeFailure
            {
                Code = "design_browser_quality_rejected",
                IssueCodes = ["key_text_contrast_low"],
            },
            LatestPreviewHtml = "<!doctype html><main>最后预览</main>",
            LatestPreviewRevision = 3,
        };

        Assert.True(DesignArtifactsController.IsViewableFailedRun(run));

        run.LatestPreviewHtml = null;
        Assert.False(DesignArtifactsController.IsViewableFailedRun(run));
        run.LatestPreviewHtml = "<!doctype html><main>最后预览</main>";
        run.RuntimeFailure = new DesignArtifactRuntimeFailure();
        Assert.False(DesignArtifactsController.IsViewableFailedRun(run));
        run.RuntimeFailure = new DesignArtifactRuntimeFailure { Code = "design_browser_quality_rejected" };
        run.Status = RunStatuses.Running;
        Assert.False(DesignArtifactsController.IsViewableFailedRun(run));
    }
}
