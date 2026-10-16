using System.Text.Json;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class MdToPptPipelineRegressionTests
{
    [Fact]
    public void OutlinePlanning_KeepsItsSingleGatewayRequestContract()
    {
        var request = MdToPptController.BuildGatewayOutlineRequest(
            "system", "source", "request-1", "user-1", "run-1", 90);

        request.AppCallerCode.ShouldBe(AppCallerRegistry.MdToPptAgent.Generation.Outline);
        request.Stream.ShouldBeTrue();
        request.TimeoutSeconds.ShouldBe(90);
        request.Context.ShouldNotBeNull();
        request.Context!.RunId.ShouldBe("run-1");
        request.Context.UserId.ShouldBe("user-1");
        request.Context.SourceSystem.ShouldBe("map");
    }

    [Fact]
    public void CompletedRunDoneEvent_ExposesPersistedPackageIdentity()
    {
        var run = new MdToPptRun
        {
            Id = "run-1",
            Html = "<!doctype html><html><body><main>deck</main></body></html>",
            HtmlHash = "hash-1",
            PublishedSiteId = "site-1",
            PublishedVersionId = "revision-1",
        };

        var payload = JsonSerializer.SerializeToElement(MdToPptController.CompletedRunDoneEvent(
            run,
            degraded: 0,
            total: 20,
            siteUrl: "https://preview.example/deck"));

        payload.GetProperty("html").GetString().ShouldBe(run.Html);
        payload.GetProperty("siteId").GetString().ShouldBe("site-1");
        payload.GetProperty("revisionId").GetString().ShouldBe("revision-1");
        payload.GetProperty("siteUrl").GetString().ShouldBe("https://preview.example/deck");
        payload.GetProperty("degraded").GetInt32().ShouldBe(0);
        payload.GetProperty("total").GetInt32().ShouldBe(20);
    }

    [Theory]
    [InlineData("public async Task Convert(", "[HttpPost(\"patch\")]")]
    [InlineData("public async Task Patch(", "[HttpPost(\"publish\")]")]
    public void NewPresentationArtifactEndpoints_QueueOnlyOpenDesign(
        string signature,
        string nextEndpoint)
    {
        var source = File.ReadAllText(ControllerPath());
        var start = source.IndexOf(signature, StringComparison.Ordinal);
        var end = source.IndexOf(nextEndpoint, start, StringComparison.Ordinal);
        start.ShouldBeGreaterThanOrEqualTo(0);
        end.ShouldBeGreaterThan(start);
        var endpoint = source[start..end];

        endpoint.ShouldContain("_openDesignRuns.QueueAsync(");
        endpoint.ShouldContain("StreamOpenDesignPptRunAsync(");
        endpoint.ShouldNotContain("_gateway.");
        endpoint.ShouldNotContain("CreateSessionAsync(");
    }

    [Fact]
    public void Controller_HasNoLegacyFinalArtifactExecutorsOrStaticFallback()
    {
        var source = File.ReadAllText(ControllerPath());
        foreach (var removed in new[]
                 {
                     "RunPagesGenerationAsync(",
                     "RunAgentStreamAsync(",
                     "RunGatewayDeckStreamAsync(",
                     "TryRunSinglePagePatchAsync(",
                     "ConsoleDashboardFallbackSlide(",
                     "BuildGatewayPageRequest(",
                     "PersistLocalEdit(",
                     "runs/{parentRunId}/local-edit",
                 })
            source.ShouldNotContain(removed, customMessage: $"新成品不能保留旧执行入口：{removed}");
    }

    [Fact]
    public void OpenDesignHistoryAndPublish_DoNotNormalizeOrRebuildTheAuthoredDocument()
    {
        var source = File.ReadAllText(ControllerPath());
        source.ShouldContain("!string.Equals(run.Runtime, DesignArtifactRuntimes.OpenDesign");
        source.ShouldContain("var openDesignArtifact = string.Equals(");
        source.ShouldContain("? sourceRun.Html\n            : PreparePublishedHtml(NormalizePresentationDocument(sourceRun.Html))");
        source.ShouldContain("ManualEditHtml");
    }

    private static string ControllerPath()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            var path = Path.Combine(dir.FullName, "prd-api", "src", "PrdAgent.Api", "Controllers", "Api", "MdToPptController.cs");
            if (File.Exists(path)) return path;
            dir = dir.Parent;
        }

        throw new DirectoryNotFoundException("Could not locate MdToPptController.cs from test base directory.");
    }
}
