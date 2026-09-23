using PrdAgent.Core.Services;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests.Services;

public class LiteraryMcpWorkflowTests
{
    private const string Article = "第一段。\n[插图]: 雨后书店\n\n第二段。\n[插图]: 白色茶杯\n";

    [Fact]
    public void RecoveryFillsOnlyExactMissingPointersAndPreservesNewRunningState()
    {
        var ws = new ImageMasterWorkspace { ScenarioType = "article-illustration", ArticleWorkflow = LiteraryMcpWorkflow.Prepare(Article) };
        ws.ArticleWorkflow.AssetIdByMarkerIndex["0"] = "authoritative";
        ws.ArticleWorkflow.Markers[1].Status = "running";
        ws.ArticleWorkflow.Markers[1].RunId = "new-run";
        ImageAsset Asset(int index, int version, string workspaceId) => new()
        {
            WorkspaceId = workspaceId, ArticleInsertionIndex = index, ArticleWorkflowVersion = version,
            Url = "https://example.test/image.png",
        };
        var current = Asset(1, 1, ws.Id);
        Assert.True(LiteraryMcpWorkflow.RecoverVersionedAssets(ws, new[]
        {
            Asset(1, 0, ws.Id), Asset(1, 1, "foreign"), Asset(9, 1, ws.Id), Asset(0, 1, ws.Id), current,
        }));
        Assert.Equal("authoritative", ws.ArticleWorkflow.AssetIdByMarkerIndex["0"]);
        Assert.Equal(current.Id, ws.ArticleWorkflow.AssetIdByMarkerIndex["1"]);
        Assert.Equal(2, ws.ArticleWorkflow.DoneImageCount);
        Assert.Equal("running", ws.ArticleWorkflow.Markers[1].Status);
        Assert.Equal("new-run", ws.ArticleWorkflow.Markers[1].RunId);
        Assert.False(LiteraryMcpWorkflow.RecoverVersionedAssets(ws, new[] { current }));
    }

    [Fact]
    public void PrepareUsesSameMarkerIndicesAsReader()
    {
        Assert.Null(LiteraryMcpWorkflow.Validate(null, Article, "验收"));
        var workflow = LiteraryMcpWorkflow.Prepare(Article);
        Assert.Equal(2, workflow.Phase);
        Assert.Equal(1, workflow.Version);
        Assert.Equal(2, workflow.ExpectedImageCount);
        Assert.Equal(new[] { 0, 1 }, workflow.Markers.Select(m => m.Index));
        Assert.Equal("白色茶杯", workflow.Markers[1].PlanItem!.Prompt);
        Assert.DoesNotContain("[插图]", LiteraryMcpWorkflow.PlainContent(Article));
        Assert.Contains("第二段。", LiteraryMcpWorkflow.PlainContent(Article));
    }

    [Fact]
    public void SecondImageFinishingFirstDoesNotShiftToFirstMarker()
    {
        var rendered = LiteraryMcpWorkflow.Render(Article, new Dictionary<int, string> { [1] = "https://example.test/two.png" });
        Assert.Contains("[插图]: 雨后书店", rendered);
        Assert.Contains("第二段。\n![配图 2](<https://example.test/two.png>)", rendered);
        Assert.DoesNotContain("[插图]: 白色茶杯", rendered);
        Assert.Equal(Article, LiteraryMcpWorkflow.Render(Article, new Dictionary<int, string> { [0] = "javascript:alert(1)" }));
    }

    [Fact]
    public void RejectsAmbiguousOrUnboundedInputs()
    {
        Assert.NotNull(LiteraryMcpWorkflow.Validate("正文", Article, null));
        Assert.NotNull(LiteraryMcpWorkflow.Validate(null, "只有正文", null));
        Assert.NotNull(LiteraryMcpWorkflow.Validate(null, "[插图]: 只有图", null));
        Assert.NotNull(LiteraryMcpWorkflow.Validate(null, "正文\n" + string.Concat(Enumerable.Repeat("[插图]: 图\n", 5)), null));
        Assert.NotNull(LiteraryMcpWorkflow.Validate(null, "正文\n[插图]: " + new string('图', 4001), null));
        Assert.NotNull(LiteraryMcpWorkflow.Validate(null, null, new string('夹', 81)));
    }
}
