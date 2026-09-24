using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 发布换版之后，哪些对象键成了孤儿。
///
/// 这条判据一旦按「这次删没删 sidecar」去分支，单文件站点就会漏掉旧入口：
/// 每次发布都写一个带版本号的新入口 key，旧的既不再被站点引用、也没进回收队列，
/// 于是每发布一次，对象存储里就多留一份永远不会被回收的旧正文。
/// </summary>
public sealed class HostedSiteObsoleteAssetKeyTests
{
    [Fact]
    public void SingleFileSite_ShouldRetireTheReplacedEntryObject()
    {
        var previous = Files(("index.html", "sites/s1/index.html"));
        var next = Files(("index.html", "sites/s1/index.v2.html"));

        HostedSiteService.ComputeObsoleteAssetKeys(previous, next)
            .ShouldBe(new[] { "sites/s1/index.html" });
    }

    [Fact]
    public void PartialEntrySwap_ShouldKeepTheSidecarsThatAreStillReferenced()
    {
        var previous = Files(
            ("index.html", "sites/s1/index.html"),
            ("style.css", "sites/s1/style.css"),
            ("hero.png", "sites/s1/hero.png"));
        var next = Files(
            ("index.html", "sites/s1/index.v2.html"),
            ("style.css", "sites/s1/style.css"),
            ("hero.png", "sites/s1/hero.png"));

        HostedSiteService.ComputeObsoleteAssetKeys(previous, next)
            .ShouldBe(new[] { "sites/s1/index.html" });
    }

    [Fact]
    public void SelfContainedRewrite_ShouldRetireEveryDroppedSidecar()
    {
        var previous = Files(
            ("index.html", "sites/s1/index.html"),
            ("style.css", "sites/s1/style.css"),
            ("hero.png", "sites/s1/hero.png"));
        var next = Files(("index.html", "sites/s1/index.v2.html"));

        HostedSiteService.ComputeObsoleteAssetKeys(previous, next)
            .ShouldBe(new[] { "sites/s1/index.html", "sites/s1/style.css", "sites/s1/hero.png" });
    }

    [Fact]
    public void WholePackageSwap_ShouldRetireEveryOldObject()
    {
        var previous = Files(
            ("index.html", "sites/s1/.versions/a/index.html"),
            ("app.js", "sites/s1/.versions/a/app.js"));
        var next = Files(
            ("index.html", "sites/s1/.versions/b/index.html"),
            ("app.js", "sites/s1/.versions/b/app.js"));

        HostedSiteService.ComputeObsoleteAssetKeys(previous, next)
            .ShouldBe(new[] { "sites/s1/.versions/a/index.html", "sites/s1/.versions/a/app.js" });
    }

    [Fact]
    public void AKeyThatTwoPathsShare_ShouldSurviveWhileEitherPathStillPointsAtIt()
    {
        // 同一个对象被两条路径引用时，只换掉其中一条不能把对象删了。
        var previous = Files(
            ("index.html", "sites/s1/index.html"),
            ("alias.html", "sites/s1/index.html"));
        var next = Files(
            ("index.html", "sites/s1/index.v2.html"),
            ("alias.html", "sites/s1/index.html"));

        HostedSiteService.ComputeObsoleteAssetKeys(previous, next).ShouldBeEmpty();
    }

    [Fact]
    public void EmptyKeys_ShouldNeverReachTheCleanupQueue()
    {
        var previous = Files(("index.html", "sites/s1/index.html"), ("broken.css", "  "));
        var next = Files(("index.html", "sites/s1/index.v2.html"));

        HostedSiteService.ComputeObsoleteAssetKeys(previous, next)
            .ShouldBe(new[] { "sites/s1/index.html" });
    }

    [Fact]
    public void EveryPendingCleanupEnqueue_ShouldGoThroughTheSharedPredicate()
    {
        // 接线守卫：三条发布路径都必须用同一个判据算孤儿键。
        // 任何一条自己就地拼一份 obsoleteKeys，就是下一次漂移的入口（形状 3）。
        var source = File.ReadAllText(LocateHostedSiteService());

        var assignments = source
            .Split('\n')
            .Select(line => line.Trim())
            .Where(line => line.StartsWith("var obsoleteKeys = "))
            .ToList();

        assignments.Count.ShouldBe(3, customMessage: "发布路径数量变了，守卫需要跟着更新");
        assignments.ShouldAllBe(
            line => line.StartsWith("var obsoleteKeys = ComputeObsoleteAssetKeys("),
            customMessage: "有发布路径自己就地算孤儿键，没走共享判据（形状 3：判据分裂后各自漂移）");
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishingASingleFileSite_ShouldDeleteTheReplacedEntryObject()
    {
        await using var fixture = await RunMongoFixture.CreateAsync("hosted_site_obsolete_keys");
        var oldEntryKey = "sites/site-1/index.html";
        var now = DateTime.UtcNow;
        await fixture.Db.HostedSites.InsertOneAsync(new HostedSite
        {
            Id = "site-1",
            OwnerUserId = "user-1",
            Visibility = "private",
            EntryFile = "index.html",
            Files = new List<HostedSiteFile>
            {
                new() { Path = "index.html", CosKey = oldEntryKey, Size = 32, MimeType = "text/html" },
            },
            ContentVersion = now,
            CreatedAt = now,
        });

        var storage = new Mock<IAssetStorage>();
        storage.Setup(x => x.TryDownloadBytesAsync(oldEntryKey, It.IsAny<CancellationToken>()))
            .ReturnsAsync(System.Text.Encoding.UTF8.GetBytes("<html><body>old</body></html>"));
        storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>()))
            .Returns<string>(key => $"https://cdn.example/{key}");
        storage.Setup(x => x.UploadToKeyAsync(
                It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string>(),
                It.IsAny<CancellationToken>(), It.IsAny<string>()))
            .Returns(Task.CompletedTask);
        storage.Setup(x => x.DeleteByKeyAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);

        var service = CreateHostedSiteService(fixture.Db, storage.Object);
        var updated = await service.ReplaceEntryHtmlAsync(
            "site-1", "user-1", "<html><body>new</body></html>", ct: CancellationToken.None);

        updated.Files.Single().CosKey.ShouldNotBe(oldEntryKey);
        // 旧入口对象在指针切走之后就是孤儿：必须真的被回收，
        // 否则每发布一次就在对象存储里多留一份永不回收的旧正文。
        storage.Verify(x => x.DeleteByKeyAsync(oldEntryKey, It.IsAny<CancellationToken>()), Times.Once);
    }

    private static HostedSiteService CreateHostedSiteService(MongoDbContext db, IAssetStorage storage)
    {
        var teams = new Mock<ITeamService>();
        teams.Setup(x => x.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        return new HostedSiteService(
            db,
            storage,
            Mock.Of<IShortLinkService>(),
            Mock.Of<ISharePasswordService>(),
            teams.Object,
            Mock.Of<ITeamActivityService>(),
            Mock.Of<IUploadProgressService>(),
            Mock.Of<IAskOpeningQuestionGenerator>(),
            NullLogger<HostedSiteService>.Instance);
    }

    private static string LocateHostedSiteService()
    {
        var dir = Directory.GetCurrentDirectory();
        while (dir != null)
        {
            var candidate = Path.Combine(
                dir, "src", "PrdAgent.Infrastructure", "Services", "HostedSiteService.cs");
            if (File.Exists(candidate)) return candidate;
            dir = Directory.GetParent(dir)?.FullName;
        }

        throw new FileNotFoundException("没有找到 HostedSiteService.cs，守卫无法确认接线");
    }

    private static List<HostedSiteFile> Files(params (string Path, string Key)[] items) =>
        items.Select(item => new HostedSiteFile { Path = item.Path, CosKey = item.Key }).ToList();
}
