using System.Reflection;
using System.Runtime.CompilerServices;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class HostedCollectionShareAccessTests
{
    [Theory]
    [InlineData(false, 2)]
    [InlineData(true, 1)]
    public async Task ClosedCollectionRejectsViewMemberContentAndSaveEvenIfLinkRevocationHasNotFinished(bool dissolved, long generation)
    {
        var share = new WebPageShareLink { Token = "original-token", CollectionId = "collection", CollectionShareGeneration = 1,
            SiteIds = new() { "member" }, Visibility = "public", Purpose = "share", IsRevoked = false };
        var collection = new HostedCollection { Id = "collection", ShareGeneration = generation, IsDissolved = dissolved };
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<WebPageShareLink>("web_page_share_links", null)).Returns(Rows(share));
        database.Setup(x => x.GetCollection<HostedCollection>("hosted_collections", null)).Returns(Rows(collection));
        var context = (MongoDbContext)RuntimeHelpers.GetUninitializedObject(typeof(MongoDbContext));
        typeof(MongoDbContext).GetField("_database", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(context, database.Object);
        // Rejection must happen before touching teams, content storage, counters or saved-site writes.
        var service = (HostedSiteService)RuntimeHelpers.GetUninitializedObject(typeof(HostedSiteService));
        typeof(HostedSiteService).GetField("_db", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(service, context);

        var view = await service.ViewShareAsync("original-token", null);
        Assert.Equal(404, view!.HttpStatus);
        Assert.Contains("已停止", view.Error);
        var content = await service.ResolveShareSiteAsync("original-token", "member", null, null);
        Assert.Equal(404, content.HttpStatus);
        Assert.Null(content.Site);
        var save = await service.SaveSharedSiteAsync("original-token", null, "visitor", CancellationToken.None);
        Assert.Equal(404, save.HttpStatus);
        Assert.Contains("已停止", save.Error);
    }

    private static IMongoCollection<T> Rows<T>(T item)
    {
        var collection = new Mock<IMongoCollection<T>>(MockBehavior.Strict);
        collection.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<T>>(), It.IsAny<FindOptions<T, T>>(), It.IsAny<CancellationToken>()))
            .Returns(() =>
            {
                var cursor = new Mock<IAsyncCursor<T>>();
                cursor.SetupGet(x => x.Current).Returns(new[] { item });
                cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true).ReturnsAsync(false);
                return Task.FromResult(cursor.Object);
            });
        return collection.Object;
    }
}
