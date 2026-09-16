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
/// 对外模型解析出来的结果必须带着物理模型上配的价格。
///
/// 为什么要一条行为用例：这条链路断掉之后**什么都不会红**。请求照常成功、模型照常回答，
/// 只是每一次调用都按「没配价」记账——币种判为过期、不进美元成本、不进预算，而日志里
/// 一个字都不会说（degradation-must-alarm：静默降级必须有闸）。
///
/// 它断过一次：价格写在 llmgw_models 的文档上（控制台价格抽屉弱类型写入），而读方的强类型
/// LLMModel 类当时没有这几个属性，读回来就是空。池退场之前这不成问题，因为价格挂在池成员上、
/// 解析走的是池成员那条路；改走对外模型线路之后，物理模型就成了价格的唯一载体。
///
/// 所以这里刻意走真 Mongo、真解析器，且价格用**弱类型**写进去——就是控制台那条写入路径的形态。
/// 强类型 seed 会绕开「读方字段对不对得上」这个问题，那样它测不到要测的东西。
/// </summary>
public sealed class LogicalOfferingPricingTests
{
    private const string Caller = "pricing-probe.chat::chat";
    private const string LogicalModelId = "pricing-probe-logical";
    private const string PlatformId = "pricing-probe-platform";
    private const string PhysicalModelId = "pricing-probe-model";
    private const string UpstreamModel = "gpt-4o";

    [Fact]
    public async Task 对外模型解析结果_必须带着物理模型上配的价格()
    {
        var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                               ?? "mongodb://127.0.0.1:27018";
        var settings = MongoClientSettings.FromConnectionString(connectionString);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
        var client = new MongoClient(settings);
        await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));

        var gatewayDatabaseName = $"logical_pricing_{Guid.NewGuid():N}";
        var mapDatabaseName = $"logical_pricing_map_{Guid.NewGuid():N}";
        var gatewayData = new LlmGatewayDataContext(connectionString, gatewayDatabaseName);
        var mapData = new MongoDbContext(connectionString, mapDatabaseName);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["LlmGateway:InternalTenantId"] = GatewayTenantDefaults.InternalTenantId,
                ["ApiKeyCrypto:Secret"] = "logical-pricing-test-secret-2026",
            })
            .Build();

        var observedAt = new DateTime(2026, 9, 16, 8, 0, 0, DateTimeKind.Utc);
        try
        {
            await SeedAsync(gatewayData.Database, configuration, observedAt);
            var resolver = new ModelResolver(
                mapData, configuration, NullLogger<ModelResolver>.Instance, gatewayData);

            var result = await resolver.ResolveAsync(Caller, ModelTypes.Chat);
            result.Success.ShouldBeTrue(result.ErrorMessage);
            result.ResolutionType.ShouldBe("LogicalModel");
            result.ActualModel.ShouldBe(UpstreamModel);

            result.InputPricePerMillion.ShouldBe(
                2.50m,
                "对外模型解析丢了输入单价——这条请求会被按「没配价」记账，而且不会有任何报错");
            result.OutputPricePerMillion.ShouldBe(10.00m);
            result.CachedInputPricePerMillion.ShouldBe(1.25m);
            result.CacheWritePricePerMillion.ShouldBe(3.125m);
            result.PricePerCall.ShouldBe(0.004m);
            result.PriceCurrency.ShouldBe(
                "USD",
                "币种丢了比单价丢了更隐蔽：记账侧会判成币种过期，把这笔调用整条排除在美元成本之外");
            result.PriceSource.ShouldBe("admin");
            result.PriceObservedAt.ShouldBe(observedAt);
        }
        finally
        {
            await client.DropDatabaseAsync(gatewayDatabaseName);
            await client.DropDatabaseAsync(mapDatabaseName);
        }
    }

    private static async Task SeedAsync(
        IMongoDatabase database, IConfiguration configuration, DateTime observedAt)
    {
        await database.GetCollection<GatewayAppCallerRecord>("llmgw_app_callers")
            .InsertOneAsync(new GatewayAppCallerRecord
            {
                TenantId = GatewayTenantDefaults.InternalTenantId,
                AppCallerCode = Caller,
                RequestType = ModelTypes.Chat,
                Status = "configured",
            });

        await InsertAsync(database, "llmgw_platforms", new LLMPlatform
        {
            Id = PlatformId,
            Name = "计价用例平台",
            PlatformType = "openai",
            ApiUrl = "https://pricing-probe.example.test/v1",
            ApiKeyEncrypted = ApiKeyCryptoKeyRing.Encrypt("sk-pricing-probe", configuration),
            Enabled = true,
        });

        // 价格用**弱类型**写，与控制台价格抽屉那条写入路径同形。
        // 换成强类型 seed 就绕开了「读方字段对不对得上」，用例会变成一条测不到东西的绿灯。
        var modelDocument = new LLMModel
        {
            Id = PhysicalModelId,
            Name = UpstreamModel,
            ModelName = UpstreamModel,
            PlatformId = PlatformId,
            Protocol = "openai",
            Enabled = true,
        }.ToBsonDocument();
        modelDocument["TenantId"] = GatewayTenantDefaults.InternalTenantId;
        modelDocument["InputPricePerMillion"] = 2.50m;
        modelDocument["OutputPricePerMillion"] = 10.00m;
        modelDocument["CachedInputPricePerMillion"] = 1.25m;
        modelDocument["CacheWritePricePerMillion"] = 3.125m;
        modelDocument["PricePerCall"] = 0.004m;
        modelDocument["PriceCurrency"] = "USD";
        modelDocument["PriceSource"] = "admin";
        modelDocument["PriceObservedAt"] = observedAt;
        await database.GetCollection<BsonDocument>("llmgw_models").InsertOneAsync(modelDocument);

        await InsertAsync(database, "llmgw_logical_models", new GatewayLogicalModel
        {
            Id = LogicalModelId,
            PublicId = "pricing-probe",
            PublicIdNormalized = "pricing-probe",
            Name = "计价用例模型",
            ModelType = ModelTypes.Chat,
            Capabilities = ["chat"],
            IsDefaultForType = true,
            Enabled = true,
        });
        await InsertAsync(database, "llmgw_model_offerings", new GatewayModelOffering
        {
            Id = "pricing-probe-offering",
            LogicalModelId = LogicalModelId,
            TargetId = PhysicalModelId,
            TargetKind = "model",
            UpstreamModelId = UpstreamModel,
            Protocol = "openai",
            Enabled = true,
            Priority = 10,
            HealthStatus = ModelHealthStatus.Healthy,
        });
    }

    private static async Task InsertAsync<T>(IMongoDatabase database, string collectionName, T value)
    {
        var document = value!.ToBsonDocument();
        document["TenantId"] = GatewayTenantDefaults.InternalTenantId;
        await database.GetCollection<BsonDocument>(collectionName).InsertOneAsync(document);
    }
}
