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
    [InlineData("create-zip")]
    [InlineData("replace-zip")]
    [InlineData("replace-html")]
    public async Task CommittedUpload_ReturnsPublishedSiteWithoutPostCommitSnapshotWork(string operation)
    {
        var published = ReviewSite();
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        if (operation == "create-zip")
            sites.Setup(x => x.CreateFromZipAsync("owner", It.IsAny<Stream>(), null, null, null,
                It.IsAny<List<string>>(), null, It.IsAny<CancellationToken>(), "upload", null)).ReturnsAsync(published);
        else if (operation == "replace-zip")
            sites.Setup(x => x.ReuploadAsync("site", "owner", It.IsAny<Stream>(), "page.zip", null,
                It.IsAny<CancellationToken>(), "upload", null)).ReturnsAsync(published);
        else
            sites.Setup(x => x.ReuploadAsync("site", "owner", It.IsAny<byte[]>(), "page.html", null,
                It.IsAny<CancellationToken>(), "upload", null)).ReturnsAsync(published);
        var progress = new Mock<IUploadProgressService>(MockBehavior.Strict);
        progress.Setup(x => x.CompleteAsync("upload", It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        var controller = new WebPagesController(sites.Object, null!, progress.Object,
            new MongoDbContext("mongodb://127.0.0.1:27018", "unused_upload_test"), null!, null!, assetStorage: storage.Object)
        { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext {
            User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "owner") }, "test")) } } };
        using var bytes = new MemoryStream(new byte[] { 1 });
        var file = new FormFile(bytes, 0, 1, "file", operation == "replace-html" ? "page.html" : "page.zip");
        var result = operation == "create-zip"
            ? await controller.Upload(file, null, null, null, null, "upload")
            : await controller.Reupload("site", file, "upload");
        Assert.Same(published, Assert.IsType<ApiResponse<object>>(Assert.IsType<OkObjectResult>(result).Value).Data);
        sites.VerifyAll(); sites.VerifyNoOtherCalls(); storage.VerifyNoOtherCalls();
        progress.Verify(x => x.CompleteAsync("upload", It.IsAny<CancellationToken>()), Times.Once);
    }

    [Theory]
    [Trait("Category", "Integration")]
    [InlineData("entry")]
    [InlineData("package")]
    [InlineData("reupload")]
    [InlineData("reupload-no-snapshot")]
    [InlineData("stream-no-snapshot")]
    [InlineData("reupload-no-snapshot-cleanup-fails")]
    public async Task ExistingShare_AiAndPackagePublicationRetireTheLegacyEntry(string mode)
    {
        await WithReviewDb(async db =>
        {
            const string prefix = "web-hosting/sites/site/";
            var site = ReviewSite(); site.Files[0].CosKey = prefix + "index.html"; site.PublishedRevisionId = "baseline";
            site.Files.Add(new HostedSiteFile { Path = "style.css", CosKey = prefix + "style.css", Size = 12, MimeType = "text/css" });
            await db.HostedSites.InsertOneAsync(site);
            await db.WebPageShareLinks.InsertOneAsync(new WebPageShareLink { Token = "existing", SiteId = "site", Visibility = "public" });
            const string privateHtml = "<!doctype html><html><body><h1>private V1</h1></body></html>";
            var baseline = ReviewRevision("baseline", site.ContentVersion);
            baseline.Html = privateHtml; baseline.PublishedEntryCosKey = site.Files[0].CosKey;
            baseline.PublishedAssetKeys = site.Files.Select(f => f.CosKey).ToList();
            baseline.CapturedContentShape = HostedSiteContentShapes.MultiFile;
            if (!mode.Contains("no-snapshot")) await db.HostedSiteRevisions.InsertOneAsync(baseline);
            const string html = "<!doctype html><html><body><h1>sanitized V2</h1></body></html>";
            var bytes = System.Text.Encoding.UTF8.GetBytes(html);
            var draft = new HostedSiteRevision { Id = "draft", SiteId = "site", CreatedByUserId = "owner", Status = HostedSiteRevisionStatuses.Draft,
                BasedOnContentVersion = site.ContentVersion, Source = HostedSiteRevisionSources.AiEdit, Html = html };
            if (mode == "package")
            {
                draft.Html = HostedSiteRevisionRules.HardenGeneratedHtml(html);
                draft.VerifiedFiles = new[] { "index.html", "manifest.json" }.Select(path => {
                    var content = System.Text.Encoding.UTF8.GetBytes(path == "index.html" ? draft.Html : "{}");
                    return new HostedSiteRevisionFile { Path = path, Content = content,
                        Sha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(content)).ToLowerInvariant(),
                        MimeType = path == "index.html" ? "text/html" : "application/json" };
                }).ToList();
            }
            await db.HostedSiteRevisions.InsertOneAsync(draft);
            var objects = new Dictionary<string, byte[]> { [site.Files[0].CosKey] = System.Text.Encoding.UTF8.GetBytes(privateHtml), [prefix + "style.css"] = System.Text.Encoding.UTF8.GetBytes("h1{color:red}") };
            var storage = new Mock<IAssetStorage>();
            storage.Setup(x => x.BuildSiteKey("site", It.IsAny<string>())).Returns((string _, string path) => prefix + path);
            storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>())).Returns((string key) => "https://assets.example/" + key);
            storage.Setup(x => x.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync((string key, CancellationToken _) => objects.GetValueOrDefault(key));
            storage.Setup(x => x.UploadToKeyAsync(It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(), It.IsAny<string>()))
                .Returns((string key, byte[] content, string _, CancellationToken __, string ___) => { objects[key] = content; return Task.CompletedTask; });
            storage.Setup(x => x.DeleteByKeyAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .Returns((string key, CancellationToken _) => {
                    if (mode.EndsWith("cleanup-fails")) return Task.FromException(new IOException("storage deletion unavailable"));
                    objects.Remove(key); return Task.CompletedTask;
                });
            var teams = new Mock<ITeamService>();
            teams.Setup(x => x.GetMyTeamIdsAsync("owner", It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
            var sites = new HostedSiteService(db, storage.Object, null!, null!, teams.Object, null!, Mock.Of<IUploadProgressService>(), Mock.Of<IAskOpeningQuestionGenerator>(), NullLogger<HostedSiteService>.Instance);
            var revisions = new HostedSiteRevisionService(db, sites, storage.Object);
            if (mode.EndsWith("cleanup-fails"))
            {
                await Assert.ThrowsAsync<InvalidOperationException>(() => sites.ReuploadAsync("site", "owner", bytes, "index.html"));
                var unchanged = await db.HostedSites.Find(s => s.Id == "site").FirstAsync();
                Assert.Equal(site.ContentVersion, unchanged.ContentVersion);
                Assert.All(objects.Values, value => Assert.DoesNotContain("sanitized V2", System.Text.Encoding.UTF8.GetString(value)));
                Assert.True(await db.HostedSiteRevisions.Find(r => r.SiteId == "site" && r.PublishedContentVersion == site.ContentVersion).AnyAsync());
                await Assert.ThrowsAsync<InvalidOperationException>(() => sites.PrepareReviewHistoryAssetsAsync("site", "owner"));
                return;
            }
            HostedSite published;
            if (mode == "stream-no-snapshot")
            {
                using var zip = new MemoryStream();
                using (var archive = new System.IO.Compression.ZipArchive(zip, System.IO.Compression.ZipArchiveMode.Create, true))
                using (var target = archive.CreateEntry("index.html").Open()) await target.WriteAsync(bytes);
                zip.Position = 0;
                published = await sites.ReuploadAsync("site", "owner", zip, "new.zip");
            }
            else published = mode.StartsWith("reupload")
                ? await sites.ReuploadAsync("site", "owner", bytes, "index.html", null)
                : (await revisions.PublishAsync("site", "draft", "owner")).Site;
            Assert.False(objects.ContainsKey(prefix + "index.html"));
            Assert.Contains("sanitized V2", System.Text.Encoding.UTF8.GetString(objects[published.Files[0].CosKey]));
            var saved = await db.HostedSiteRevisions.Find(r => r.SiteId == "site" && r.PublishedContentVersion == site.ContentVersion).FirstAsync();
            Assert.Contains("private V1", System.Text.Encoding.UTF8.GetString(objects[saved.PublishedEntryCosKey!]));
            Assert.StartsWith(prefix + ".versions/", saved.PublishedEntryCosKey);
            var oldDirectory = saved.PublishedEntryCosKey![..(saved.PublishedEntryCosKey.LastIndexOf('/') + 1)];
            Assert.False(published.Files[0].CosKey.StartsWith(oldDirectory, StringComparison.Ordinal));
            if (mode == "entry")
            {
                var publishedEntry = published.Files.Single(f => f.Path == "index.html");
                Assert.Equal("text/html; charset=utf-8", publishedEntry.MimeType);
                storage.Verify(x => x.UploadToKeyAsync(publishedEntry.CosKey, It.IsAny<byte[]>(), "text/html; charset=utf-8", It.IsAny<CancellationToken>(), It.IsAny<string>()), Times.Once);
                var css = published.Files.Single(f => f.Path == "style.css");
                Assert.Equal("h1{color:red}", System.Text.Encoding.UTF8.GetString(objects[css.CosKey]));
                Assert.False(css.CosKey.StartsWith(oldDirectory, StringComparison.Ordinal));
            }
            Assert.True(await db.WebPageShareLinks.Find(s => s.Token == "existing" && !s.IsRevoked).AnyAsync());
            var controller = ReviewController(sites, db, storage.Object, null);
            Assert.IsType<NotFoundObjectResult>(await controller.PreviewSharedReviewVersion("existing", "baseline", null));
        });
    }

    [Theory]
    [Trait("Category", "Integration")]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task RetainedHistory_MovesGuessableAssetsAndBlocksSharingWhenCleanupFails(bool failDelete, bool relocateCurrent)
    {
        await WithReviewDb(async db =>
        {
            const string prefix = "web-hosting/sites/site/";
            var site = ReviewSite();
            site.Files[0].CosKey = relocateCurrent ? prefix + "index.html" : prefix + ".versions/11111111111141118111111111111111/index.html";
            if (relocateCurrent) site.EntryFile = "INDEX.HTML";
            var legacyEntry = prefix + (relocateCurrent ? "v1/index.html" : "index.html");
            var legacyStyle = prefix + (relocateCurrent ? "v1/style.css" : "style.css");
            await db.HostedSites.InsertOneAsync(site);
            var old = ReviewRevision("old", site.ContentVersion.AddDays(-1));
            old.PublishedEntryCosKey = legacyEntry;
            old.PublishedEntryFile = relocateCurrent ? "v1/index.html" : "index.html";
            old.PublishedAssetKeys = new() { legacyEntry, legacyStyle };
            old.CapturedContentShape = HostedSiteContentShapes.MultiFile;
            await db.HostedSiteRevisions.InsertOneAsync(old);
            var current = ReviewRevision("current", site.ContentVersion);
            current.PublishedEntryCosKey = site.Files[0].CosKey;
            current.PublishedAssetKeys = new() { site.Files[0].CosKey };
            if (relocateCurrent) current.PublishedEntryCosKey = null;
            await db.HostedSiteRevisions.InsertOneAsync(current);
            const string legacyHtml = "<link rel='stylesheet' href='style.css'><h1>旧版中文 private V1</h1>";
            var objects = new Dictionary<string, byte[]> {
                [legacyEntry] = System.Text.Encoding.UTF8.GetBytes(legacyHtml),
                [legacyStyle] = System.Text.Encoding.UTF8.GetBytes("h1{color:red}"),
                [site.Files[0].CosKey] = System.Text.Encoding.UTF8.GetBytes("<h1>public V2</h1>"),
            };
            var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
            storage.Setup(x => x.BuildSiteKey("site", It.IsAny<string>())).Returns((string _, string path) => prefix + path);
            storage.Setup(x => x.BuildUrlForKey(It.IsAny<string>())).Returns((string key) => "https://assets.example/" + key);
            storage.Setup(x => x.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .ReturnsAsync((string key, CancellationToken _) => objects.GetValueOrDefault(key));
            storage.Setup(x => x.UploadToKeyAsync(It.IsAny<string>(), It.IsAny<byte[]>(), It.IsAny<string>(), It.IsAny<CancellationToken>(), It.IsAny<string>()))
                .Returns((string key, byte[] bytes, string _, CancellationToken __, string ___) => { objects[key] = bytes; return Task.CompletedTask; });
            storage.Setup(x => x.DeleteByKeyAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
                .Returns((string key, CancellationToken _) => {
                    if (failDelete && key == legacyEntry) throw new IOException("cleanup offline");
                    objects.Remove(key); return Task.CompletedTask;
                });
            var teams = new Mock<ITeamService>();
            teams.Setup(x => x.GetMyTeamIdsAsync("owner", It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
            var sites = new HostedSiteService(db, storage.Object, null!, null!, teams.Object, null!, null!, null!, NullLogger<HostedSiteService>.Instance);
            if (failDelete)
            {
                await Assert.ThrowsAsync<InvalidOperationException>(() => sites.CreateShareWithReuseInfoAsync(
                    "owner", "Owner", "site", null, "single", null, null, null, 7, visibility: "public", forceNew: true));
                Assert.Equal(0, await db.WebPageShareLinks.CountDocumentsAsync(_ => true));
                var controller = ReviewController(sites, db, storage.Object, "owner");
                var refused = Assert.IsType<ConflictObjectResult>(await controller.CreateShare(new CreateWebPageShareRequest { SiteId = "site", ShareType = "single", Visibility = "public" }));
                Assert.Contains("清理", Assert.IsType<ApiResponse<object>>(refused.Value).Error!.Message);
                Assert.IsType<ConflictObjectResult>(await controller.SetVisibility("site", new SetVisibilityRequest { Visibility = "public" }));
                await db.WebPageShareLinks.InsertOneAsync(new WebPageShareLink { Id = "owner-share", CreatedBy = "owner", SiteId = "site", Visibility = "owner-only" });
                Assert.IsType<ConflictObjectResult>(await controller.UpdateShareSettings("owner-share", new UpdateShareSettingsRequest { Visibility = "public" }));
                Assert.Equal("owner-only", (await db.WebPageShareLinks.Find(s => s.Id == "owner-share").FirstAsync()).Visibility);
            }
            else await sites.PrepareReviewHistoryAssetsAsync("site", "owner", relocateCurrent: relocateCurrent);
            var archived = await db.HostedSiteRevisions.Find(r => r.Id == "old").FirstAsync();
            Assert.StartsWith(prefix + ".versions/", archived.PublishedEntryCosKey);
            Assert.All(archived.PublishedAssetKeys, key => Assert.StartsWith(prefix + ".versions/", key));
            Assert.Contains("private V1", System.Text.Encoding.UTF8.GetString(objects[archived.PublishedEntryCosKey!]));
            Assert.Equal(System.Text.Encoding.UTF8.GetBytes(legacyHtml), objects[archived.PublishedEntryCosKey!]);
            storage.Verify(x => x.UploadToKeyAsync(archived.PublishedEntryCosKey!, It.IsAny<byte[]>(), "text/html; charset=utf-8",
                It.IsAny<CancellationToken>(), It.IsAny<string>()), Times.Once);
            Assert.Contains(archived.PublishedAssetKeys, key => key.EndsWith("/style.css") && objects.ContainsKey(key));
            var immutableEntry = archived.PublishedEntryCosKey;
            var stale = ReviewSite(); stale.ContentVersion = old.PublishedContentVersion!.Value;
            stale.Files[0].CosKey = legacyEntry;
            var revisions = new HostedSiteRevisionService(db, sites, storage.Object);
            await revisions.EnsureCurrentSnapshotAsync("site", "owner", new HostedSiteEditableEntry(stale, legacyHtml, stale.ContentVersion));
            var afterStale = await db.HostedSiteRevisions.Find(r => r.Id == "old").FirstAsync();
            Assert.Equal(immutableEntry, afterStale.PublishedEntryCosKey);
            Assert.DoesNotContain(legacyEntry, afterStale.PublishedAssetKeys);
            Assert.Equal(failDelete, objects.ContainsKey(legacyEntry));
            var live = await db.HostedSites.Find(s => s.Id == "site").FirstAsync();
            Assert.Contains("public V2", System.Text.Encoding.UTF8.GetString(objects[live.Files[0].CosKey]));
            Assert.Equal(site.ContentVersion, live.ContentVersion);
            Assert.StartsWith(prefix + ".versions/", live.Files[0].CosKey);
            if (relocateCurrent) Assert.False(objects.ContainsKey(prefix + "index.html"));
            if (failDelete)
            {
                var pending = await db.HostedSites.Find(s => s.Id == "site").FirstAsync();
                Assert.Contains(legacyEntry, pending.PendingAssetCleanupKeys);
            }
        });
    }

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
            var controller = ReviewController(sites, db, storage.Object, "member");
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
            var controller = ReviewController(sites, db, storage.Object, viewer);
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
            storage.Verify(x => x.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
        });
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task SavedHistory_RemainsAvailableWithoutDownloadingCurrentEntry()
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
            var controller = ReviewController(sites.Object, db, storage.Object, "owner");
            var result = Assert.IsType<OkObjectResult>(await controller.ListReviewVersions(site.Id));
            Assert.Contains("old", JsonSerializer.Serialize(Assert.IsType<ApiResponse<object>>(result.Value).Data));
            storage.Verify(x => x.TryDownloadBytesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Never);
        });
    }

    [Theory]
    [Trait("Category", "Integration")]
    [InlineData(null)]
    [InlineData("outsider")]
    [InlineData("owner")]
    public async Task ShareVersionRead_ProjectsUnrecordedCurrentWithoutWritingSnapshots(string? viewer)
    {
        await WithReviewDb(async db =>
        {
            var site = ReviewSite();
            var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
            sites.Setup(x => x.ResolveShareSiteAsync("share", null, null, viewer, It.IsAny<CancellationToken>())).ReturnsAsync(new ShareSiteResolveResult { Site = site });
            if (viewer != null) sites.Setup(x => x.CanEditSiteAsync(site, viewer, It.IsAny<CancellationToken>())).ReturnsAsync(viewer == "owner");
            var storage = new Mock<IAssetStorage>(MockBehavior.Strict);
            var controller = ReviewController(sites.Object, db, storage.Object, viewer);
            var response = Assert.IsType<OkObjectResult>(await controller.ListSharedReviewVersions("share", null));
            var json = JsonSerializer.Serialize(Assert.IsType<ApiResponse<object>>(response.Value).Data);
            Assert.Contains("\"Id\":\"\"", json);
            Assert.Contains("\"IsCurrent\":true", json);
            Assert.Contains(site.SiteUrl, json);
            Assert.Equal(0, await db.HostedSiteRevisions.CountDocumentsAsync(_ => true));
            storage.VerifyNoOtherCalls();
        });
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task ConcurrentSnapshots_WithEquivalentMongoPrecision_CreateOneBaseline()
    {
        await WithReviewDb(async db =>
        {
            var site = ReviewSite();
            var revisions = new HostedSiteRevisionService(db, Mock.Of<IHostedSiteService>());
            var results = await Task.WhenAll(Enumerable.Range(1, 16).Select(offset => revisions.EnsureCurrentSnapshotAsync(site.Id, "owner",
                new HostedSiteEditableEntry(site, "<h1>same publication</h1>", site.ContentVersion.AddTicks(offset)))));
            Assert.Single(results.Select(r => r.Id).Distinct());
            Assert.Equal(1, await db.HostedSiteRevisions.CountDocumentsAsync(r => r.SiteId == site.Id));
        });
    }

    private static HostedSite ReviewSite() => new() { Id = "site", OwnerUserId = "owner", CommentsEnabled = true,
        ContentVersion = new DateTime(2026, 11, 4, 0, 0, 0, DateTimeKind.Utc), EntryFile = "index.html", SiteUrl = "https://assets.example/current.html",
        Files = new() { new HostedSiteFile { Path = "index.html", CosKey = "current.html", Size = 20 } } };
    private static HostedSiteRevision ReviewRevision(string id, DateTime version) => new() { Id = id, SiteId = "site", CreatedByUserId = "owner",
        Status = HostedSiteRevisionStatuses.Published, PublishedContentVersion = version, PublishedEntryCosKey = id + ".html",
        PublishedEntryFile = "index.html", CapturedContentShape = HostedSiteContentShapes.SelfContainedHtml, Html = "<h1>" + id + "</h1>" };
    private static WebPagesController ReviewController(IHostedSiteService sites, MongoDbContext db, IAssetStorage storage, string? viewer) => new(sites, null!, null!, db, null!, null!, assetStorage: storage)
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
