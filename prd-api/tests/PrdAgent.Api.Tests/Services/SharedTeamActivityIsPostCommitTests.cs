using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 团队活动流留痕是**提交之后**的尽力而为记录，不是这次归属的一部分（Codex P2，2026-09-15）。
///
/// 站点文档已经写进库，活动流再抛出去，会让调用方把一次已经成功的归属报告成失败：
/// controller 那条路给用户 500，生成任务那条路把 DestinationApplyError 记上，
/// 于是终态事件告诉用户「网页留在个人空间」，而它其实已经在团队里了。
/// </summary>
public sealed class SharedTeamActivityIsPostCommitTests
{
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task CommittedAssignmentSurvivesAFailingActivityFeed()
    {
        await using var fixture = await RunMongoFixture.CreateAsync("shared_team_activity");

        var site = new HostedSite
        {
            Id = "site-activity-1",
            OwnerUserId = "owner-1",
            Title = "要投进团队的网页",
            SharedTeamIds = [],
        };
        await fixture.Db.HostedSites.InsertOneAsync(site);

        var teams = new Mock<ITeamService>();
        teams.Setup(x => x.GetMyWebHostingTeamRolesAsync("owner-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new Dictionary<string, string> { ["team-1"] = "editor" });
        var activity = new Mock<ITeamActivityService>();
        activity
            .Setup(x => x.LogForTeamsAsync(
                It.IsAny<IEnumerable<string>>(), It.IsAny<string>(), It.IsAny<string>(),
                It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string>(),
                It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new IOException("活动流写入失败"));

        var service = new HostedSiteService(
            fixture.Db,
            Mock.Of<IAssetStorage>(),
            Mock.Of<IShortLinkService>(),
            Mock.Of<ISharePasswordService>(),
            teams.Object,
            activity.Object,
            Mock.Of<IUploadProgressService>(),
            Mock.Of<IAskOpeningQuestionGenerator>(),
            NullLogger<HostedSiteService>.Instance);

        var moved = await service.SetSharedTeamsAsync(
            site.Id, "owner-1", ["team-1"], CancellationToken.None);

        Assert.NotNull(moved);
        Assert.Contains("team-1", moved!.SharedTeamIds);
        // companion：活动流确实被调用过并抛了，否则上面两条会对着一条没走到的路判绿。
        activity.VerifyAll();
        var persisted = await fixture.Db.HostedSites
            .Find(x => x.Id == site.Id)
            .FirstOrDefaultAsync(CancellationToken.None);
        Assert.Contains("team-1", persisted.SharedTeamIds);
    }
}
