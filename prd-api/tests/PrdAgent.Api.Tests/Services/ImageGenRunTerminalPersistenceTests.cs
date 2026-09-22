using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class ImageGenRunTerminalPersistenceTests
{
    [Fact]
    public async Task RejectedItemPersistsSameReasonToRunAndRunDoneEvent()
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var run = NewRun(ImageGenRunStatus.Running, failed: 1);
        await fixture.Db.ImageGenRuns.InsertOneAsync(run);
        await fixture.Db.ImageGenRunItems.InsertOneAsync(new ImageGenRunItem
        {
            Id = $"{run.Id}:0:0",
            RunId = run.Id,
            OwnerAdminId = run.OwnerAdminId,
            Status = ImageGenRunItemStatus.Error,
            ErrorCode = ErrorCodes.IMAGE_GEN_REQUEST_REJECTED,
            ErrorMessage = "模型没有根据这次描述和参考图生成图片，请调整需求，或更换你有权使用的参考图后重试。",
        });

        await fixture.Worker.PersistTerminalStateAsync(run, run, ImageGenRunStatus.Failed, CancellationToken.None);

        var persisted = await fixture.Db.ImageGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal(ImageGenRunStatus.Failed, persisted.Status);
        Assert.Equal(ErrorCodes.IMAGE_GEN_REQUEST_REJECTED, persisted.ErrorCode);
        Assert.Contains("调整需求", persisted.ErrorMessage);
        Assert.DoesNotContain("IMAGE_RECITATION", persisted.ErrorMessage, StringComparison.OrdinalIgnoreCase);

        var events = await fixture.RunStore.GetEventsAsync(RunKinds.ImageGen, run.Id, 0, 10);
        var runDone = Assert.Single(events);
        using var payload = JsonDocument.Parse(runDone.PayloadJson);
        Assert.Equal("runDone", payload.RootElement.GetProperty("type").GetString());
        Assert.Equal("Failed", payload.RootElement.GetProperty("status").GetString());
        Assert.Equal(ErrorCodes.IMAGE_GEN_REQUEST_REJECTED, payload.RootElement.GetProperty("errorCode").GetString());
        Assert.Contains("调整需求", payload.RootElement.GetProperty("errorMessage").GetString());
    }

    [Theory]
    [InlineData(ImageGenRunStatus.Completed)]
    [InlineData(ImageGenRunStatus.Cancelled)]
    public async Task NonFailedTerminalStateClearsStaleReasonFromRunAndEvent(ImageGenRunStatus status)
    {
        await using var fixture = await MongoFixture.CreateAsync();
        var run = NewRun(ImageGenRunStatus.Running, failed: 0);
        run.ErrorCode = ErrorCodes.IMAGE_GEN_REQUEST_REJECTED;
        run.ErrorMessage = "旧错误";
        await fixture.Db.ImageGenRuns.InsertOneAsync(run);

        await fixture.Worker.PersistTerminalStateAsync(run, run, status, CancellationToken.None);

        var persisted = await fixture.Db.ImageGenRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.Equal(status, persisted.Status);
        Assert.Null(persisted.ErrorCode);
        Assert.Null(persisted.ErrorMessage);

        var events = await fixture.RunStore.GetEventsAsync(RunKinds.ImageGen, run.Id, 0, 10);
        using var payload = JsonDocument.Parse(Assert.Single(events).PayloadJson);
        Assert.Equal(JsonValueKind.Null, payload.RootElement.GetProperty("errorCode").ValueKind);
        Assert.Equal(JsonValueKind.Null, payload.RootElement.GetProperty("errorMessage").ValueKind);
    }

    private static ImageGenRun NewRun(ImageGenRunStatus status, int failed) => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        OwnerAdminId = "terminal-persistence-test",
        Status = status,
        Total = 1,
        Done = failed == 0 ? 1 : 0,
        Failed = failed,
        AppKey = "literary-agent",
    };

    private sealed class MongoFixture : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly ServiceProvider _services;
        private readonly string _databaseName;

        private MongoFixture(MongoClient client, string connectionString, string databaseName)
        {
            _client = client;
            _databaseName = databaseName;
            Db = new MongoDbContext(connectionString, databaseName);
            RunStore = new InMemoryRunEventStore();
            _services = new ServiceCollection().BuildServiceProvider();
            Worker = new ImageGenRunWorker(
                Db,
                _services.GetRequiredService<IServiceScopeFactory>(),
                RunStore,
                NullLogger<ImageGenRunWorker>.Instance,
                new LLMRequestContextAccessor(),
                new ConfigurationBuilder().Build());
        }

        internal MongoDbContext Db { get; }
        internal InMemoryRunEventStore RunStore { get; }
        internal ImageGenRunWorker Worker { get; }

        internal static async Task<MongoFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27017";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            return new MongoFixture(client, connectionString, $"image_run_terminal_{Guid.NewGuid():N}");
        }

        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_databaseName);
            await _services.DisposeAsync();
        }
    }
}
