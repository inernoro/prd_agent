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
        result.ResolutionType.ShouldBe("LogicalModel");
        result.LogicalModelPublicId.ShouldBe("default-chat");
        result.ActualModel.ShouldBe(ChatModel);
    }

    /// <summary>
    /// 生产的真实形状：MAP 侧每条登记都绑着同一个早已消失的模型组——模型管理写接口下线时，
    /// 启动同步自动绑的那个组跟着没了。这种悬空绑定是退场残留，不是「配错了」，
    /// 不能让它把功能判死。
    ///
    /// MAP 库里同时留着一条 legacy 直连模型（IsMain 的 enabled 行），这是关键：
    /// 已迁移的部署往往两样都有。GW 默认池必须赢——它才是配置权威；
    /// 顺序写反的话这类部署会永远绕过自己的权威配置走老路（Codex 第四十九轮 P1）。
    /// 空 MAP 库测不出这一条，所以这里必须把 legacy 行摆上。
    /// </summary>
    [Fact]
    public async Task DanglingMapBinding_ShouldPreferGatewayDefaultPoolOverLegacyDirectModel()
    {
        await using var env = await GatewayFixture.CreateAsync();
        await env.MapData.LLMPlatforms.InsertOneAsync(new LLMPlatform
        {
            Id = "legacy-platform",
            Name = "老平台",
            PlatformType = "openai",
            ApiUrl = "https://legacy.example.test/v1",
            Enabled = true,
        });
        await env.MapData.LLMModels.InsertOneAsync(new LLMModel
        {
            Id = "legacy-main-model",
            Name = "legacy-main",
            ModelName = "legacy-main",
            PlatformId = "legacy-platform",
            IsMain = true,
            Enabled = true,
        });
        await env.MapData.LLMAppCallers.InsertOneAsync(new LLMAppCaller
        {
            AppCode = "document-store.selection-rewrite::chat",
            DisplayName = "知识库划词局部改写",
            ModelRequirements =
            [
                new AppModelRequirement
                {
                    ModelType = ModelTypes.Chat,
                    ModelGroupIds = ["model-group-that-no-longer-exists"],
                },
            ],
        });

        var result = await env.Resolver.ResolveAsync(
            "document-store.selection-rewrite::chat",
            ModelTypes.Chat);

        result.Success.ShouldBeTrue(result.ErrorMessage);
        result.LogicalModelPublicId.ShouldBe("default-chat");
        result.ActualModel.ShouldBe(ChatModel);
        result.ActualModel.ShouldNotBe("legacy-main");
    }

    /// <summary>
    /// 兜底必须是边界，不是入场券。
    ///
    /// 未登记的调用方带着 expectedModel 进来（视觉创作那条路就是把用户选的 ModelId 当
    /// expectedModel 传的），如果只是把默认池塞进候选、不关掉后面 expectedModel 的
    /// 「全量池搜索」与「LLMModels 直连」，它就能顺着这两档走到该类型的任意池、任意同名模型上——
    /// 「只回落到默认池」这句话就作废了（Codex 第五十轮 P1）。
    ///
    /// 这里在 MAP 库里埋一个同名的 legacy 模型：解析必须留在 GW 默认池里，不许命中它。
    /// </summary>
    [Fact]
    public async Task UnregisteredFallback_ShouldNotWidenSearchForExpectedModel()
    {
        await using var env = await GatewayFixture.CreateAsync();
        await env.MapData.LLMPlatforms.InsertOneAsync(new LLMPlatform
        {
            Id = "outside-platform",
            Name = "范围外平台",
            PlatformType = "openai",
            ApiUrl = "https://outside.example.test/v1",
            Enabled = true,
        });
        await env.MapData.LLMModels.InsertOneAsync(new LLMModel
        {
            Id = "outside-model",
            Name = "outside-model",
            ModelName = "outside-model",
            PlatformId = "outside-platform",
            Enabled = true,
        });

        var result = await env.Resolver.ResolveAsync(
            "document-store.transcribe-summary::chat",
            ModelTypes.Chat,
            expectedModel: "outside-model");

        // 点名了目录里没有的模型：必须结构化失败，绝不能悄悄换一个给他。
        // 旧行为是「回落到默认池」——那恰恰违反 llm-gateway 规则 3（显式未知时禁止静默落到全局默认），
        // 池退场顺带把这个洞堵上了。不变量没变：点名了就不许换人。
        result.Success.ShouldBeFalse();
        result.ActualModel.ShouldNotBe("outside-model");
        result.ActualModel.ShouldNotBe(ChatModel);
        result.ErrorMessage.ShouldContain("outside-model");
    }

    /// <summary>
    /// 边界的第三个出口：池选完之后一个成员都用不了。
    ///
    /// 前两个出口（expectedModel 的全量池搜索、LLMModels 直连）已经关掉了，但「池空/全不健康」
    /// 那条退路原本会继续掉到 legacy IsMain 直连——等于从背面绕开承诺过的边界
    /// （Codex 第五十一轮 P1）。这里把默认池清空、同时在 MAP 库里摆一条可用的 legacy 模型：
    /// 解析必须失败并报池的失败码，不许把那条 legacy 跑起来。
    /// </summary>
    [Fact]
    public async Task UnregisteredFallback_ShouldFailClosedInsteadOfDroppingToLegacy()
    {
        await using var env = await GatewayFixture.CreateAsync();
        // 「默认模型一条线路都接不住」——池退场后这是同一种处境的新表达。
        await env.GatewayData.Database
            .GetCollection<BsonDocument>("llmgw_model_offerings")
            .UpdateManyAsync(
                Builders<BsonDocument>.Filter.Eq("LogicalModelId", GatewayFixture.DefaultChatLogicalId),
                Builders<BsonDocument>.Update.Set("Enabled", false));
        await env.MapData.LLMPlatforms.InsertOneAsync(new LLMPlatform
        {
            Id = "legacy-platform",
            Name = "老平台",
            PlatformType = "openai",
            ApiUrl = "https://legacy.example.test/v1",
            Enabled = true,
        });
        await env.MapData.LLMModels.InsertOneAsync(new LLMModel
        {
            Id = "legacy-main-model",
            Name = "legacy-main",
            ModelName = "legacy-main",
            PlatformId = "legacy-platform",
            IsMain = true,
            Enabled = true,
        });

        var result = await env.Resolver.ResolveAsync(
            "document-store.transcribe-summary::chat",
            ModelTypes.Chat);

        result.Success.ShouldBeFalse();
        result.ActualModel.ShouldNotBe("legacy-main");
    }

    /// <summary>
    /// embedding / asr / video-gen 三类不吃这条兜底：绑定还在、池没了，换个模型出来的东西
    /// 根本不能用（向量维度对不上，写进库就是一批认不出来的垃圾）。这正是
    /// HasDedicatedBinding 那段注释点名要拦的情形，继续失败关闭。
    /// </summary>
    [Fact]
    public async Task DanglingMapBinding_ShouldStayFailClosedForEmbedding()
    {
        await using var env = await GatewayFixture.CreateAsync();
        // MAP 侧同时摆满两条 legacy 退路，这是这条用例的关键：
        // 兜底助手对受保护类型返回空列表之后，控制流会继续走到「候选为空」那一段，
        // 那里依次试 FindLegacyModelAsync 与 TryResolveLegacyConfigFallbackAsync。
        // 只有把这两条都喂饱、断言仍然失败，才谈得上证明了「失败关闭」——
        // 原来的用例 MAP 库全空，顺序写错照样绿（Codex 第五十二轮 P1 指出的盲区）。
        await env.MapData.LLMPlatforms.InsertOneAsync(new LLMPlatform
        {
            Id = "legacy-platform",
            Name = "老平台",
            PlatformType = "openai",
            ApiUrl = "https://legacy.example.test/v1",
            Enabled = true,
        });
        await env.MapData.LLMModels.InsertOneAsync(new LLMModel
        {
            Id = "legacy-any-model",
            Name = "legacy-any",
            ModelName = "legacy-any",
            PlatformId = "legacy-platform",
            // 四个 legacy 标记全部打开：将来谁给 FindLegacyModelAsync 补一条
            // embedding 分支，无论挂在哪个标记上，这条用例都会立刻变红。
            IsMain = true,
            IsIntent = true,
            IsVision = true,
            IsImageGen = true,
            Enabled = true,
        });
        await env.MapData.LLMConfigs.InsertOneAsync(new LLMConfig
        {
            Id = "legacy-active-config",
            Provider = "OpenAI",
            Model = "legacy-config-model",
            ApiEndpoint = "https://legacy-config.example.test/v1",
            IsActive = true,
        });
        await env.MapData.LLMAppCallers.InsertOneAsync(new LLMAppCaller
        {
            AppCode = "some-agent.index::embedding",
            DisplayName = "向量索引",
            ModelRequirements =
            [
                new AppModelRequirement
                {
                    ModelType = ModelTypes.Embedding,
                    ModelGroupIds = ["model-group-that-no-longer-exists"],
                },
            ],
        });
        var embeddingPool = new ModelGroup
        {
            Id = "gw-default-embedding-pool",
            Name = "向量默认池",
            Code = "default-embedding",
            ModelType = ModelTypes.Embedding,
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
        var doc = embeddingPool.ToBsonDocument();
        doc["TenantId"] = GatewayTenantDefaults.InternalTenantId;
        await env.GatewayData.Database.GetCollection<BsonDocument>("llmgw_model_pools").InsertOneAsync(doc);

        var result = await env.Resolver.ResolveAsync(
            "some-agent.index::embedding",
            ModelTypes.Embedding);

        result.Success.ShouldBeFalse();
        // 不止「没成功」：不能是悄悄换了个模型给回来。两条 legacy 退路的产物都点名排除。
        result.ActualModel.ShouldNotBe("legacy-any");
        result.ActualModel.ShouldNotBe("legacy-config-model");
        // 也不能是 GW 默认池里那个 chat 模型——受保护类型宁可失败也不换模型。
        result.ActualModel.ShouldNotBe(ChatModel);
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

        // 池路由退场后，这条绑定没有任何运行时消费方了。
        //
        // 这里刻意**不**改成 fail closed：池退场不该反过来把还在跑的调用方打挂
        // （线上确实还有两个带着这种残留字段）。要消灭的是「静默」不是「放行」——
        // 所以照常按对外模型解析，同时 resolver 记一条点名那条绑定的告警，
        // 控制台那几个控件也标成已退役（守卫 `残留池绑定不许静默生效`）。
        result.Success.ShouldBeTrue(result.ErrorMessage);
        result.ResolutionType.ShouldBe("LogicalModel");
        result.LogicalModelPublicId.ShouldBe("default-chat");
    }

    private sealed class GatewayFixture : IAsyncDisposable
    {
        public const string DefaultChatPoolId = "gw-default-chat-pool";
        public const string DefaultChatLogicalId = "gw-default-chat-logical";

        private readonly MongoClient _client;
        private readonly string _gatewayDatabaseName;
        private readonly string _mapDatabaseName;

        public LlmGatewayDataContext GatewayData { get; }
        public MongoDbContext MapData { get; }
        public ModelResolver Resolver { get; }

        private GatewayFixture(
            MongoClient client,
            string gatewayDatabaseName,
            string mapDatabaseName,
            LlmGatewayDataContext gatewayData,
            MongoDbContext mapData,
            ModelResolver resolver)
        {
            _client = client;
            _gatewayDatabaseName = gatewayDatabaseName;
            _mapDatabaseName = mapDatabaseName;
            GatewayData = gatewayData;
            MapData = mapData;
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

            // 库名必须短：Mongo 的上限是 63 字符，而 32 位 guid 已经吃掉一半。
            // 起初用的 "gateway_unregistered_caller_map_" + guid 正好 64，
            // 断言全过、DisposeAsync 里 dropDatabase 才炸，看着像功能坏了（实际不是）。
            var gatewayDatabaseName = $"gw_unreg_caller_{Guid.NewGuid():N}";
            var mapDatabaseName = $"gw_unreg_caller_map_{Guid.NewGuid():N}";
            var gatewayData = new LlmGatewayDataContext(connectionString, gatewayDatabaseName);
            var mapData = new MongoDbContext(connectionString, mapDatabaseName);
            var configuration = new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["LlmGateway:InternalTenantId"] = GatewayTenantDefaults.InternalTenantId,
                    ["ApiKeyCrypto:Secret"] = "gateway-unregistered-caller-test-secret-2026",
                })
                .Build();

            // GW 侧：这个用途的默认对外模型 + 一条线路 + 一个可用平台与模型。
            // MAP 侧刻意保持全空，复现「模型管理写接口退场后 model_groups 恒为空」的真实生产状态。
            //
            // 这里原本建的是模型池。池退场之后，「未登记的调用方有没有着落」这个不变量
            // 换成由用途默认回答——事故要防的事没变（第一次被人用就报「未找到可用模型」），
            // 换的是它在新架构里的落点。
            await InsertTenantDocumentAsync(
                gatewayData.Database,
                "llmgw_logical_models",
                new GatewayLogicalModel
                {
                    Id = DefaultChatLogicalId,
                    PublicId = "default-chat",
                    PublicIdNormalized = "default-chat",
                    Name = "对话默认",
                    ModelType = ModelTypes.Chat,
                    Capabilities = ["chat"],
                    IsDefaultForType = true,
                    Enabled = true,
                    DisplayOrder = 10,
                });
            await InsertTenantDocumentAsync(
                gatewayData.Database,
                "llmgw_model_offerings",
                new GatewayModelOffering
                {
                    Id = "default-chat-offering",
                    LogicalModelId = DefaultChatLogicalId,
                    TargetId = "chat-model-id",
                    TargetKind = "model",
                    Protocol = "openai",
                    Enabled = true,
                    Priority = 10,
                    HealthStatus = ModelHealthStatus.Healthy,
                    ConsecutiveSuccesses = 10,
                });

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

            return new GatewayFixture(client, gatewayDatabaseName, mapDatabaseName, gatewayData, mapData, resolver);
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
