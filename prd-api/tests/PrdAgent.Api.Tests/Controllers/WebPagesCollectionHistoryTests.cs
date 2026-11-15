using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class WebPagesCollectionHistoryTests
{
    [Theory]
    [InlineData("active", true)]
    [InlineData("rotated", false)]
    [InlineData("dissolved", false)]
    [InlineData("missing", false)]
    [InlineData("hybrid-active", true)]
    [InlineData("hybrid-stopped", false)]
    public async Task HistoryUsesChapterRouteAndTheSameSnapshotGenerationStatus(string state, bool active)
    {
        var share = new WebPageShareLink { Id = "chapter-link", Token = "chapter-token", CreatedBy = "owner-user", ShareType = "collection", SiteIds = new() { "site-a" },
            CollectionId = state.StartsWith("hybrid-") ? "directory" : null, CollectionShareGeneration = 1,
            CollectionSnapshot = new() { CollectionId = "chapters", ShareGeneration = 1 } };
        var shares = new Mock<IMongoCollection<WebPageShareLink>>(MockBehavior.Strict);
        shares.Setup(x => x.CountDocumentsAsync(It.IsAny<FilterDefinition<WebPageShareLink>>(), It.IsAny<CountOptions>(), It.IsAny<CancellationToken>())).ReturnsAsync(1);
        shares.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<WebPageShareLink>>(), It.IsAny<FindOptions<WebPageShareLink, WebPageShareLink>>(), It.IsAny<CancellationToken>()))
            .Returns(() => Task.FromResult(Cursor(share)));
        var documents = state == "missing" ? Array.Empty<HostedDocumentCollection>() : new[] {
            new HostedDocumentCollection { Id = "chapters", Name = "章节合集", OwnerUserId = "owner-user", ShareGeneration = state == "rotated" ? 2 : 1,
                DissolvedAt = state == "dissolved" ? DateTime.UtcNow : null } };
        var directories = new Mock<IMongoCollection<HostedCollection>>(MockBehavior.Strict);
        directories.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<HostedCollection>>(), It.IsAny<FindOptions<HostedCollection, HostedCollection>>(), It.IsAny<CancellationToken>()))
            .Returns(() => Task.FromResult(Cursor(new HostedCollection { Id = "directory", OwnerUserId = "owner-user", ShareGeneration = state == "hybrid-stopped" ? 2 : 1 })));
        var row = Result(await ContextController(directories.Object, shares.Object, documents).CollectionHistory("site-a")).GetProperty("items")[0];
        Assert.Equal("/s/collection/chapter-token", row.GetProperty("shareUrl").GetString());
        Assert.Equal(active, row.GetProperty("isActive").GetBoolean());
        Assert.Equal(active ? "有效" : "已停止", row.GetProperty("statusLabel").GetString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("other-directory")]
    public async Task CompatibilityLookupAndAdoptionRejectChapterSnapshotsBeforeAnyCollectionWrite(string? directoryId)
    {
        var share = new WebPageShareLink { Token = "chapter-token", CreatedBy = "owner-user", ShareType = "collection",
            CollectionId = directoryId, CollectionSnapshot = new() { CollectionId = "chapters", ShareGeneration = 2 }, SiteIds = new() { "site-a" } };
        var shares = new Mock<IMongoCollection<WebPageShareLink>>(MockBehavior.Strict);
        shares.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<WebPageShareLink>>(), It.IsAny<FindOptions<WebPageShareLink, WebPageShareLink>>(), It.IsAny<CancellationToken>()))
            .Returns(() => Task.FromResult(Cursor(share)));
        var collections = new Mock<IMongoCollection<HostedCollection>>(MockBehavior.Strict);
        var controller = ContextController(collections.Object, shares.Object);
        Assert.IsType<NotFoundObjectResult>(await controller.CollectionByShare(share.Token));
        Assert.IsType<NotFoundObjectResult>(await controller.AdoptCollection(share.Token, new("不要重复导入", "site-a")));
        Assert.Empty(collections.Invocations);
        Assert.Equal(directoryId, share.CollectionId);
        Assert.Equal("chapters", share.CollectionSnapshot.CollectionId);
        Assert.All(shares.Invocations, call => Assert.Equal("FindAsync", call.Method.Name));
    }

    [Fact]
    public async Task UnmanagedHistoricalShareStillOffersItsExistingCompatibilityImport()
    {
        var share = new WebPageShareLink { Token = "old-token", CreatedBy = "owner-user", ShareType = "collection", SiteIds = new() { "site-a" } };
        var shares = new Mock<IMongoCollection<WebPageShareLink>>(MockBehavior.Strict);
        shares.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<WebPageShareLink>>(), It.IsAny<FindOptions<WebPageShareLink, WebPageShareLink>>(), It.IsAny<CancellationToken>()))
            .Returns(() => Task.FromResult(Cursor(share)));
        var data = Result(await ContextController(Mock.Of<IMongoCollection<HostedCollection>>(), shares.Object).CollectionByShare(share.Token));
        Assert.Equal(JsonValueKind.Null, data.GetProperty("collection").ValueKind);
        Assert.Equal("site-a", data.GetProperty("legacyShare").GetProperty("siteIds")[0].GetString());
        Assert.Equal(1, data.GetProperty("sites").GetArrayLength());
    }

    [Fact]
    public async Task ShareListKeepsChapterIdentityDistinctFromHistoricalDirectoryLinks()
    {
        var sites = new Mock<IHostedSiteService>(MockBehavior.Strict);
        sites.Setup(x => x.ListSharesAsync("owner-user", default, false, null)).ReturnsAsync(new List<WebPageShareLink> {
            new() { Id = "old", Token = "old-token", ShareType = "collection", CollectionId = "directory" },
            new() { Id = "new", Token = "new-token", ShareType = "collection", CollectionSnapshot = new() { CollectionId = "chapters" } } });
        sites.Setup(x => x.GetTitlesByIdsAsync(It.IsAny<IEnumerable<string>>(), default)).ReturnsAsync(new Dictionary<string, string>());
        var db = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        var data = Result(await Build(sites.Object, db).ListShares());
        Assert.Equal(JsonValueKind.Null, data.GetProperty("items")[0].GetProperty("documentCollectionId").ValueKind);
        Assert.Equal("chapters", data.GetProperty("items")[1].GetProperty("documentCollectionId").GetString());
        sites.VerifyAll();
    }

    [Fact]
    public async Task HistoryUsesOwnerAndMemberQueryWithoutRecentWindowAndPreservesOriginalLinks()
    {
        var old = new WebPageShareLink { Id = "old", Token = "original-token", CreatedBy = "owner-user", SiteIds = new() { "site-a" }, ShareType = "collection", Title = "早期合集", CreatedAt = DateTime.UtcNow.AddYears(-2), Password = "must-not-be-returned" };
        var revoked = new WebPageShareLink { Id = "revoked", Token = "revoked-token", SiteIds = new() { "site-a" }, IsRevoked = true };
        var expired = new WebPageShareLink { Id = "expired", Title = "", SiteIds = new() { "site-a" }, ExpiresAt = DateTime.UtcNow.AddMonths(-3) };
        var stopped = new WebPageShareLink { Id = "stopped", SiteIds = new() { "site-a" }, CollectionId = "closed", CollectionShareGeneration = 1 };
        var shares = new Mock<IMongoCollection<WebPageShareLink>>(MockBehavior.Strict);
        BsonDocument? query = null; FindOptions<WebPageShareLink, WebPageShareLink>? options = null;
        shares.Setup(x => x.CountDocumentsAsync(It.IsAny<FilterDefinition<WebPageShareLink>>(), It.IsAny<CountOptions>(), It.IsAny<CancellationToken>())).ReturnsAsync(24);
        shares.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<WebPageShareLink>>(), It.IsAny<FindOptions<WebPageShareLink, WebPageShareLink>>(), It.IsAny<CancellationToken>()))
            .Callback<FilterDefinition<WebPageShareLink>, FindOptions<WebPageShareLink, WebPageShareLink>, CancellationToken>((filter, find, _) => { query = filter.Render(new RenderArgs<WebPageShareLink>(BsonSerializer.LookupSerializer<WebPageShareLink>(), BsonSerializer.SerializerRegistry)); options = find; })
            .Returns(() => Task.FromResult(Cursor(old, revoked, expired, stopped)));
        var collections = new Mock<IMongoCollection<HostedCollection>>(MockBehavior.Strict);
        collections.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<HostedCollection>>(), It.IsAny<FindOptions<HostedCollection, HostedCollection>>(), It.IsAny<CancellationToken>()))
            .Returns(() => Task.FromResult(Cursor(new HostedCollection { Id = "closed", OwnerUserId = "owner-user", ShareGeneration = 2 })));
        var db = new Mock<IMongoDatabase>(MockBehavior.Strict);
        db.Setup(x => x.GetCollection<WebPageShareLink>("web_page_share_links", null)).Returns(shares.Object);
        db.Setup(x => x.GetCollection<HostedCollection>("hosted_collections", null)).Returns(collections.Object);
        var context = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(context, db.Object);
        var service = new Mock<IHostedSiteService>(MockBehavior.Strict);
        service.Setup(x => x.GetByIdAsync("site-a", "owner-user", CancellationToken.None)).ReturnsAsync(new HostedSite { Id = "site-a" });
        var controller = Build(service.Object, context);
        var response = Assert.IsType<OkObjectResult>(await controller.CollectionHistory("site-a", 2));
        var data = JsonSerializer.SerializeToElement(response.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("data");
        Assert.Equal(24, data.GetProperty("total").GetInt32()); Assert.Equal(20, options!.Skip); Assert.Equal(20, options.Limit);
        var rendered = Assert.IsType<BsonDocument>(query);
        Assert.Equal("owner-user", rendered["CreatedBy"].AsString); Assert.Equal("collection", rendered["ShareType"].AsString);
        Assert.Contains("site-a", rendered.ToJson()); Assert.DoesNotContain("ExpiresAt", rendered.ToJson()); Assert.DoesNotContain("CreatedAt", rendered.ToJson());
        var items = data.GetProperty("items").EnumerateArray().ToArray();
        Assert.Equal("/s/wp/original-token", items[0].GetProperty("shareUrl").GetString()); Assert.True(items[0].GetProperty("isActive").GetBoolean());
        Assert.Equal(new[] { "有效", "已撤销", "已过期", "已停止" }, items.Select(x => x.GetProperty("statusLabel").GetString()));
        Assert.Equal("未命名合集", items[2].GetProperty("title").GetString());
        Assert.DoesNotContain("must-not-be-returned", data.GetRawText());
        await controller.CollectionHistory("site-a", 1, "评审");
        var searched = Assert.IsType<BsonDocument>(query).ToJson();
        Assert.Contains("Title", searched); Assert.Contains("Token", searched); Assert.Contains("评审", searched);
        Assert.Contains("owner-user", searched); Assert.Contains("site-a", searched);
        service.VerifyAll();
    }

    [Fact]
    public async Task UnreadableDocumentRejectsBeforeQueryingAnyCollectionHistory()
    {
        var service = new Mock<IHostedSiteService>(MockBehavior.Strict);
        service.Setup(x => x.GetByIdAsync("private-site", "owner-user", CancellationToken.None)).ReturnsAsync((HostedSite?)null);
        var context = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        Assert.IsType<NotFoundObjectResult>(await Build(service.Object, context).CollectionHistory("private-site"));
        Assert.IsType<NotFoundObjectResult>(await Build(service.Object, context).CollectionContexts("private-site"));
        Assert.IsType<NotFoundObjectResult>(await Build(service.Object, context).CollectionContextDocuments("private-site", "collection:one"));
        Assert.IsType<NotFoundObjectResult>(await Build(service.Object, context).CollectionContextLinks("private-site", "collection:one"));
    }

    [Fact]
    public async Task ContextsRepresentCollectionsIncludingUnsharedOnesRatherThanIndividualShareLinks()
    {
        var collection = new HostedCollection { Id = "one", Title = "发布资料", OwnerUserId = "owner-user", SiteIds = new() { "site-a", "site-b" }, MainSiteId = "site-b" };
        var unshared = new HostedCollection { Id = "two", Title = "未分享合集", OwnerUserId = "owner-user", SiteIds = new() { "site-a" } };
        var shared = new WebPageShareLink { Id = "original", CollectionId = "one", CollectionShareGeneration = 1, Token = "original-token", Title = "发布资料", SiteIds = new() { "site-a", "site-b" }, Password = "never-return-password", CreatedAt = DateTime.UtcNow.AddYears(-1) };
        var revoked = new WebPageShareLink { Id = "second", CollectionId = "one", Token = "revoked", SiteIds = new() { "site-a" }, IsRevoked = true };
        var legacy = new WebPageShareLink { Id = "legacy", Title = "历史合集", Token = "legacy-token", SiteIds = new() { "site-a", "site-b" } };
        BsonDocument? collectionFilter = null; BsonDocument? shareFilter = null;
        var collections = new Mock<IMongoCollection<HostedCollection>>(MockBehavior.Strict);
        collections.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<HostedCollection>>(), It.IsAny<FindOptions<HostedCollection, HostedCollection>>(), It.IsAny<CancellationToken>()))
            .Callback<FilterDefinition<HostedCollection>, FindOptions<HostedCollection, HostedCollection>, CancellationToken>((filter, _, _) => collectionFilter = filter.Render(new RenderArgs<HostedCollection>(BsonSerializer.LookupSerializer<HostedCollection>(), BsonSerializer.SerializerRegistry)))
            .Returns(() => Task.FromResult(Cursor(collection, unshared)));
        var shares = new Mock<IMongoCollection<WebPageShareLink>>(MockBehavior.Strict);
        shares.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<WebPageShareLink>>(), It.IsAny<FindOptions<WebPageShareLink, WebPageShareLink>>(), It.IsAny<CancellationToken>()))
            .Callback<FilterDefinition<WebPageShareLink>, FindOptions<WebPageShareLink, WebPageShareLink>, CancellationToken>((filter, _, _) => shareFilter = filter.Render(new RenderArgs<WebPageShareLink>(BsonSerializer.LookupSerializer<WebPageShareLink>(), BsonSerializer.SerializerRegistry)))
            .Returns(() => Task.FromResult(Cursor(shared, revoked, legacy)));
        var controller = ContextController(collections.Object, shares.Object);
        var data = Result(await controller.CollectionContexts("site-a"));
        Assert.Equal(3, data.GetProperty("totalContexts").GetInt32());
        var items = data.GetProperty("items").EnumerateArray().ToArray();
        var named = items.Single(x => x.GetProperty("id").GetString() == "collection:one");
        Assert.Equal(2, named.GetProperty("shareCount").GetInt32());
        Assert.Equal("/s/wp/original-token", named.GetProperty("primaryLink").GetProperty("shareUrl").GetString());
        Assert.True(named.GetProperty("primaryLink").GetProperty("isActive").GetBoolean());
        Assert.Equal(0, items.Single(x => x.GetProperty("id").GetString() == "collection:two").GetProperty("shareCount").GetInt32());
        Assert.Contains(items, x => x.GetProperty("id").GetString() == "legacy:legacy");
        Assert.DoesNotContain("never-return-password", data.GetRawText());
        Assert.Contains("OwnerUserId", collectionFilter!.ToJson()); Assert.Contains("site-a", collectionFilter.ToJson());
        Assert.Contains("CreatedBy", shareFilter!.ToJson()); Assert.Contains("owner-user", shareFilter.ToJson()); Assert.Contains("site-a", shareFilter.ToJson());
        var searched = Result(await controller.CollectionContexts("site-a", keyword: "original-token"));
        Assert.Equal(1, searched.GetProperty("total").GetInt32()); Assert.Equal(3, searched.GetProperty("totalContexts").GetInt32());
        Assert.Equal("collection:one", searched.GetProperty("items")[0].GetProperty("id").GetString());
        Assert.IsType<BadRequestObjectResult>(await controller.CollectionContexts("site-a", keyword: new string('x', 101)));
    }

    [Fact]
    public async Task ContextPaginationAndSearchIncludeAllMatchingCollectionsWithoutRecentHistoryCutoff()
    {
        var collections = new Mock<IMongoCollection<HostedCollection>>(MockBehavior.Strict);
        collections.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<HostedCollection>>(), It.IsAny<FindOptions<HostedCollection, HostedCollection>>(), It.IsAny<CancellationToken>()))
            .Returns(() => Task.FromResult(Cursor(Array.Empty<HostedCollection>())));
        var history = Enumerable.Range(0, 45).Select(i => new WebPageShareLink { Id = $"legacy-{i:D2}", Token = $"token-{i:D2}", Title = $"历史合集 {i:D2}", SiteIds = new() { "site-a" }, CreatedAt = DateTime.UtcNow.AddYears(-2).AddMinutes(-i) }).ToArray();
        var shares = new Mock<IMongoCollection<WebPageShareLink>>(MockBehavior.Strict);
        shares.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<WebPageShareLink>>(), It.IsAny<FindOptions<WebPageShareLink, WebPageShareLink>>(), It.IsAny<CancellationToken>()))
            .Returns(() => Task.FromResult(Cursor(history)));
        var controller = ContextController(collections.Object, shares.Object);
        var second = Result(await controller.CollectionContexts("site-a", 2));
        Assert.Equal(45, second.GetProperty("total").GetInt32()); Assert.Equal(20, second.GetProperty("items").GetArrayLength());
        Assert.Equal("legacy:legacy-20", second.GetProperty("items")[0].GetProperty("id").GetString());
        var last = Result(await controller.CollectionContexts("site-a", keyword: "token-44"));
        Assert.Equal(1, last.GetProperty("total").GetInt32()); Assert.Equal("legacy:legacy-44", last.GetProperty("items")[0].GetProperty("id").GetString());
    }

    [Fact]
    public async Task ContextsKeepBothCollectionStoresAndOriginalShareRoutesIncludingUnsharedRecords()
    {
        var old = new HostedCollection { Id = "same-id", Title = "原合集", OwnerUserId = "owner-user", SiteIds = new() { "site-a" } };
        var current = new HostedDocumentCollection { Id = "same-id", Name = "带章节合集", OwnerUserId = "owner-user", SiteIds = new() { "site-a" }, ShareGeneration = 3 };
        var unshared = new HostedDocumentCollection { Id = "unshared", Name = "尚未分享", OwnerUserId = "owner-user", SiteIds = new() { "site-a" } };
        var collections = new Mock<IMongoCollection<HostedCollection>>(MockBehavior.Strict);
        collections.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<HostedCollection>>(), It.IsAny<FindOptions<HostedCollection, HostedCollection>>(), It.IsAny<CancellationToken>()))
            .Returns(() => Task.FromResult(Cursor(old)));
        var shares = new Mock<IMongoCollection<WebPageShareLink>>(MockBehavior.Strict);
        shares.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<WebPageShareLink>>(), It.IsAny<FindOptions<WebPageShareLink, WebPageShareLink>>(), It.IsAny<CancellationToken>()))
            .Returns(() => Task.FromResult(Cursor(
                new WebPageShareLink { Id = "old-link", Token = "old-token", CollectionId = old.Id, CollectionShareGeneration = 1, SiteIds = new() { "site-a" } },
                new WebPageShareLink { Id = "new-link", Token = "new-token", CollectionSnapshot = new() { CollectionId = current.Id, ShareGeneration = 3 }, SiteIds = new() { "site-a" } })));
        var data = Result(await ContextController(collections.Object, shares.Object, current, unshared).CollectionContexts("site-a"));
        Assert.Equal(3, data.GetProperty("totalContexts").GetInt32());
        var items = data.GetProperty("items").EnumerateArray().ToArray();
        Assert.Equal("/s/wp/old-token", items.Single(x => x.GetProperty("id").GetString() == "collection:same-id").GetProperty("primaryLink").GetProperty("shareUrl").GetString());
        var modern = items.Single(x => x.GetProperty("id").GetString() == "document-collection:same-id");
        Assert.Equal("/s/collection/new-token", modern.GetProperty("primaryLink").GetProperty("shareUrl").GetString());
        Assert.True(modern.GetProperty("primaryLink").GetProperty("isActive").GetBoolean());
        Assert.Equal(0, items.Single(x => x.GetProperty("id").GetString() == "document-collection:unshared").GetProperty("shareCount").GetInt32());
    }

    [Fact]
    public void BothCollectionApiContractsKeepDistinctRoutes()
    {
        var routes = typeof(WebPagesController).GetMethods().SelectMany(method => method.GetCustomAttributes<Microsoft.AspNetCore.Mvc.Routing.HttpMethodAttribute>()
            .Where(attribute => attribute.Template?.StartsWith("collections", StringComparison.Ordinal) == true)
            .SelectMany(attribute => attribute.HttpMethods.Select(verb => verb + " " + attribute.Template))).ToArray();
        Assert.Equal(routes.Length, routes.Distinct(StringComparer.Ordinal).Count());
        Assert.Contains("POST collections", routes);
        Assert.Contains("POST collections/compat", routes);
        Assert.Contains("POST collections/{id}/restore", routes);
        Assert.Contains("POST collections/compat/from-share/{token}", routes);
    }

    private static JsonElement Result(IActionResult response) => JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(response).Value,
        new JsonSerializerOptions(JsonSerializerDefaults.Web)).GetProperty("data");

    private static WebPagesController ContextController(IMongoCollection<HostedCollection> collections, IMongoCollection<WebPageShareLink> shares, params HostedDocumentCollection[] documentCollections)
    {
        var db = new Mock<IMongoDatabase>(MockBehavior.Strict);
        db.Setup(x => x.GetCollection<HostedCollection>("hosted_collections", null)).Returns(collections);
        var documents = new Mock<IMongoCollection<HostedDocumentCollection>>(MockBehavior.Strict);
        documents.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<HostedDocumentCollection>>(), It.IsAny<FindOptions<HostedDocumentCollection, HostedDocumentCollection>>(), It.IsAny<CancellationToken>()))
            .Returns(() => Task.FromResult(Cursor(documentCollections)));
        db.Setup(x => x.GetCollection<HostedDocumentCollection>("hosted_document_collections", null)).Returns(documents.Object);
        db.Setup(x => x.GetCollection<WebPageShareLink>("web_page_share_links", null)).Returns(shares);
        var context = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(context, db.Object);
        var service = new Mock<IHostedSiteService>(MockBehavior.Strict);
        service.Setup(x => x.GetByIdAsync("site-a", "owner-user", CancellationToken.None)).ReturnsAsync(new HostedSite { Id = "site-a" });
        return Build(service.Object, context);
    }

    private static IAsyncCursor<T> Cursor<T>(params T[] rows)
    {
        var cursor = new Mock<IAsyncCursor<T>>(); cursor.SetupGet(x => x.Current).Returns(rows);
        cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true).ReturnsAsync(false);
        return cursor.Object;
    }

    private static WebPagesController Build(IHostedSiteService sites, MongoDbContext context)
    {
        var controller = new WebPagesController(sites, Mock.Of<IHostedSiteOptimizationService>(), Mock.Of<IUploadProgressService>(), context, Mock.Of<ITeamService>(), Mock.Of<IHttpClientFactory>());
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", "owner-user") }, "test")) } };
        return controller;
    }
}
