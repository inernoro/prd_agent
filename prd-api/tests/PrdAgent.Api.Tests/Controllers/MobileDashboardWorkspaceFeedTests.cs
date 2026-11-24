using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class MobileDashboardWorkspaceFeedTests
{
    [Fact]
    public void ResolveWorkspaceFeedTarget_文学工作区返回文学入口()
    {
        var target = ImageMasterWorkspacePresentation.Resolve(
            "literary-workspace-id",
            "article-illustration");

        target.AgentKey.ShouldBe("literary-agent");
        target.FeedType.ShouldBe("literary-workspace");
        target.Subtitle.ShouldBe("文学创作");
        target.Route.ShouldBe("/literary-agent/literary-workspace-id");
    }

    [Theory]
    [InlineData("image-gen")]
    [InlineData("other")]
    [InlineData(null)]
    public void ResolveWorkspaceFeedTarget_非文学工作区保持视觉入口(string? scenarioType)
    {
        var target = ImageMasterWorkspacePresentation.Resolve(
            "visual-workspace-id",
            scenarioType);

        target.AgentKey.ShouldBe("visual-agent");
        target.FeedType.ShouldBe("visual-workspace");
        target.Subtitle.ShouldBe("视觉创作");
        target.Route.ShouldBe("/visual-agent/visual-workspace-id");
    }
}
