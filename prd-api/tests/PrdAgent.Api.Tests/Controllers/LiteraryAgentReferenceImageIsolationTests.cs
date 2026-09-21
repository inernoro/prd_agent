using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.IdentityModel.JsonWebTokens;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class LiteraryAgentReferenceImageIsolationTests
{
    [Fact]
    public async Task ActivateAndReadActive_ShouldOnlyAffectCurrentUser()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var userAFirst = BuildConfig("a-first", "user-a", isActive: true);
        var userASecond = BuildConfig("a-second", "user-a", isActive: false);
        var userB = BuildConfig("b-active", "user-b", isActive: true);
        await fixture.Db.ReferenceImageConfigs.InsertManyAsync([userAFirst, userASecond, userB]);

        var controllerA = BuildController(fixture.Db, "user-a");
        (await controllerA.ActivateReferenceImage(userASecond.Id, CancellationToken.None))
            .ShouldBeOfType<OkObjectResult>();

        var after = await fixture.Db.ReferenceImageConfigs.Find(_ => true).ToListAsync();
        after.Single(item => item.Id == userAFirst.Id).IsActive.ShouldBeFalse();
        after.Single(item => item.Id == userASecond.Id).IsActive.ShouldBeTrue();
        after.Single(item => item.Id == userB.Id).IsActive.ShouldBeTrue(
            "用户 A 切换参考图时不能取消用户 B 的激活项");

        ReadActiveConfig(await controllerA.GetActiveReferenceImage(CancellationToken.None))
            .Id.ShouldBe(userASecond.Id);
        (await controllerA.DeactivateReferenceImage(userB.Id, CancellationToken.None))
            .ShouldBeOfType<NotFoundObjectResult>();

        var controllerB = BuildController(fixture.Db, "user-b");
        ReadActiveConfig(await controllerB.GetActiveReferenceImage(CancellationToken.None))
            .Id.ShouldBe(userB.Id);
        (await fixture.Db.ReferenceImageConfigs.Find(item => item.Id == userB.Id).SingleAsync())
            .IsActive.ShouldBeTrue();
    }

    [Fact]
    public async Task MarketplaceFork_ShouldRemainPublicAndCreateInactivePrivateCopy()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        await fixture.Db.Users.InsertManyAsync([
            BuildUser("user-a", "reader-a"),
            BuildUser("user-b", "author-b"),
        ]);
        var source = BuildConfig("public-source", "user-b", isActive: true);
        source.IsPublic = true;
        source.ForkCount = 3;
        await fixture.Db.ReferenceImageConfigs.InsertOneAsync(source);

        var controllerA = BuildController(fixture.Db, "user-a");
        (await controllerA.ListReferenceImagesMarketplace(null, "hot", CancellationToken.None))
            .ShouldBeOfType<OkObjectResult>();
        (await controllerA.ForkReferenceImage(
            source.Id,
            new LiteraryAgentConfigController.ForkReferenceImageRequest { Name = "用户 A 的副本" },
            CancellationToken.None)).ShouldBeOfType<OkObjectResult>();

        var forked = await fixture.Db.ReferenceImageConfigs
            .Find(item => item.ForkedFromId == source.Id && item.CreatedByAdminId == "user-a")
            .SingleAsync();
        forked.Name.ShouldBe("用户 A 的副本");
        forked.IsActive.ShouldBeFalse();
        forked.IsPublic.ShouldBeFalse();
        (await fixture.Db.ReferenceImageConfigs.Find(item => item.Id == source.Id).SingleAsync())
            .ForkCount.ShouldBe(4);
    }

    private static LiteraryAgentConfigController BuildController(MongoDbContext db, string userId)
    {
        var controller = new LiteraryAgentConfigController(
            db,
            Mock.Of<IModelPoolQueryService>(),
            Mock.Of<IAssetStorage>(),
            NullLogger<LiteraryAgentConfigController>.Instance);
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    [new Claim(JwtRegisteredClaimNames.Sub, userId)],
                    "test")),
            },
        };
        return controller;
    }

    private static ReferenceImageConfig ReadActiveConfig(IActionResult result)
    {
        var response = result.ShouldBeOfType<OkObjectResult>()
            .Value.ShouldBeOfType<ApiResponse<object>>();
        var data = response.Data.ShouldNotBeNull();
        return data.GetType().GetProperty("config").ShouldNotBeNull()
            .GetValue(data).ShouldBeOfType<ReferenceImageConfig>();
    }

    private static ReferenceImageConfig BuildConfig(string id, string ownerId, bool isActive) => new()
    {
        Id = id,
        Name = id,
        Prompt = "保持原有风格",
        ImageSha256 = new string('a', 64),
        ImageUrl = $"https://example.test/{id}.png",
        IsActive = isActive,
        AppKey = "literary-agent",
        CreatedByAdminId = ownerId,
        CreatedAt = DateTime.UtcNow,
        UpdatedAt = DateTime.UtcNow,
    };

    private static User BuildUser(string userId, string username) => new()
    {
        UserId = userId,
        Username = username,
        PasswordHash = "test-only",
        CreatedAt = DateTime.UtcNow,
    };

    private sealed class MongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private MongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<MongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new MongoFixture(client, connectionString, $"literary_reference_isolation_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
