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
