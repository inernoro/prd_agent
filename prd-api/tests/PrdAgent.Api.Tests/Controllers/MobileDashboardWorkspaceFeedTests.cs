using PrdAgent.Api.Controllers.Api;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class MobileDashboardWorkspaceFeedTests
{
    [Fact]
    public void ResolveWorkspaceFeedTarget_文学工作区返回文学入口()
    {
        var target = MobileDashboardController.ResolveWorkspaceFeedTarget(
            "literary-workspace-id",
            "article-illustration");

        target.Type.ShouldBe("literary-workspace");
        target.Subtitle.ShouldBe("文学创作");
        target.NavigateTo.ShouldBe("/literary-agent/literary-workspace-id");
    }

    [Theory]
    [InlineData("image-gen")]
    [InlineData("other")]
    [InlineData(null)]
    public void ResolveWorkspaceFeedTarget_非文学工作区保持视觉入口(string? scenarioType)
    {
        var target = MobileDashboardController.ResolveWorkspaceFeedTarget(
            "visual-workspace-id",
            scenarioType);

        target.Type.ShouldBe("visual-workspace");
        target.Subtitle.ShouldBe("视觉创作");
        target.NavigateTo.ShouldBe("/visual-agent/visual-workspace-id");
    }
}
