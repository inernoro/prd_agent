using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.MdToPpt;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Security;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
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
        sites.Setup(s => s.GetTeamsNotPublishableAsync(
                run.UserId,
                It.Is<IReadOnlyCollection<string>>(ids => ids.SequenceEqual(new[] { "team-editor", "team-viewer" })),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(["team-viewer"]);
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

    /// <summary>
    /// teamIds 没有上限（PR #1611 Codex 评审）：预检对整批团队只许加载一次成员关系，
    /// 不能每个团队都全量重载一次。这里用真的 HostedSiteService、只把 ITeamService 换成计数桩，
    /// 于是走的是生产里同一条判据（viewer 与非成员都被拒，owner / editor 放行）。
    /// </summary>
    [Fact]
    public async Task ManyTeams_LoadMembershipOnce_AndStillRejectViewerAndStranger()
    {
        var run = DoneRun();
        var roleLoads = 0;
        var teams = new Mock<ITeamService>(MockBehavior.Strict);
        teams.Setup(t => t.GetMyWebHostingTeamRolesAsync(run.UserId, It.IsAny<CancellationToken>()))
            .Callback(() => roleLoads++)
            .ReturnsAsync(new Dictionary<string, string>
            {
                ["team-owner"] = WebHostingRoles.Owner,
                ["team-editor-a"] = WebHostingRoles.Editor,
                ["team-editor-b"] = WebHostingRoles.Editor,
                ["team-viewer"] = WebHostingRoles.Viewer,
            });
        var coordinator = new HtmlPptPublishCoordinator(
            null!,
            RealSiteService(teams.Object),
            Mock.Of<IHostedSiteRevisionService>(MockBehavior.Strict),
            Mock.Of<IHtmlPptDesignArtifactAdapter>(MockBehavior.Strict),
            NullLogger<HtmlPptPublishCoordinator>.Instance);

        var error = await Assert.ThrowsAsync<HtmlPptPublishForbiddenException>(() =>
            coordinator.PublishAsync(run, run.Title, null, [],
                ["team-owner", "team-editor-a", "team-viewer", "team-editor-b", "team-stranger", " team-editor-a "]));

        Assert.Equal(["team-viewer", "team-stranger"], error.TeamIds);
        Assert.Equal(1, roleLoads);
    }

    private static HostedSiteService RealSiteService(ITeamService teams) => new(
        null!,
        Mock.Of<IAssetStorage>(),
        Mock.Of<IShortLinkService>(),
        Mock.Of<ISharePasswordService>(),
        teams,
        Mock.Of<ITeamActivityService>(),
        Mock.Of<IUploadProgressService>(),
        Mock.Of<IAskOpeningQuestionGenerator>(),
        NullLogger<HostedSiteService>.Instance);

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
