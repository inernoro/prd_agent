using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class HostedSiteEditsControllerTests
{
    [Fact]
    [Trait("Category", TestCategories.Integration)]
    public async Task GetRun_ShouldRequireMatchingOwnerAndSite()
    {
        await using var fixture = await HostedSiteEditMongoFixture.CreateAsync();
        var run = new DesignArtifactRun
        {
            UserId = "owner-user",
            TargetSiteId = "site-a",
            Operation = DesignArtifactOperations.Edit,
            Status = RunStatuses.Running,
            Progress = 42,
            Phase = "正在生成修改草稿",
        };
        await fixture.Db.DesignArtifactRuns.InsertOneAsync(run);

        var ownerResult = await BuildController(fixture.Db, "owner-user").GetRun("site-a", run.Id);
        var ok = Assert.IsType<OkObjectResult>(ownerResult);
        var payload = JsonSerializer.SerializeToElement(ok.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal(run.Id, payload.GetProperty("data").GetProperty("runId").GetString());
        Assert.Equal(42, payload.GetProperty("data").GetProperty("progress").GetInt32());

        var wrongSite = await BuildController(fixture.Db, "owner-user").GetRun("site-b", run.Id);
        Assert.IsType<NotFoundObjectResult>(wrongSite);

        var wrongUser = await BuildController(fixture.Db, "other-user").GetRun("site-a", run.Id);
        Assert.IsType<NotFoundObjectResult>(wrongUser);
    }

    private static HostedSiteEditsController BuildController(MongoDbContext db, string userId)
    {
        var controller = new HostedSiteEditsController(
            Mock.Of<IHostedSiteService>(),
            Mock.Of<IHostedSiteRevisionService>(),
            Mock.Of<IRunEventStore>(),
            Mock.Of<IRunQueue>(),
            db,
            NullLogger<HostedSiteEditsController>.Instance,
            Mock.Of<IDesignArtifactProviderCatalog>());
        controller.ControllerContext = new ControllerContext
        {
            HttpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim("sub", userId) }, "test")),
            },
        };
        return controller;
    }

    private sealed class HostedSiteEditMongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private HostedSiteEditMongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
        }

        internal MongoDbContext Db { get; }

        internal static async Task<HostedSiteEditMongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new HostedSiteEditMongoFixture(
                client,
                connectionString,
                $"hosted_site_edit_test_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
