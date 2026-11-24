using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

public class DesignArtifactRunTests
{
    [Fact]
    public void Defaults_DescribeQueuedWebGenerationThroughMapGateway()
    {
        var run = new DesignArtifactRun();

        Assert.Equal(RunStatuses.Queued, run.Status);
        Assert.Equal(DesignArtifactTypes.WebPage, run.ArtifactType);
        Assert.Equal(DesignArtifactOperations.Generate, run.Operation);
        Assert.Equal(DesignArtifactSourceSurfaces.WebHosting, run.SourceSurface);
        Assert.Equal(DesignArtifactRuntimes.MapGateway, run.Runtime);
        Assert.Empty(run.KnowledgeReferences);
    }

    [Fact]
    public void KnowledgeSnapshot_KeepsSourceAndContentForLaterAudit()
    {
        var snapshot = new DesignKnowledgeSnapshot
        {
            EntryId = "entry-1",
            StoreId = "store-1",
            StoreName = "产品知识库",
            Title = "发布说明",
            Content = "正文快照",
            ContentHash = "sha256",
        };

        var run = new DesignArtifactRun { KnowledgeReferences = new List<DesignKnowledgeSnapshot> { snapshot } };

        Assert.Equal("entry-1", run.KnowledgeReferences.Single().EntryId);
        Assert.Equal("正文快照", run.KnowledgeReferences.Single().Content);
        Assert.Equal("sha256", run.KnowledgeReferences.Single().ContentHash);
    }
}
