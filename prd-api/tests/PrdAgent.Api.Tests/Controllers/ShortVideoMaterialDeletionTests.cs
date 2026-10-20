using System.Security.Claims;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class ShortVideoMaterialDeletionTests
{
    [Fact]
    public async Task DeleteRun_WhenWorkerIsRunning_ShouldReturnConflictAndKeepTheRun()
    {
        await using var test = await ShortVideoDeletionDatabase.CreateAsync();
        var run = test.NewRun(ShortVideoMaterialRunStatus.Running);
        await test.Context.ShortVideoMaterialRuns.InsertOneAsync(run);

        var result = await test.CreateController().DeleteRun(run.Id);

        var conflict = Assert.IsType<ConflictObjectResult>(result);
        Assert.Equal(StatusCodes.Status409Conflict, conflict.StatusCode);
        Assert.Equal(1, await test.Context.ShortVideoMaterialRuns.CountDocumentsAsync(x => x.Id == run.Id));
    }

    [Theory]
    [InlineData(ShortVideoMaterialRunStatus.Queued)]
    [InlineData(ShortVideoMaterialRunStatus.Done)]
    [InlineData(ShortVideoMaterialRunStatus.Failed)]
    [InlineData(ShortVideoMaterialRunStatus.Cancelled)]
    public async Task DeleteRun_WhenNoWorkerOwnsTheRun_ShouldDeleteAtomically(string status)
    {
        await using var test = await ShortVideoDeletionDatabase.CreateAsync();
        var run = test.NewRun(status);
        await test.Context.ShortVideoMaterialRuns.InsertOneAsync(run);

        var result = await test.CreateController().DeleteRun(run.Id);

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal(0, await test.Context.ShortVideoMaterialRuns.CountDocumentsAsync(x => x.Id == run.Id));
    }

    [Fact]
    public async Task DeleteRun_WhenRecoveredStatusStillHasWorkerToken_ShouldReturnConflict()
    {
        await using var test = await ShortVideoDeletionDatabase.CreateAsync();
        var run = test.NewRun(ShortVideoMaterialRunStatus.Failed);
        run.ProcessingToken = "worker-still-active";
        await test.Context.ShortVideoMaterialRuns.InsertOneAsync(run);

        var result = await test.CreateController().DeleteRun(run.Id);

        Assert.IsType<ConflictObjectResult>(result);
        Assert.Equal(1, await test.Context.ShortVideoMaterialRuns.CountDocumentsAsync(x => x.Id == run.Id));
    }

    [Fact]
    public async Task CancelRun_WhenRunning_ShouldRequestCancellationWithoutDroppingLease()
    {
        await using var test = await ShortVideoDeletionDatabase.CreateAsync();
        var run = test.NewRun(ShortVideoMaterialRunStatus.Running);
        run.ProcessingToken = "active-worker";
        await test.Context.ShortVideoMaterialRuns.InsertOneAsync(run);

        var result = await test.CreateController().CancelRun(run.Id);

        Assert.IsType<AcceptedResult>(result);
        var persisted = await test.Context.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.True(persisted.CancelRequested);
        Assert.Equal(ShortVideoMaterialRunStatus.Running, persisted.Status);
        Assert.Equal("active-worker", persisted.ProcessingToken);
    }

    [Fact]
    public async Task CancelRun_WhenQueued_ShouldBecomeCancelledImmediately()
    {
        await using var test = await ShortVideoDeletionDatabase.CreateAsync();
        var run = test.NewRun(ShortVideoMaterialRunStatus.Queued);
        await test.Context.ShortVideoMaterialRuns.InsertOneAsync(run);

        var result = await test.CreateController().CancelRun(run.Id);

        Assert.IsType<OkObjectResult>(result);
        var persisted = await test.Context.ShortVideoMaterialRuns.Find(x => x.Id == run.Id).SingleAsync();
        Assert.True(persisted.CancelRequested);
        Assert.Equal(ShortVideoMaterialRunStatus.Cancelled, persisted.Status);
        Assert.Null(persisted.ProcessingToken);
    }

    private sealed class ShortVideoDeletionDatabase : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        private ShortVideoDeletionDatabase(MongoDbContext context, MongoClient client, string databaseName)
        {
            Context = context;
            _client = client;
            _databaseName = databaseName;
            UserId = $"short-video-delete-{Guid.NewGuid():N}";
        }

        public MongoDbContext Context { get; }
        public string UserId { get; }

        public static async Task<ShortVideoDeletionDatabase> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
            var databaseName = $"short_video_delete_{Guid.NewGuid():N}";
            return new ShortVideoDeletionDatabase(
                new MongoDbContext(connectionString, databaseName),
                client,
                databaseName);
        }

        public ShortVideoMaterialRun NewRun(string status) => new()
        {
            UserId = UserId,
            VideoUrl = "https://example.invalid/video",
            Title = "删除并发测试",
            Status = status,
        };

        public ShortVideoMaterialController CreateController()
        {
            var controller = new ShortVideoMaterialController(
                Context,
                Mock.Of<IDocumentService>(),
                new ConfigurationBuilder().Build(),
                Mock.Of<IServiceProvider>(),
                NullLogger<ShortVideoMaterialController>.Instance)
            {
                ControllerContext = new ControllerContext
                {
                    HttpContext = new DefaultHttpContext
                    {
                        User = new ClaimsPrincipal(
                            new ClaimsIdentity([new Claim("sub", UserId)], "test")),
                    },
                },
            };
            return controller;
        }

        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_databaseName);
        }
    }
}
