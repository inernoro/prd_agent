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
/// 认领（DefaultForAppCallerCodes）的比较必须与 appCaller 身份规则一致，不能按字节比。
///
/// 这条用例防的是一次**静默换模型**：这条解析链路上其余每一处 appCaller 比较都不分大小写
/// （被动注册与治理读走 GatewayAppCallerIdentity.Collation，授权名单走 OrdinalIgnoreCase），
/// 唯独认领那一句曾经按字节比。于是认领登记成 Some-Agent.Feature::Chat、请求带
/// some-agent.feature::chat 时：授权照过、认领落空，请求掉到「这个用途的默认」——
/// 换了一个模型，而没有任何一处会报错（第 76 轮 review）。
///
/// 判据只能是行为：这是一次 Mongo 查询，collation 是查询选项不是过滤器，
/// 扫源码只能证明那几个字还在，证明不了两边算出同一个答案。
/// </summary>
public sealed class GatewayClaimIdentityCaseTests
{
    private const string PlatformId = "openai-platform";
    private const string ClaimedModel = "claimed-chat-model";
    private const string DefaultModel = "default-chat-model";

    /// <summary>登记时写的大小写。刻意与请求那一侧不同——真实数据里两侧由不同的人填。</summary>
    private const string RegisteredClaim = "Some-Agent.Feature::Chat";

    [Theory]
    // 大小写完全一致：这一档在修复之前就是对的，留着防「修好了新的、弄坏了旧的」。
    [InlineData(RegisteredClaim)]
    // 全小写：注册表规范要求的写法，也是绝大多数调用方真正发出来的那个串。
    [InlineData("some-agent.feature::chat")]
    // 全大写：把「不分大小写」这件事钉死，而不是只钉一个方向。
    [InlineData("SOME-AGENT.FEATURE::CHAT")]
    public async Task ClaimLookup_ShouldIgnoreCase(string requestedAppCallerCode)
    {
        await using var env = await ClaimFixture.CreateAsync();

        var result = await env.Resolver.ResolveAsync(requestedAppCallerCode, ModelTypes.Chat);

        result.Success.ShouldBeTrue(result.ErrorMessage);
        // 认领它的那个模型赢，而不是这个用途的默认。
        result.LogicalModelPublicId.ShouldBe("claimed-chat");
        result.ActualModel.ShouldBe(ClaimedModel);
        // 反向也断言一次：掉到用途默认是这条缺陷的表现形态，不能只看「成功了没有」。
        result.ActualModel.ShouldNotBe(DefaultModel);
    }

    /// <summary>
    /// 边界：没有任何模型认领它时，照旧落到这个用途的默认。
    ///
    /// 不放这一条的话，把认领查询改成「谁都匹配」也能让上面三条全绿——
    /// 那种改法把缺陷换了个方向而不是修好（判据宽到把要防的那件事也放了进去）。
    /// </summary>
    [Fact]
    public async Task UnclaimedCaller_ShouldStillFallBackToTypeDefault()
    {
        await using var env = await ClaimFixture.CreateAsync();

        var result = await env.Resolver.ResolveAsync("other-agent.feature::chat", ModelTypes.Chat);

        result.Success.ShouldBeTrue(result.ErrorMessage);
        result.LogicalModelPublicId.ShouldBe("default-chat");
        result.ActualModel.ShouldBe(DefaultModel);
    }

    private sealed class ClaimFixture : IAsyncDisposable
    {
        private const string ClaimedLogicalId = "gw-logical-claimed-chat";
        private const string DefaultLogicalId = "gw-logical-default-chat";

        private readonly MongoClient _client;
        private readonly string _gatewayDatabaseName;
        private readonly string _mapDatabaseName;

        public ModelResolver Resolver { get; }

        private ClaimFixture(
            MongoClient client,
            string gatewayDatabaseName,
            string mapDatabaseName,
            ModelResolver resolver)
        {
            _client = client;
            _gatewayDatabaseName = gatewayDatabaseName;
            _mapDatabaseName = mapDatabaseName;
            Resolver = resolver;
        }

        public static async Task<ClaimFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));

            // 库名保持短：Mongo 的上限是 63 字符，guid 已经吃掉一半。
            var gatewayDatabaseName = $"gw_claim_case_{Guid.NewGuid():N}";
            var mapDatabaseName = $"gw_claim_case_map_{Guid.NewGuid():N}";
            var gatewayData = new LlmGatewayDataContext(connectionString, gatewayDatabaseName);
            var mapData = new MongoDbContext(connectionString, mapDatabaseName);
            var configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["LlmGateway:InternalTenantId"] = GatewayTenantDefaults.InternalTenantId,
                    ["ApiKeyCrypto:Secret"] = "gateway-claim-identity-case-test-secret-2026",
                })
                .Build();

            // 认领它的那个模型：DisplayOrder 故意排在默认之后。
            // 两层查询的顺序才是判据，不能靠「它碰巧排在前面」蒙混过关。
            await InsertTenantDocumentAsync(gatewayData.Database, "llmgw_logical_models",
                new GatewayLogicalModel
                {
                    Id = ClaimedLogicalId,
                    PublicId = "claimed-chat",
                    PublicIdNormalized = "claimed-chat",
                    Name = "被认领的对话模型",
                    ModelType = ModelTypes.Chat,
                    Capabilities = ["chat"],
                    DefaultForAppCallerCodes = [RegisteredClaim],
                    Enabled = true,
                    DisplayOrder = 90,
                });
            await InsertTenantDocumentAsync(gatewayData.Database, "llmgw_model_offerings",
                new GatewayModelOffering
                {
                    Id = "claimed-chat-offering",
                    LogicalModelId = ClaimedLogicalId,
                    TargetId = "claimed-model-id",
                    TargetKind = "model",
                    Protocol = "openai",
                    Enabled = true,
                    Priority = 10,
                    HealthStatus = ModelHealthStatus.Healthy,
                    ConsecutiveSuccesses = 10,
                });

            await InsertTenantDocumentAsync(gatewayData.Database, "llmgw_logical_models",
                new GatewayLogicalModel
                {
                    Id = DefaultLogicalId,
                    PublicId = "default-chat",
                    PublicIdNormalized = "default-chat",
                    Name = "对话默认",
                    ModelType = ModelTypes.Chat,
                    Capabilities = ["chat"],
                    IsDefaultForType = true,
                    Enabled = true,
                    DisplayOrder = 10,
                });
            await InsertTenantDocumentAsync(gatewayData.Database, "llmgw_model_offerings",
                new GatewayModelOffering
                {
                    Id = "default-chat-offering",
                    LogicalModelId = DefaultLogicalId,
                    TargetId = "default-model-id",
                    TargetKind = "model",
                    Protocol = "openai",
                    Enabled = true,
                    Priority = 10,
                    HealthStatus = ModelHealthStatus.Healthy,
                    ConsecutiveSuccesses = 10,
                });

            var encryptedKey = ApiKeyCryptoKeyRing.Encrypt("sk-test-platform", configuration);
            await InsertTenantDocumentAsync(gatewayData.Database, "llmgw_platforms",
                new LLMPlatform
                {
                    Id = PlatformId,
                    Name = "OpenAI",
                    PlatformType = "openai",
                    ApiUrl = "https://openai.example.test/v1",
                    ApiKeyEncrypted = encryptedKey,
                    Enabled = true,
                });
            await InsertTenantDocumentAsync(gatewayData.Database, "llmgw_models",
                new LLMModel
                {
                    Id = "claimed-model-id",
                    Name = ClaimedModel,
                    ModelName = ClaimedModel,
                    PlatformId = PlatformId,
                    Protocol = "openai",
                    Enabled = true,
                });
            await InsertTenantDocumentAsync(gatewayData.Database, "llmgw_models",
                new LLMModel
                {
                    Id = "default-model-id",
                    Name = DefaultModel,
                    ModelName = DefaultModel,
                    PlatformId = PlatformId,
                    Protocol = "openai",
                    Enabled = true,
                });

            var resolver = new ModelResolver(
                mapData,
                configuration,
                NullLogger<ModelResolver>.Instance,
                gatewayData);

            return new ClaimFixture(client, gatewayDatabaseName, mapDatabaseName, resolver);
        }

        private static async Task InsertTenantDocumentAsync<T>(
            IMongoDatabase database,
            string collectionName,
            T value)
        {
            var document = value!.ToBsonDocument();
            document["TenantId"] = GatewayTenantDefaults.InternalTenantId;
            await database.GetCollection<BsonDocument>(collectionName).InsertOneAsync(document);
        }

        public async ValueTask DisposeAsync()
        {
            await _client.DropDatabaseAsync(_gatewayDatabaseName);
            await _client.DropDatabaseAsync(_mapDatabaseName);
        }
    }
}
