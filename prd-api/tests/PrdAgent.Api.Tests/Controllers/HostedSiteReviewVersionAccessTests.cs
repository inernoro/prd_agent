using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using Xunit;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Microsoft.Extensions.Logging.Abstractions;
using System.Security.Claims;
using System.Text.Json;

namespace PrdAgent.Api.Tests.Controllers;

public class HostedSiteReviewVersionAccessTests
{
    [Theory]
    [Trait("Category", "Integration")]
    [InlineData("viewer", false)]
    [InlineData("editor", true)]
    public async Task TeamMember_CannotBypassHistoryScopeThroughSiteRoutes(string role, bool editor)
    {
        await WithReviewDb(async db =>
        {
            var site = ReviewSite(); site.SharedTeamIds = new() { "team" };
            await db.HostedSites.InsertOneAsync(site);
            await db.HostedSiteRevisions.InsertManyAsync(new[] { ReviewRevision("old", site.ContentVersion.AddDays(-1)), ReviewRevision("current", site.ContentVersion) });
            await db.HostedSiteComments.InsertManyAsync(new[] {
                new HostedSiteComment { Id = "old-comment", SiteId = site.Id, AuthorUserId = "member", Content = "removed secret", ContentVersion = HostedSiteCommentRules.VersionKey(site.ContentVersion.AddDays(-1)) },
                new HostedSiteComment { Id = "current-comment", SiteId = site.Id, Content = "safe", ContentVersion = HostedSiteCommentRules.VersionKey(site.ContentVersion) },
            });
            var teams = new Mock<ITeamService>(MockBehavior.Strict);
            teams.Setup(x => x.GetMyTeamIdsAsync("member", It.IsAny<CancellationToken>())).ReturnsAsync(new List<string> { "team" });
            teams.Setup(x => x.GetMyWebHostingTeamRolesAsync("member", It.IsAny<CancellationToken>())).ReturnsAsync(new Dictionary<string, string> { ["team"] = role });
            var storage = new Mock<IAssetStorage>();
            storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>())).Returns((string key) => "https://assets.example/" + key);
            var sites = new HostedSiteService(db, storage.Object, null!, null!, teams.Object, null!, null!, null!, NullLogger<HostedSiteService>.Instance);
            var controller = ReviewController(sites, db, Mock.Of<IHostedSiteRevisionService>(), storage.Object, "member");
            var list = Assert.IsType<OkObjectResult>(await controller.ListReviewVersions(site.Id));
            var json = JsonSerializer.Serialize(Assert.IsType<ApiResponse<object>>(list.Value).Data);
            Assert.Contains("current", json);
            Assert.Equal(editor, json.Contains("\"Id\":\"old\""));
            Assert.Equal(editor ? 200 : 404, Assert.IsAssignableFrom<ObjectResult>(await controller.PreviewReviewVersion(site.Id, "old")).StatusCode);
            Assert.IsType<OkObjectResult>(await controller.PreviewReviewVersion(site.Id, "current"));
            var comments = await sites.ListCommentsBySiteAsync(site.Id, "member");
            Assert.NotNull(comments);
            Assert.Equal(editor, comments.Comments.Any(c => c.Content.Contains("secret")));
            Assert.Contains(comments.Comments, c => c.Id == "current-comment");
            var root = await sites.AddCommentBySiteAsync(site.Id, "member", "member", null, "history root", revisionId: "old");
            Assert.Equal(editor ? 200 : 404, root.HttpStatus);
            var reply = await sites.AddCommentBySiteAsync(site.Id, "member", "member", null, "history reply", parentId: "old-comment");
            Assert.Equal(editor ? 200 : 404, reply.HttpStatus);
            var resolve = await sites.SetCommentResolvedBySiteAsync(site.Id, "old-comment", "member", true);
            Assert.Equal(editor ? 200 : 404, resolve.HttpStatus);
            var current = await sites.AddCommentBySiteAsync(site.Id, "member", "member", null, "current remains writable", revisionId: "current");
            Assert.Equal(200, current.HttpStatus);
            teams.VerifyAll();
        });
    }

    [Theory]
    [Trait("Category", "Integration")]
    [InlineData(null, false)]
    [InlineData("outsider", false)]
    [InlineData("owner", true)]
    public async Task ShareHistoryAndComments_RequireIndependentSiteEditPermission(string? viewer, bool editor)
    {
        await WithReviewDb(async db =>
        {
            var site = ReviewSite();
            await db.HostedSites.InsertOneAsync(site);
            await db.WebPageShareLinks.InsertOneAsync(new WebPageShareLink { Token = "share", SiteId = site.Id, Visibility = "public" });
            await db.HostedSiteRevisions.InsertManyAsync(new[] { ReviewRevision("old", site.ContentVersion.AddDays(-1)), ReviewRevision("current", site.ContentVersion) });
            await db.HostedSiteComments.InsertManyAsync(new[] {
                new HostedSiteComment { Id = "old-comment", SiteId = site.Id, AuthorUserId = "outsider", Content = "removed secret", ContentVersion = HostedSiteCommentRules.VersionKey(site.ContentVersion.AddDays(-1)) },
                new HostedSiteComment { Id = "current-comment", SiteId = site.Id, Content = "safe", ContentVersion = HostedSiteCommentRules.VersionKey(site.ContentVersion) },
            });
            var sites = new HostedSiteService(db, null!, null!, null!, null!, null!, null!, null!, NullLogger<HostedSiteService>.Instance);
            var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
            storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>())).Returns((string key) => "https://assets.example/" + key);
            var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
            var controller = ReviewController(sites, db, revisions.Object, storage.Object, viewer);
            var list = Assert.IsType<OkObjectResult>(await controller.ListSharedReviewVersions("share", null));
            var json = JsonSerializer.Serialize(Assert.IsType<ApiResponse<object>>(list.Value).Data);
            Assert.Contains("current", json);
            Assert.Equal(editor, json.Contains("\"Id\":\"old\""));
            var old = await controller.PreviewSharedReviewVersion("share", "old", null);
            Assert.Equal(editor ? 200 : 404, Assert.IsAssignableFrom<ObjectResult>(old).StatusCode);
            var comments = await sites.ListCommentsByShareAsync("share", null, viewer);
            Assert.Equal(editor, comments.Comments.Any(c => c.Content.Contains("secret")));
            Assert.Contains(comments.Comments, c => c.Id == "current-comment");
            if (viewer == "outsider")
            {
                var root = await sites.AddCommentByShareAsync("share", null, viewer, viewer, null, "new thread", null, revisionId: "old");
                Assert.Equal(404, root.HttpStatus);
                var write = await sites.AddCommentByShareAsync("share", null, viewer, viewer, null, "reply", null, parentId: "old-comment");
                Assert.Equal(404, write.HttpStatus);
                var resolve = await sites.SetCommentResolvedByShareAsync("share", null, "old-comment", viewer, true);
                Assert.Equal(404, resolve.HttpStatus);
            }
            revisions.VerifyNoOtherCalls();
            storage.Verify(x => x.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
        });
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task SavedHistory_RemainsAvailableWhenCurrentEntryDownloadFails()
    {
        await WithReviewDb(async db =>
        {
            var site = ReviewSite();
            await db.HostedSiteRevisions.InsertOneAsync(ReviewRevision("old", site.ContentVersion.AddDays(-1)));
            var sites = new Mock<IHostedSiteService>();
            sites.Setup(x => x.GetByIdAsync(site.Id, "owner", It.IsAny<CancellationToken>())).ReturnsAsync(site);
            sites.Setup(x => x.CanEditSiteAsync(It.IsAny<HostedSite>(), "owner", It.IsAny<CancellationToken>())).ReturnsAsync(true);
            var storage = new Mock<IAssetStorage>();
            storage.Setup(x => x.TryDownloadBytesAsync("current.html", It.IsAny<CancellationToken>())).ThrowsAsync(new IOException("offline"));
            storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>())).Returns("https://assets.example/old.html");
            var controller = ReviewController(sites.Object, db, Mock.Of<IHostedSiteRevisionService>(), storage.Object, "owner");
            var result = Assert.IsType<OkObjectResult>(await controller.ListReviewVersions(site.Id));
            Assert.Contains("old", JsonSerializer.Serialize(Assert.IsType<ApiResponse<object>>(result.Value).Data));
            storage.Verify(x => x.TryDownloadBytesAsync("current.html", It.IsAny<CancellationToken>()), Times.Once);
        });
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task ShareBaselineCapture_IsAttributedToSiteOwnerRatherThanVisitor()
    {
        await WithReviewDb(async db =>
        {
            var site = ReviewSite();
            var sites = new Mock<IHostedSiteService>();
            sites.Setup(x => x.ResolveShareSiteAsync("share", null, null, "outsider", It.IsAny<CancellationToken>())).ReturnsAsync(new ShareSiteResolveResult { Site = site });
            sites.Setup(x => x.CanEditSiteAsync(site, "outsider", It.IsAny<CancellationToken>())).ReturnsAsync(false);
            var revisions = new Mock<IHostedSiteRevisionService>(MockBehavior.Strict);
            revisions.Setup(x => x.EnsureCurrentSnapshotAsync(site.Id, "owner", It.IsAny<HostedSiteEditableEntry>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync(ReviewRevision("current", site.ContentVersion));
            var storage = new Mock<IAssetStorage>();
            storage.Setup(x => x.TryDownloadBytesAsync("current.html", It.IsAny<CancellationToken>())).ReturnsAsync(System.Text.Encoding.UTF8.GetBytes("<h1>safe</h1>"));
            var controller = ReviewController(sites.Object, db, revisions.Object, storage.Object, "outsider");
            Assert.IsType<OkObjectResult>(await controller.ListSharedReviewVersions("share", null));
            revisions.VerifyAll();
        });
    }

    private static HostedSite ReviewSite() => new() { Id = "site", OwnerUserId = "owner", CommentsEnabled = true,
        ContentVersion = new DateTime(2026, 11, 4, 0, 0, 0, DateTimeKind.Utc), EntryFile = "index.html",
        Files = new() { new HostedSiteFile { Path = "index.html", CosKey = "current.html", Size = 20 } } };
    private static HostedSiteRevision ReviewRevision(string id, DateTime version) => new() { Id = id, SiteId = "site", CreatedByUserId = "owner",
        Status = HostedSiteRevisionStatuses.Published, PublishedContentVersion = version, PublishedEntryCosKey = id + ".html",
        PublishedEntryFile = "index.html", CapturedContentShape = HostedSiteContentShapes.SelfContainedHtml, Html = "<h1>" + id + "</h1>" };
    private static WebPagesController ReviewController(IHostedSiteService sites, MongoDbContext db, IHostedSiteRevisionService revisions, IAssetStorage storage, string? viewer) => new(sites, null!, null!, db, null!, null!, revisions: revisions, assetStorage: storage)
    { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
        User = viewer == null ? new ClaimsPrincipal() : new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", viewer) }, "test")) } } };
    private static async Task WithReviewDb(Func<MongoDbContext, Task> run)
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
        var database = "hosted_review_test_" + Guid.NewGuid().ToString("N");
        var client = new MongoClient(connection);
        try { await run(new MongoDbContext(connection, database)); }
        finally { await client.DropDatabaseAsync(database); }
    }
    [Theory]
    [InlineData(401, "UNAUTHORIZED")]
    [InlineData(403, "VISIBILITY_DENIED")]
    [InlineData(404, "not_found")]
    [InlineData(400, "expired")]
    [InlineData(429, "rate_limited")]
    public async Task SharedVersionMetadataAndPreview_ApplyShareGateBeforeAnyRevisionLookup(int status, string code)
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(s => s.ResolveShareSiteAsync("share", null, "pw", null, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new ShareSiteResolveResult
            {
                Error = "分享访问被拒绝", HttpStatus = status, ErrorCode = code, RetryAfterSeconds = status == 429 ? 12 : null,
            });
        // 空数据库依赖刻意使“在门禁之前查询历史版本”的回归直接失败。
        var controller = new WebPagesController(sites.Object, null!, null!, null!, null!, null!)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        var list = Assert.IsAssignableFrom<ObjectResult>(await controller.ListSharedReviewVersions("share", "pw"));
        var preview = Assert.IsAssignableFrom<ObjectResult>(await controller.PreviewSharedReviewVersion("share", "private-draft", "pw"));
        Assert.Equal(status, list.StatusCode);
        Assert.Equal(status, preview.StatusCode);
        sites.VerifyAll();
        if (status == 429) Assert.Equal("12", controller.Response.Headers["Retry-After"].ToString());
    }
}
