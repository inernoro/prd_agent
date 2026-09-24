using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.MdToPpt;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// PPT 发布必须先校验目标团队、再建站点（PR #1533 评审 4024742437 / 4060021399）。
/// 以前 viewer / 非成员团队要等站点建好后才在 SetSharedTeamsAsync 里被拒，那次拒绝又被
/// 当成可重试失败：接口反复 503、最终 dead-letter，站点留在个人空间成了孤儿。
///
/// 这里不连 Mongo：数据库传 null。校验若排在建意图之后，就会先碰到数据库而不是抛出
/// 越权异常——这条用例正是靠这一点在修复前变红。
/// </summary>
public sealed class HtmlPptPublishTeamPrecheckTests
{
    private const string Html = "<!doctype html><html><head></head><body>deck</body></html>";

    [Fact]
    public async Task ForbiddenTeam_IsRejectedBeforeAnySiteIsCreated()
    {
        var run = DoneRun();
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(s => s.CanPublishIntoTeamAsync(run.UserId, "team-editor", It.IsAny<CancellationToken>()))
            .ReturnsAsync(true);
        sites.Setup(s => s.CanPublishIntoTeamAsync(run.UserId, "team-viewer", It.IsAny<CancellationToken>()))
            .ReturnsAsync(false);
        var coordinator = new HtmlPptPublishCoordinator(
            null!,
            sites.Object,
            Mock.Of<IHostedSiteRevisionService>(MockBehavior.Strict),
            Mock.Of<IHtmlPptDesignArtifactAdapter>(MockBehavior.Strict),
            NullLogger<HtmlPptPublishCoordinator>.Instance);

        var error = await Assert.ThrowsAsync<HtmlPptPublishForbiddenException>(() =>
            coordinator.PublishAsync(run, run.Title, null, [], ["team-editor", "team-viewer"]));

        Assert.Equal(["team-viewer"], error.TeamIds);
        // Strict mock：任何建站 / 分享调用都会直接抛错，这里再显式钉一次「一个站点都没建」。
        sites.Verify(s => s.CreateFromHtmlIdempotentAsync(
            It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<List<string>?>(),
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    private static MdToPptRun DoneRun() => new()
    {
        Id = "publish-precheck-run",
        UserId = "owner-user",
        Status = "done",
        Runtime = DesignArtifactRuntimes.HtmlPptPipeline,
        Provider = "open-design-html-ppt",
        ArtifactContractVersion = DesignArtifactContractVersions.Current,
        Op = "convert",
        Title = "HTML PPT",
        SourceSurface = DesignArtifactSourceSurfaces.HtmlPpt,
        Html = Html,
        HtmlHash = MdToPptController.ComputeHtmlHash(Html),
    };
}
