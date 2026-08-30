using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>
/// 名录门的**行为**用例（真 Mongo、真解析器，不是扫源码）。
///
/// 为什么非要行为用例：白名单能不能拦住，线上反而验不出来——控制台的每一条写入路径
/// 现在都会盖放行标记，所以正常操作根本造不出「名录外且没有标记」的那种行。
/// 真造得出它的只有这道门要防的那件事本身：绕过控制台直接往库里写一条模型文档。
/// 这里就是把那件事做出来，然后看解析器认不认。
///
/// 三个断言互为对照，缺一条就说明不了问题：
///   名录内的  → 放行（证明门没有见谁都拦）
///   名录外无标记 → 拦下，且给的是专属错误码（证明门真的拦，且拦得能被定位）
///   同一条补上标记 → 放行（证明拦的依据是标记，不是「名字长得不对」）
/// </summary>
public sealed class ModelCatalogGateBehaviorTests
{
    private const string Caller = "catalog-gate-test.chat::chat";
    private const string PoolId = "catalog-gate-pool";
    private const string PlatformId = "catalog-gate-platform";
    /// <summary>名录内：内置名录第一条就是它，走「查名录」那一支放行。</summary>
    private const string CatalogModel = "gpt-4o";
    /// <summary>名录外：真实存在的模型，但不在我们登记的那 38 条里。</summary>
    private const string OutsideModel = "some-vendor/experimental-model-x";

    [Fact]
    public async Task 名录外且没有放行标记的模型_必须被拦下并点名错误码()
    {
        var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                               ?? "mongodb://127.0.0.1:27018";
        var settings = MongoClientSettings.FromConnectionString(connectionString);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
        var client = new MongoClient(settings);
        await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));

        var gatewayDatabaseName = $"catalog_gate_{Guid.NewGuid():N}";
        var mapDatabaseName = $"catalog_gate_map_{Guid.NewGuid():N}";
        var gatewayData = new LlmGatewayDataContext(connectionString, gatewayDatabaseName);
        var mapData = new MongoDbContext(connectionString, mapDatabaseName);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["LlmGateway:InternalTenantId"] = GatewayTenantDefaults.InternalTenantId,
                ["ApiKeyCrypto:Secret"] = "catalog-gate-test-secret-2026",
            })
            .Build();

        try
        {
            await SeedAsync(gatewayData.Database, configuration);
            var resolver = new ModelResolver(
                mapData, configuration, NullLogger<ModelResolver>.Instance, gatewayData);

            // 一、名录内的模型照常放行。没有这一条，下面的「拦下」可能只是因为整条链路本来就不通。
            var allowed = await resolver.ResolveAsync(
                Caller, ModelTypes.Chat,
                expectedModel: CatalogModel, pinnedPlatformId: PlatformId, pinnedModelId: CatalogModel);
            allowed.Success.ShouldBeTrue(allowed.ErrorMessage);
            allowed.ActualModel.ShouldBe(CatalogModel);

            // 二、名录外、库里那条没有放行标记（= 有人绕过控制台直接写进来的形态）→ 必须拦。
            var blocked = await resolver.ResolveAsync(
                Caller, ModelTypes.Chat,
                expectedModel: OutsideModel, pinnedPlatformId: PlatformId, pinnedModelId: OutsideModel);
            blocked.Success.ShouldBeFalse("名录外又没被放行过的模型不该被解析出来");
            blocked.FailureCode.ShouldBe(
                GatewayRouteFailure.ModelNotInCatalog,
                "拦下来还不够，要给专属错误码——否则管理员看到的又是一句「服务不可用」，分不清是没成员还是这个成员不该用");

            // 三、给同一条补上放行标记（= 管理员在控制台显式放行 / 名录门上线时的存量迁移）→ 放行。
            // 这一条把「拦的依据是标记」钉死：不补标记它就一直是拦着的，补了立刻能用。
            await gatewayData.Database.GetCollection<BsonDocument>("llmgw_models").UpdateOneAsync(
                Builders<BsonDocument>.Filter.And(
                    Builders<BsonDocument>.Filter.Eq("TenantId", GatewayTenantDefaults.InternalTenantId),
                    Builders<BsonDocument>.Filter.Eq("ModelName", OutsideModel),
                    // 必须带 PlatformId：库里还有一批同名的诱饵文档（见 SeedAsync），
                    // 只按名字改会改到诱饵头上，这一步就证明不了「拦的依据是标记」。
                    Builders<BsonDocument>.Filter.Eq("PlatformId", PlatformId)),
                Builders<BsonDocument>.Update.Set("AllowedOutsideCatalog", true));

            var afterAllowlisting = await resolver.ResolveAsync(
                Caller, ModelTypes.Chat,
                expectedModel: OutsideModel, pinnedPlatformId: PlatformId, pinnedModelId: OutsideModel);
            afterAllowlisting.Success.ShouldBeTrue(afterAllowlisting.ErrorMessage);
            afterAllowlisting.ActualModel.ShouldBe(OutsideModel);
        }
        finally
        {
            await client.DropDatabaseAsync(gatewayDatabaseName);
            await client.DropDatabaseAsync(mapDatabaseName);
        }
    }

    /// <summary>
    /// 兑换所来的模型：门判的是**这一条别名**有没有被放行，不是「它来自兑换所」。
    ///
    /// 认容器不认条目的写法看不出毛病——兑换所确实是管理员建的，里面的别名也确实是他列的。
    /// 但那是「进了这个门的都算放行」：往兑换所的 Models 数组里加一个从没被人看过的别名，
    /// 名录门照样放它出去，而这正是它要拦的形态，只是换了个集合。
    ///
    /// 这里造的就是那件事：兑换所声明了一条名录外别名、但没有 per-model 放行标记。
    /// 补上标记之后必须不再被这道门拦——「拦的依据是标记」由此钉死。
    /// </summary>
    [Fact]
    public async Task 兑换所里没盖放行标记的别名_必须被拦下()
    {
        var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                               ?? "mongodb://127.0.0.1:27018";
        var settings = MongoClientSettings.FromConnectionString(connectionString);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
        var client = new MongoClient(settings);
        await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));

        var gatewayDatabaseName = $"catalog_gate_exchange_{Guid.NewGuid():N}";
        var mapDatabaseName = $"catalog_gate_exchange_map_{Guid.NewGuid():N}";
        var gatewayData = new LlmGatewayDataContext(connectionString, gatewayDatabaseName);
        var mapData = new MongoDbContext(connectionString, mapDatabaseName);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["LlmGateway:InternalTenantId"] = GatewayTenantDefaults.InternalTenantId,
                ["ApiKeyCrypto:Secret"] = "catalog-gate-test-secret-2026",
            })
            .Build();

        const string exchangeId = "gw-exchange-catalog-gate";
        const string exchangeAlias = "some-vendor/exchange-only-model";
        try
        {
            await SeedExchangeAsync(gatewayData.Database, configuration, exchangeId, exchangeAlias);
            var resolver = new ModelResolver(
                mapData, configuration, NullLogger<ModelResolver>.Instance, gatewayData);

            // 兑换所声明了它，但条目上没有放行标记 → 必须被这道门拦下并点名错误码。
            var blocked = await resolver.ResolveAsync(
                Caller, ModelTypes.Chat,
                expectedModel: exchangeAlias, pinnedPlatformId: exchangeId, pinnedModelId: exchangeAlias);
            blocked.Success.ShouldBeFalse("兑换所里没盖过放行标记的别名不该被解析出来");
            blocked.FailureCode.ShouldBe(
                GatewayRouteFailure.ModelNotInCatalog,
                "拦下来还要点名是名录门拦的，否则管理员分不清是兑换所配错了还是这条别名不该用");

            // 补上标记 → 这道门不再拦。
            // 这里只断言「不再是名录门拦的」而不是断言解析成功：兑换所的执行还需要目标地址、
            // 凭据、转换器等一整套配置，那不是这条用例要验的东西，凑齐它们只会让判据变糊。
            await gatewayData.Database.GetCollection<BsonDocument>("llmgw_model_exchanges").UpdateOneAsync(
                Builders<BsonDocument>.Filter.Eq("_id", exchangeId),
                Builders<BsonDocument>.Update.Set("Models.0.AllowedOutsideCatalog", true));

            var afterStamp = await resolver.ResolveAsync(
                Caller, ModelTypes.Chat,
                expectedModel: exchangeAlias, pinnedPlatformId: exchangeId, pinnedModelId: exchangeAlias);
            afterStamp.FailureCode.ShouldNotBe(
                GatewayRouteFailure.ModelNotInCatalog,
                "盖过放行标记之后，名录门不该再拦它——拦的依据必须是标记本身");
        }
        finally
        {
            await client.DropDatabaseAsync(gatewayDatabaseName);
            await client.DropDatabaseAsync(mapDatabaseName);
        }
    }

    /// <summary>
    /// 兑换所那一支的种子：模型**只**活在兑换所文档里（llmgw_models 里没有它），
    /// 这正是走到「查不到任何文档」那一支的前提。
    /// </summary>
    private static async Task SeedExchangeAsync(
        IMongoDatabase database, IConfiguration configuration, string exchangeId, string alias)
    {
        await database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers")
            .InsertOneAsync(new GatewayAppCallerRecord
            {
                TenantId = GatewayTenantDefaults.InternalTenantId,
                AppCallerCode = Caller,
                RequestType = ModelTypes.Chat,
                Status = "configured",
                ModelPoolId = PoolId,
            });

        var pool = new ModelGroup
        {
            Id = PoolId,
            Name = "兑换所用例池",
            Code = "catalog-gate-exchange",
            ModelType = ModelTypes.Chat,
            Models =
            [
                new ModelGroupItem
                {
                    PlatformId = exchangeId, ModelId = alias,
                    Priority = 0, HealthStatus = ModelHealthStatus.Healthy,
                },
            ],
        };
        var poolDocument = pool.ToBsonDocument();
        poolDocument["TenantId"] = GatewayTenantDefaults.InternalTenantId;
        await database.GetCollection<BsonDocument>("llmgw_model_pools").InsertOneAsync(poolDocument);

        // TargetUrl 与可解密的 TargetApiKeyEncrypted 是**必填**：缺任一项，解析在名录门之前
        // 就以 OfferingUnresolvable 失败了，这条用例会变成一条测不到门的绿灯（形状 4b）。
        await database.GetCollection<BsonDocument>("llmgw_model_exchanges").InsertOneAsync(new BsonDocument
        {
            { "_id", exchangeId },
            { "TenantId", GatewayTenantDefaults.InternalTenantId },
            { "Name", "名录门兑换所用例" },
            { "Enabled", true },
            { "TargetUrl", "https://catalog-gate-exchange.example.test/v1/models/{model}" },
            { "TargetApiKeyEncrypted", ApiKeyCryptoKeyRing.Encrypt("sk-catalog-gate-exchange", configuration) },
            { "TargetAuthScheme", "Bearer" },
            {
                "Models", new BsonArray
                {
                    // 刻意不带 AllowedOutsideCatalog：这就是「绕过盖戳」的形态。
                    new BsonDocument
                    {
                        { "ModelId", alias },
                        { "ModelType", ModelTypes.Chat },
                        { "Enabled", true },
                    },
                }
            },
        });
    }

    private static async Task SeedAsync(IMongoDatabase database, IConfiguration configuration)
    {
        await database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers")
            .InsertOneAsync(new GatewayAppCallerRecord
            {
                TenantId = GatewayTenantDefaults.InternalTenantId,
                AppCallerCode = Caller,
                RequestType = ModelTypes.Chat,
                Status = "configured",
                ModelPoolId = PoolId,
            });

        var pool = new ModelGroup
        {
            Id = PoolId,
            Name = "名录门用例池",
            Code = "catalog-gate",
            ModelType = ModelTypes.Chat,
            Models =
            [
                new ModelGroupItem
                {
                    PlatformId = PlatformId, ModelId = CatalogModel,
                    Priority = 0, HealthStatus = ModelHealthStatus.Healthy,
                },
                new ModelGroupItem
                {
                    PlatformId = PlatformId, ModelId = OutsideModel,
                    Priority = 1, HealthStatus = ModelHealthStatus.Healthy,
                },
            ],
        };
        var poolDocument = pool.ToBsonDocument();
        poolDocument["TenantId"] = GatewayTenantDefaults.InternalTenantId;
        await database.GetCollection<BsonDocument>("llmgw_model_pools").InsertOneAsync(poolDocument);

        var encryptedKey = ApiKeyCryptoKeyRing.Encrypt("sk-catalog-gate-test", configuration);
        await InsertAsync(database, "llmgw_platforms", new LLMPlatform
        {
            Id = PlatformId,
            Name = "Catalog Gate Platform",
            PlatformType = "openai",
            ApiUrl = "https://catalog-gate.example.test/v1",
            ApiKeyEncrypted = encryptedKey,
            Enabled = true,
        });

        // 同名诱饵：24 条同名、但挂在**别的** Provider 下的模型文档，先于真正那条写进去。
        // 它们不进池、不影响解析，唯一作用是让「先按名字取一页、再在内存里按 Provider 过滤」
        // 这种写法暴露出来——那样取到的一页里根本没有当前 Provider 的记录，过滤后为空、
        // 判成「管不着」，于是下面第二步该被拦的模型反而放行。Provider 收窄必须写进
        // Mongo 谓词、在 Limit 之前生效，这一批诱饵就是它的红绿闭环。
        for (var i = 0; i < 24; i++)
        {
            await InsertAsync(database, "llmgw_models", new LLMModel
            {
                Id = $"catalog-gate-decoy-{i}",
                Name = OutsideModel,
                ModelName = OutsideModel,
                PlatformId = $"{PlatformId}-decoy-{i}",
                Protocol = "openai",
                Enabled = true,
            });
        }

        // 两条模型文档都**不带**放行标记：名录内那条靠名录放行，名录外那条正是要被拦的形态。
        foreach (var name in new[] { CatalogModel, OutsideModel })
        {
            await InsertAsync(database, "llmgw_models", new LLMModel
            {
                Id = $"catalog-gate-{name.Replace('/', '-')}",
                Name = name,
                ModelName = name,
                PlatformId = PlatformId,
                Protocol = "openai",
                Enabled = true,
            });
        }
    }

    private static async Task InsertAsync<T>(IMongoDatabase database, string collection, T value)
    {
        var document = value!.ToBsonDocument();
        document["TenantId"] = GatewayTenantDefaults.InternalTenantId;
        await database.GetCollection<BsonDocument>(collection).InsertOneAsync(document);
    }
}
