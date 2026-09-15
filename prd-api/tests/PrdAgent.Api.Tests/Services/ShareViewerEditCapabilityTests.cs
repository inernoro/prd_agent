using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 分享页「站点编辑坞」的门，由服务端用编辑端点那同一道角色门算出来（Codex P2，2026-09-15）。
///
/// 此前前端拿 `createdBy === currentUserId` 当判据——那是「谁建了这条分享链接」。
/// 后端明确允许团队编辑者创建分享，两者一错位就同时出两种错：真正的站点主人进不去编辑坞，
/// 只建过链接、却对站点没有编辑权的人反而看得见入口。
/// </summary>
public sealed class ShareViewerEditCapabilityTests
{
    private static HostedSiteService CreateService(
        MongoDbContext db, Dictionary<string, string>? webHostingRoles = null)
    {
        var teams = new Mock<ITeamService>();
        teams.Setup(x => x.GetMyTeamIdsAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((webHostingRoles ?? new Dictionary<string, string>()).Keys.ToList());
        teams.Setup(x => x.GetMyWebHostingTeamRolesAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(webHostingRoles ?? new Dictionary<string, string>());
        return new HostedSiteService(
            db,
            Mock.Of<IAssetStorage>(),
            Mock.Of<IShortLinkService>(),
            Mock.Of<ISharePasswordService>(),
            teams.Object,
            Mock.Of<ITeamActivityService>(),
            Mock.Of<IUploadProgressService>(),
            Mock.Of<IAskOpeningQuestionGenerator>(),
            NullLogger<HostedSiteService>.Instance);
    }

    private static HostedSite TeamSite() => new()
    {
        Id = "site-1",
        OwnerUserId = "site-owner",
        Title = "团队里的网页",
        SharedTeamIds = ["team-1"],
    };

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task SiteOwnerCanEdit_EvenWhenSomeoneElseCreatedTheShare()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var service = CreateService(fixture.Db);
        Assert.True(await service.CanEditSiteAsync(TeamSite(), "site-owner", CancellationToken.None));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task TeamEditorCanEdit_AndTeamViewerCannot()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();

        var editor = CreateService(fixture.Db, new Dictionary<string, string> { ["team-1"] = "editor" });
        Assert.True(await editor.CanEditSiteAsync(TeamSite(), "teammate", CancellationToken.None));

        var viewer = CreateService(fixture.Db, new Dictionary<string, string> { ["team-1"] = "viewer" });
        Assert.False(
            await viewer.CanEditSiteAsync(TeamSite(), "teammate", CancellationToken.None));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task OutsiderAndAnonymousCannotEdit()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();
        var service = CreateService(fixture.Db);

        // 只建过分享链接、对站点没有任何角色的人：这正是旧判据会放进来的那一类。
        Assert.False(await service.CanEditSiteAsync(TeamSite(), "share-creator", CancellationToken.None));
        Assert.False(await service.CanEditSiteAsync(TeamSite(), string.Empty, CancellationToken.None));
    }

    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task PublishIntoTeamRequiresOwnerOrEditorRole()
    {
        await using var fixture = await RunMongoFixture.CreateAsync();

        var editor = CreateService(fixture.Db, new Dictionary<string, string> { ["team-1"] = "editor" });
        Assert.True(await editor.CanPublishIntoTeamAsync("teammate", "team-1", CancellationToken.None));

        var viewer = CreateService(fixture.Db, new Dictionary<string, string> { ["team-1"] = "viewer" });
        Assert.False(await viewer.CanPublishIntoTeamAsync("teammate", "team-1", CancellationToken.None));

        var stranger = CreateService(fixture.Db);
        Assert.False(await stranger.CanPublishIntoTeamAsync("nobody", "team-1", CancellationToken.None));
    }

    private sealed class RunMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private RunMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<RunMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new RunMongoFixture(client, connectionString, $"share_edit_capability_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
