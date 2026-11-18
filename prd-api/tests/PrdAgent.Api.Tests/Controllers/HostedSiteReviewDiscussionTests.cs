using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class HostedSiteReviewDiscussionTests
{
    [Fact]
    [Trait("Category", "Integration")]
    public async Task SharedReplyRetry_UsesOneRecordAndNotification_AndRechecksReadAccess()
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
        var database = "hosted_review_test_" + Guid.NewGuid().ToString("N");
        var client = new MongoClient(connection);
        try
        {
            var db = new MongoDbContext(connection, database);
            var site = new HostedSite { Id = "site", OwnerUserId = "owner", CommentsEnabled = true,
                ContentVersion = new DateTime(2026, 11, 4, 0, 0, 0, DateTimeKind.Utc) };
            var version = HostedSiteCommentRules.VersionKey(site.ContentVersion);
            var parent = new HostedSiteComment { Id = "parent", SiteId = site.Id, ContentVersion = version, AuthorUserId = "owner" };
            var share = new WebPageShareLink { Token = "reply-share", SiteId = site.Id, CreatedBy = "owner", Visibility = "public" };
            await db.HostedSites.InsertOneAsync(site);
            await db.HostedSiteComments.InsertOneAsync(parent);
            await db.WebPageShareLinks.InsertOneAsync(share);
            var teams = new Mock<ITeamService>();
            teams.Setup(x => x.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync(new List<string>());
            var service = new HostedSiteService(db, Mock.Of<IAssetStorage>(), null!, null!, teams.Object, null!, null!, null!,
                NullLogger<HostedSiteService>.Instance);
            var submission = Guid.NewGuid().ToString("D");
            Task<AddCommentResult> Send(string viewer = "reader", string content = "保留的回复") =>
                service.AddCommentByShareAsync(share.Token, null, viewer, viewer, null, content, null, parentId: parent.Id, clientId: submission);
            var results = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Send()));
            var commentId = Assert.Single(results.Select(result => Assert.IsType<HostedSiteCommentDto>(result.Comment).Id).Distinct());
            Assert.All(results, result =>
            {
                Assert.True(result.Comment!.IsMine);
                Assert.Empty(result.Comment.AuthorUserId);
            });
            Assert.Equal(1, await db.HostedSiteComments.CountDocumentsAsync(comment => comment.ParentId == parent.Id));
            Assert.Equal(1, await db.AdminNotifications.CountDocumentsAsync(notice => notice.Key == $"hosted-comment:{commentId}"));
            Assert.Equal("CLIENT_ID_REUSED", (await Send(content: "用旧标识发送另一条内容")).ErrorCode);
            Assert.NotEqual(commentId, (await Send(viewer: "second-reader")).Comment!.Id);
            await db.HostedSites.UpdateOneAsync(item => item.Id == site.Id,
                Builders<HostedSite>.Update.Set(item => item.ContentVersion, site.ContentVersion.AddDays(1)));
            Assert.Equal(404, (await Send()).HttpStatus);
            await db.WebPageShareLinks.UpdateOneAsync(item => item.Id == share.Id,
                Builders<WebPageShareLink>.Update.Set(item => item.IsRevoked, true));
            Assert.Equal(404, (await Send()).HttpStatus);
        }
        finally
        {
            await client.DropDatabaseAsync(database);
        }
    }
}
