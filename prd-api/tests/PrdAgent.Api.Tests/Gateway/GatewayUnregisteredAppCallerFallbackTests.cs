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
/// 「没在 GW 登记过的 appCaller」该走哪条路。
///
/// 生产事故：录音一键整理第一次被人用就报「未找到可用模型」，而 chat 默认池里有 262 个成员。
/// 根因是 document-store.transcribe-summary::chat 从没进过 llmgw_app_callers，解析于是掉进
/// MAP 兼容分支；MAP 的 model_groups 在模型管理写接口退场后恒为空，一路走到 NotFound。
/// 同一个部署里 document-store.subtitle::asr 能用，唯一差别就是它有登记记录。
///
/// 这两条用例分别钉住修复与它的边界：未登记要能回落到默认池，被阻挡的仍要 fail closed。
/// </summary>
public sealed class GatewayUnregisteredAppCallerFallbackTests
{
    private const string PlatformId = "openai-platform";
    private const string ChatModel = "gpt-4.1-mini";

    [Fact]
    public async Task UnregisteredAppCaller_ShouldFallBackToGatewayDefaultPool()
    {
        await using var env = await GatewayFixture.CreateAsync();

        var result = await env.Resolver.ResolveAsync(
            "document-store.transcribe-summary::chat",
            ModelTypes.Chat);

        result.Success.ShouldBeTrue(result.ErrorMessage);
        result.ResolutionType.ShouldBe("GatewayRegistryPool");
        result.ModelGroupId.ShouldBe(GatewayFixture.DefaultChatPoolId);
        result.ActualModel.ShouldBe(ChatModel);
    }

    /// <summary>
    /// 边界：登记了、但绑的池不存在。这是「显式池未知」，必须结构化失败，
    /// 不能被上面那条兜底顺手放行——否则一条配错的绑定会看起来像配对了。
    /// </summary>
    [Fact]
    public async Task RegisteredAppCallerWithMissingPool_ShouldStillFailClosed()
    {
        await using var env = await GatewayFixture.CreateAsync();
        await env.GatewayData.Database
            .GetCollection<GatewayAppCallerRecord>("llmgw_app_callers")
            .InsertOneAsync(new GatewayAppCallerRecord
            {
                TenantId = GatewayTenantDefaults.InternalTenantId,
                AppCallerCode = "document-store.reprocess::chat",
                RequestType = ModelTypes.Chat,
                Status = "configured",
                ModelPoolId = "pool-that-was-deleted",
            });

        var result = await env.Resolver.ResolveAsync(
            "document-store.reprocess::chat",
            ModelTypes.Chat);

        result.Success.ShouldBeFalse();
        result.FailureCode.ShouldBe(GatewayRouteFailure.AppCallerPoolUnbound);
    }

    private sealed class GatewayFixture : IAsyncDisposable
    {
        public const string DefaultChatPoolId = "gw-default-chat-pool";

        private readonly MongoClient _client;
        private readonly string _gatewayDatabaseName;
        private readonly string _mapDatabaseName;

        public LlmGatewayDataContext GatewayData { get; }
        public ModelResolver Resolver { get; }

        private GatewayFixture(
            MongoClient client,
            string gatewayDatabaseName,
            string mapDatabaseName,
            LlmGatewayDataContext gatewayData,
            ModelResolver resolver)
        {
            _client = client;
            _gatewayDatabaseName = gatewayDatabaseName;
            _mapDatabaseName = mapDatabaseName;
            GatewayData = gatewayData;
            Resolver = resolver;
        }

        public static async Task<GatewayFixture> CreateAsync()
        {
            var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                                   ?? "mongodb://127.0.0.1:27018";
            var settings = MongoClientSettings.FromConnectionString(connectionString);
            settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
            var client = new MongoClient(settings);
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));

            var gatewayDatabaseName = $"gateway_unregistered_caller_{Guid.NewGuid():N}";
            var mapDatabaseName = $"gateway_unregistered_caller_map_{Guid.NewGuid():N}";
            var gatewayData = new LlmGatewayDataContext(connectionString, gatewayDatabaseName);
            var mapData = new MongoDbContext(connectionString, mapDatabaseName);
            var configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["LlmGateway:InternalTenantId"] = GatewayTenantDefaults.InternalTenantId,
                    ["ApiKeyCrypto:Secret"] = "gateway-unregistered-caller-test-secret-2026",
                })
                .Build();

            // GW 侧：一个 chat 默认池 + 一个可用平台与模型。MAP 侧刻意保持全空，
            // 复现「模型管理写接口退场后 model_groups 恒为空」的真实生产状态。
            var pool = new ModelGroup
            {
                Id = DefaultChatPoolId,
                Name = "对话默认池",
                Code = "default-chat",
                ModelType = ModelTypes.Chat,
                IsDefaultForType = true,
                Priority = 10,
                Models =
                [
                    new ModelGroupItem
                    {
                        PlatformId = PlatformId,
                        ModelId = ChatModel,
                        Priority = 0,
                        HealthStatus = ModelHealthStatus.Healthy,
                        ConsecutiveSuccesses = 10,
                    },
                ],
            };
            var poolDocument = pool.ToBsonDocument();
            poolDocument["TenantId"] = GatewayTenantDefaults.InternalTenantId;
            await gatewayData.Database
                .GetCollection<BsonDocument>("llmgw_model_pools")
                .InsertOneAsync(poolDocument);

            var encryptedKey = ApiKeyCryptoKeyRing.Encrypt("sk-test-platform", configuration);
            await InsertTenantDocumentAsync(
                gatewayData.Database,
                "llmgw_platforms",
                new LLMPlatform
                {
                    Id = PlatformId,
                    Name = "OpenAI",
                    PlatformType = "openai",
                    ApiUrl = "https://openai.example.test/v1",
                    ApiKeyEncrypted = encryptedKey,
                    Enabled = true,
                });
            await InsertTenantDocumentAsync(
                gatewayData.Database,
                "llmgw_models",
                new LLMModel
                {
                    Id = "chat-model-id",
                    Name = ChatModel,
                    ModelName = ChatModel,
                    PlatformId = PlatformId,
                    Protocol = "openai",
                    Enabled = true,
                });

            var resolver = new ModelResolver(
                mapData,
                configuration,
                NullLogger<ModelResolver>.Instance,
                gatewayData);

            return new GatewayFixture(client, gatewayDatabaseName, mapDatabaseName, gatewayData, resolver);
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
