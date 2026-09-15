using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 归属失败的写入要过与 model / phase 同一道租约闸（Codex P2，2026-09-15）。
///
/// 只按 run id 写的话，丢了租约的 worker 会把接管者已经跑成功的那一轮改写成「归属失败」，
/// 于是一次成功恢复的生成对用户显示成「网页留在个人空间」——相邻的写入本来就设了闸，
/// 这一处漏了就是形状 3（同一条判据分裂成两套）。
/// </summary>
public sealed class DestinationApplyErrorFencingTests
{
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task StaleWorkerCannotOverwriteTheRunOwnedByItsSuccessor()
    {
        await using var fixture = await RunMongoFixture.CreateAsync("destination_fencing");
        var now = DateTime.UtcNow;
        var run = new DesignArtifactRun
        {
            Id = "run-destination-1",
            DeploymentSlug = DeploymentScope.Current,
            UserId = "user-1",
            Status = RunStatuses.Committing,
            LeaseOwnerId = "successor",
            LeaseExpiresAt = now.AddMinutes(5),
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);

        var stale = await HostedSiteEditRunWorker.PersistDestinationApplyErrorAsync(
            fixture.Db, run.Id, "stale-worker", "归属目标团队时发生错误", now, CancellationToken.None);
        Assert.False(stale);

        var untouched = await fixture.Db.DesignArtifactRuns
            .Find(x => x.Id == run.Id).FirstAsync(CancellationToken.None);
        Assert.Null(untouched.DestinationApplyError);

        // companion：闸本身是通的，否则上面那条会因为「谁都写不进去」而对着一堵墙判绿。
        var owner = await HostedSiteEditRunWorker.PersistDestinationApplyErrorAsync(
            fixture.Db, run.Id, "successor", "归属目标团队时发生错误", now, CancellationToken.None);
        Assert.True(owner);

        var written = await fixture.Db.DesignArtifactRuns
            .Find(x => x.Id == run.Id).FirstAsync(CancellationToken.None);
        Assert.Equal("归属目标团队时发生错误", written.DestinationApplyError);
    }

    /// <summary>
    /// 闸建好了还得接上：这条走真实的提交路径，在归属那一刻把租约转给接管者，
    /// 断言掉队的 worker 一个字都没写进去（形状 2，链路只建一半——上一版守卫只测了
    /// 那个带闸的方法本身，把调用点的闸拆掉它照样绿）。
    /// </summary>
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task LosingTheLeaseWhileAssigningLeavesNoDestinationErrorBehind()
    {
        await using var fixture = await RunMongoFixture.CreateAsync("destination_fencing_wiring");
        var now = new DateTime(DateTime.UtcNow.Ticks - DateTime.UtcNow.Ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);
        var run = new DesignArtifactRun
        {
            Id = "run-destination-2",
            DeploymentSlug = DeploymentScope.Current,
            UserId = "user-1",
            Status = RunStatuses.Queued,
            Instruction = "生成页面",
            Operation = DesignArtifactOperations.Generate,
            DestinationTeamId = "team-1",
            CreatedAt = now,
            UpdatedAt = now,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var claimed = await HostedSiteEditRunWorker.TryClaimAsync(
            fixture.Db, run.Id, "worker-a", now, TimeSpan.FromMinutes(2), CancellationToken.None);
        Assert.NotNull(claimed);

        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.CreateFromContentAsync(
                It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(),
                It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<List<string>?>(), It.IsAny<string?>(),
                It.IsAny<CancellationToken>(), It.IsAny<int?>()))
            .ReturnsAsync(new HostedSite { Id = "site-1", OwnerUserId = "user-1" });
        sites.Setup(x => x.SetSharedTeamsAsync(
                "site-1", "user-1", It.IsAny<List<string>>(), It.IsAny<CancellationToken>()))
            .Returns(async () =>
            {
                // 接管者在归属这一刻拿走了租约。
                await fixture.Db.DesignArtifactRuns.UpdateOneAsync(
                    x => x.Id == run.Id,
                    Builders<DesignArtifactRun>.Update.Set(x => x.LeaseOwnerId, "worker-b"));
                throw new IOException("对象存储抖了一下");
            });
        // 归属排在版本快照之后（见下一条用例的理由），所以这两步必须先放行。
        var siteRecord = new HostedSite { Id = "site-1", OwnerUserId = "user-1", EntryFile = "index.html" };
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(siteRecord, "<!doctype html><html><body>safe</body></html>", now));
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(x => x.EnsureGeneratedSnapshotAsync(
                "site-1", "user-1", It.IsAny<HostedSiteEditableEntry>(), It.IsAny<string>(),
                run.Id, It.IsAny<IReadOnlyCollection<string>>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteRevision
            {
                Id = "revision-1",
                SiteId = "site-1",
                CreatedByUserId = "user-1",
                Status = HostedSiteRevisionStatuses.Published,
            });

        await Assert.ThrowsAsync<DesignArtifactRunLeaseLostException>(() =>
            HostedSiteEditRunWorker.PersistArtifactWithLeaseAsync(
                fixture.Db,
                claimed!,
                "worker-a",
                "<!doctype html><html><body>safe</body></html>",
                null,
                null,
                sites.Object,
                revisions.Object,
                now.AddSeconds(1),
                TimeSpan.FromMinutes(2),
                CancellationToken.None));

        var persisted = await fixture.Db.DesignArtifactRuns
            .Find(x => x.Id == run.Id).FirstAsync(CancellationToken.None);
        Assert.Null(persisted.DestinationApplyError);
        // companion：归属确实被走到了，否则上面那条会因为「压根没走到这一步」而判绿。
        sites.Verify(x => x.SetSharedTeamsAsync(
            "site-1", "user-1", It.IsAny<List<string>>(), It.IsAny<CancellationToken>()), Times.Once);
    }

    /// <summary>
    /// 归属团队必须排在所有还会失败的持久化步骤之后。
    ///
    /// 补偿只认「私有、未发布、未分享」的站点（CompensateGeneratedSiteCoreAsync 的围栏含
    /// SharedTeamIds 为空）。先盖团队再撞上续租或版本快照失败，补偿就一个候选都找不到、
    /// 随即清掉清理计划——任务报失败，而站点和它的对象仍然挂在用户选的团队里，没有任何
    /// 东西会来收拾（Codex P2，2026-09-15）。
    /// </summary>
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task ASnapshotFailureMustNotLeaveTheSiteAlreadyAssignedToTheTeam()
    {
        await using var fixture = await RunMongoFixture.CreateAsync("destination_order");
        var now = new DateTime(DateTime.UtcNow.Ticks - DateTime.UtcNow.Ticks % TimeSpan.TicksPerMillisecond, DateTimeKind.Utc);
        var run = new DesignArtifactRun
        {
            Id = "run-destination-3",
            DeploymentSlug = DeploymentScope.Current,
            UserId = "user-1",
            Status = RunStatuses.Queued,
            Instruction = "生成页面",
            Operation = DesignArtifactOperations.Generate,
            DestinationTeamId = "team-1",
            CreatedAt = now,
            UpdatedAt = now,
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);
        var claimed = await HostedSiteEditRunWorker.TryClaimAsync(
            fixture.Db, run.Id, "worker-a", now, TimeSpan.FromMinutes(2), CancellationToken.None);
        Assert.NotNull(claimed);

        var siteRecord = new HostedSite { Id = "site-1", OwnerUserId = "user-1", EntryFile = "index.html" };
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.CreateFromContentAsync(
                It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<string?>(),
                It.IsAny<string>(), It.IsAny<string?>(), It.IsAny<List<string>?>(), It.IsAny<string?>(),
                It.IsAny<CancellationToken>(), It.IsAny<int?>()))
            .ReturnsAsync(siteRecord);
        sites.Setup(x => x.GetEditableEntryHtmlAsync("site-1", "user-1", It.IsAny<CancellationToken>()))
            .ReturnsAsync(new HostedSiteEditableEntry(siteRecord, "<!doctype html><html><body>safe</body></html>", now));
        var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
        revisions.Setup(x => x.EnsureGeneratedSnapshotAsync(
                "site-1", "user-1", It.IsAny<HostedSiteEditableEntry>(), It.IsAny<string>(),
                run.Id, It.IsAny<IReadOnlyCollection<string>>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new IOException("版本账本写失败"));

        await Assert.ThrowsAsync<IOException>(() =>
            HostedSiteEditRunWorker.PersistArtifactWithLeaseAsync(
                fixture.Db,
                claimed!,
                "worker-a",
                "<!doctype html><html><body>safe</body></html>",
                null,
                null,
                sites.Object,
                revisions.Object,
                now.AddSeconds(1),
                TimeSpan.FromMinutes(2),
                CancellationToken.None));

        // 站点还没被盖上团队，补偿的围栏因此仍然认得它。
        sites.Verify(x => x.SetSharedTeamsAsync(
            It.IsAny<string>(), It.IsAny<string>(), It.IsAny<List<string>>(), It.IsAny<CancellationToken>()), Times.Never);
        // companion：快照确实被走到了，否则上面那条会因为「压根没走到这一步」而判绿。
        revisions.Verify(x => x.EnsureGeneratedSnapshotAsync(
            "site-1", "user-1", It.IsAny<HostedSiteEditableEntry>(), It.IsAny<string>(),
            run.Id, It.IsAny<IReadOnlyCollection<string>>(), It.IsAny<CancellationToken>()), Times.Once);
    }
}
