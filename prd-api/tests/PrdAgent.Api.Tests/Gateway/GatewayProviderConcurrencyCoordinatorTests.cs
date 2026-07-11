using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class GatewayProviderConcurrencyCoordinatorTests
{
    [Fact]
    public async Task TwoServingInstances_CannotExceedSharedPlatformSlot()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        var coordinators = Enumerable.Range(0, 8)
            .Select(_ => new GatewayProviderConcurrencyCoordinator(
                scope.Context,
                NullLogger<GatewayProviderConcurrencyCoordinator>.Instance))
            .ToArray();
        var resolution = Resolution("platform-a", "model-a", platformLimit: 1, modelLimit: 5);

        var admissions = await Task.WhenAll(coordinators.Select(x =>
            x.AcquireAsync("tenant-a", resolution, timeoutSeconds: 30, CancellationToken.None)));

        admissions.Count(x => x.Allowed).ShouldBe(1);
        admissions.Count(x => !x.Allowed && x.ErrorCode == "PROVIDER_CONCURRENCY_EXHAUSTED").ShouldBe(7);

        var winner = admissions.Single(x => x.Allowed).Lease;
        winner.ShouldNotBeNull();
        await winner.DisposeAsync();

        var afterRelease = await coordinators[1].AcquireAsync("tenant-a", resolution, 30, CancellationToken.None);
        afterRelease.Allowed.ShouldBeTrue();
        if (afterRelease.Lease is not null) await afterRelease.Lease.DisposeAsync();
    }

    [Fact]
    public async Task TwoModels_SharePlatformLimit_ButUseIndependentModelSlots()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;

        var first = new GatewayProviderConcurrencyCoordinator(
            scope.Context,
            NullLogger<GatewayProviderConcurrencyCoordinator>.Instance);
        var second = new GatewayProviderConcurrencyCoordinator(
            scope.Context,
            NullLogger<GatewayProviderConcurrencyCoordinator>.Instance);

        var modelA = await first.AcquireAsync("tenant-a", Resolution("platform-a", "model-a", 1, 1), 30, CancellationToken.None);
        var modelB = await second.AcquireAsync("tenant-a", Resolution("platform-a", "model-b", 1, 1), 30, CancellationToken.None);

        modelA.Allowed.ShouldBeTrue();
        modelB.Allowed.ShouldBeFalse();
        if (modelA.Lease is not null) await modelA.Lease.DisposeAsync();
    }

    [Fact]
    public async Task SameProviderLimits_AreIndependentAcrossTenants()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var first = new GatewayProviderConcurrencyCoordinator(scope.Context, NullLogger<GatewayProviderConcurrencyCoordinator>.Instance);
        var second = new GatewayProviderConcurrencyCoordinator(scope.Context, NullLogger<GatewayProviderConcurrencyCoordinator>.Instance);
        var resolution = Resolution("shared-platform", "shared-model", 1, 1);

        var tenantA = await first.AcquireAsync("tenant-a", resolution, 30, CancellationToken.None);
        var tenantB = await second.AcquireAsync("tenant-b", resolution, 30, CancellationToken.None);

        tenantA.Allowed.ShouldBeTrue();
        tenantB.Allowed.ShouldBeTrue();
        if (tenantA.Lease is not null) await tenantA.Lease.DisposeAsync();
        if (tenantB.Lease is not null) await tenantB.Lease.DisposeAsync();
    }

    private static ModelResolutionResult Resolution(string platform, string model, int platformLimit, int modelLimit)
        => new()
        {
            Success = true,
            ActualPlatformId = platform,
            ActualModel = model,
            PlatformMaxConcurrency = platformLimit,
            ModelMaxConcurrency = modelLimit,
        };

    private static async Task<TestDatabase?> TryCreateDatabaseAsync()
    {
        var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                               ?? "mongodb://localhost:27017";
        var settings = MongoClientSettings.FromConnectionString(connectionString);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(2);
        var client = new MongoClient(settings);
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(
                new BsonDocument("ping", 1),
                cancellationToken: cts.Token);
            var databaseName = $"llmgw_concurrency_test_{Guid.NewGuid():N}";
            return new TestDatabase(client, databaseName, new LlmGatewayDataContext(connectionString, databaseName));
        }
        catch
        {
            return null;
        }
    }

    private sealed class TestDatabase : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        public TestDatabase(MongoClient client, string databaseName, LlmGatewayDataContext context)
        {
            _client = client;
            _databaseName = databaseName;
            Context = context;
        }

        public LlmGatewayDataContext Context { get; }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
