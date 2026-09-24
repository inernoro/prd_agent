using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Infrastructure.Database;

namespace PrdAgent.Api.Tests.Services;

/// <summary>
/// 一次性 Mongo 库，测完即 drop。每个测试类各自私有拷贝过三份，三份逐字相同、
/// 只有库名前缀不一样——收敛成一处（predicate-and-wiring-discipline 形状 3）。
/// </summary>
internal sealed class RunMongoFixture : IAsyncDisposable
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

    internal static async Task<RunMongoFixture> CreateAsync(string prefix = "api_tests")
    {
        var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                               ?? "mongodb://127.0.0.1:27017";
        var settings = MongoClientSettings.FromConnectionString(connectionString);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
        var client = new MongoClient(settings);
        await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));
        return new RunMongoFixture(client, connectionString, $"{prefix}_{Guid.NewGuid():N}");
    }

    public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
}
