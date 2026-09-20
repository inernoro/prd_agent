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

public sealed class GatewayPinnedRegistryModelTests
{
    [Fact]
    public async Task PinnedAsrMember_ShouldNotBeReplacedByHealthierMemberDuringServingResolve()
    {
        var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                               ?? "mongodb://127.0.0.1:27018";
        var settings = MongoClientSettings.FromConnectionString(connectionString);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(3);
        var client = new MongoClient(settings);
        await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1));

        var gatewayDatabaseName = $"gateway_pinned_registry_{Guid.NewGuid():N}";
        var mapDatabaseName = $"gateway_pinned_registry_map_{Guid.NewGuid():N}";
        var gatewayData = new LlmGatewayDataContext(connectionString, gatewayDatabaseName);
        var mapData = new MongoDbContext(connectionString, mapDatabaseName);
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["LlmGateway:InternalTenantId"] = GatewayTenantDefaults.InternalTenantId,
                ["ApiKeyCrypto:Secret"] = "gateway-pinned-registry-test-secret-2026",
            })
            .Build();

        try
        {
            const string caller = "transcript-agent.transcribe::asr";
            const string logicalModelId = "asr-stable-logical";
            const string audioPlatformId = "openrouter-platform";
            const string transcriptPlatformId = "openai-platform";
            const string audioModel = "openai/gpt-audio-mini";
            const string transcriptModel = "gpt-4o-transcribe";

            await gatewayData.Database
                .GetCollection<GatewayAppCallerRecord>("llmgw_app_callers")
                .InsertOneAsync(new GatewayAppCallerRecord
                {
                    TenantId = GatewayTenantDefaults.InternalTenantId,
                    AppCallerCode = caller,
                    RequestType = ModelTypes.Asr,
                    Status = "configured",
                });

            var encryptedKey = ApiKeyCryptoKeyRing.Encrypt("sk-test-platform", configuration);
            var encryptedModelKey = ApiKeyCryptoKeyRing.Encrypt("sk-test-model", configuration);
            await InsertTenantDocumentAsync(
                gatewayData.Database,
                "llmgw_platforms",
                new LLMPlatform
                {
                    Id = audioPlatformId,
                    Name = "openrouter.ai",
                    PlatformType = "openai",
                    ApiUrl = "https://openrouter.example.test/api/v1",
                    ApiKeyEncrypted = encryptedKey,
                    Enabled = true,
                });
            await InsertTenantDocumentAsync(
                gatewayData.Database,
                "llmgw_platforms",
                new LLMPlatform
                {
                    Id = transcriptPlatformId,
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
                    Id = "audio-model-id",
                    Name = audioModel,
                    ModelName = audioModel,
                    PlatformId = audioPlatformId,
                    Protocol = "openai-model-protocol",
                    ApiUrl = "https://audio-model.example.test/v1",
                    ApiKeyEncrypted = encryptedModelKey,
                    Enabled = true,
                });
            await InsertTenantDocumentAsync(
                gatewayData.Database,
                "llmgw_models",
                new LLMModel
                {
                    Id = "transcript-model-id",
                    Name = transcriptModel,
                    ModelName = transcriptModel,
                    PlatformId = transcriptPlatformId,
                    Protocol = "openai",
                    Enabled = true,
                });

            // 对照物：同一个用途下 transcript 那条线路更健康、顺位更靠前。
            // 不点名时解析会选它——这正是「pinned 不该被顶替」要防的那个顶替动作。
            // 这里原本建的是模型池（成员顺位 + 成员健康）；池退场后换成对外模型 + 两条线路，
            // 要验的事没变，且比原来强一档：原用例只断言 pinned 的结果，没有先证明
            // 「不 pinned 时确实会选到另一个」，那样它可能只是在测「这条线路能解析」。
            await InsertAsync(gatewayData.Database, "llmgw_logical_models", new GatewayLogicalModel
            {
                Id = logicalModelId,
                PublicId = "asr-stable",
                PublicIdNormalized = "asr-stable",
                Name = "ASR 稳定转写",
                ModelType = ModelTypes.Asr,
                Capabilities = ["asr"],
                IsDefaultForType = true,
                Enabled = true,
            });
            await InsertAsync(gatewayData.Database, "llmgw_model_offerings", new GatewayModelOffering
            {
                Id = "asr-stable-offering-transcript",
                LogicalModelId = logicalModelId,
                TargetId = "transcript-model-id",
                TargetKind = "model",
                UpstreamModelId = transcriptModel,
                Protocol = "openai",
                Enabled = true,
                Priority = 0,
                HealthStatus = ModelHealthStatus.Healthy,
            });
            await InsertAsync(gatewayData.Database, "llmgw_model_offerings", new GatewayModelOffering
            {
                Id = "asr-stable-offering-audio",
                LogicalModelId = logicalModelId,
                TargetId = "audio-model-id",
                TargetKind = "model",
                UpstreamModelId = audioModel,
                Protocol = "openai-chat-audio",
                Enabled = true,
                Priority = 1,
                HealthStatus = ModelHealthStatus.Unavailable,
                // 刚失败过 → 还在冷却期内，不会被半开试探抓去排到队首。
                // 不设这个字段的话 LastFailedAt 是 null，解析器判它「冷却早就过了」，
                // 于是这条不可用线路反而成了队首探针，不点名时解析到的是它——
                // 对照物就此失效（形状 4b：用例还是绿的，但它测的不是要测的那件事）。
                LastFailedAt = DateTime.UtcNow,
            });

            var resolver = new ModelResolver(
                mapData,
                configuration,
                NullLogger<ModelResolver>.Instance,
                gatewayData);

            // 先把对照物摆出来：不点名时解析确实会走到那条更健康的线路。
            var unpinned = await resolver.ResolveAsync(caller, ModelTypes.Asr);
            unpinned.Success.ShouldBeTrue(unpinned.ErrorMessage);
            unpinned.ActualModel.ShouldBe(
                transcriptModel,
                "对照物不成立的话，下面那条「pinned 没被顶替」就测不到东西了——它可能只是这里根本没有别的候选");

            var result = await resolver.ResolveAsync(
                caller,
                ModelTypes.Asr,
                expectedModel: audioModel,
                pinnedPlatformId: audioPlatformId,
                pinnedModelId: audioModel);

            result.Success.ShouldBeTrue(result.ErrorMessage);
            result.ResolutionType.ShouldBe(
                "PinnedModel",
                "钉死具体上游是精确语义，不经过对外模型目录——走目录就意味着它可能被换掉");
            result.ActualPlatformId.ShouldBe(audioPlatformId);
            result.ActualModel.ShouldBe(audioModel);
            result.ActualModel.ShouldNotBe(transcriptModel);
            result.ApiUrl.ShouldBe("https://audio-model.example.test/v1");
            result.ApiKey.ShouldBe("sk-test-model");
            // 协议取自**模型文档**，不是线路。线路上写的是 openai-chat-audio，两者刻意不同：
            // 这一条钉住「pinned 绕过对外模型目录直取上游」——读到线路的协议就说明它其实走了目录。
            result.Protocol.ShouldBe("openai-model-protocol");
            result.PlatformType.ShouldBe("openai");
            result.RetryCandidates.ShouldBeNull();

            var models = gatewayData.Database.GetCollection<BsonDocument>("llmgw_models");
            var platforms = gatewayData.Database.GetCollection<BsonDocument>("llmgw_platforms");
            var audioModelFilter = Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TenantId", GatewayTenantDefaults.InternalTenantId),
                Builders<BsonDocument>.Filter.Eq("PlatformId", audioPlatformId),
                Builders<BsonDocument>.Filter.Eq("ModelName", audioModel));
            var audioPlatformFilter = Builders<BsonDocument>.Filter.And(
                Builders<BsonDocument>.Filter.Eq("TenantId", GatewayTenantDefaults.InternalTenantId),
                Builders<BsonDocument>.Filter.Eq("_id", audioPlatformId));

            await models.UpdateOneAsync(
                audioModelFilter,
                Builders<BsonDocument>.Update.Unset("ApiUrl"));
            await platforms.UpdateOneAsync(
                audioPlatformFilter,
                Builders<BsonDocument>.Update.Set("ApiUrl", string.Empty));
            var missingUrl = await resolver.ResolveAsync(
                caller,
                ModelTypes.Asr,
                expectedModel: audioModel,
                pinnedPlatformId: audioPlatformId,
                pinnedModelId: audioModel);
            missingUrl.Success.ShouldBeFalse();
            missingUrl.ErrorMessage.ShouldNotBeNull();
            missingUrl.ErrorMessage.ShouldContain("API URL 配置不完整");

            await models.UpdateOneAsync(
                audioModelFilter,
                Builders<BsonDocument>.Update
                    .Set("ApiUrl", "https://audio-model.example.test/v1")
                    .Unset("ApiKeyEncrypted"));
            await platforms.UpdateOneAsync(
                audioPlatformFilter,
                Builders<BsonDocument>.Update
                    .Set("ApiUrl", "https://openrouter.example.test/api/v1")
                    .Set("ApiKeyEncrypted", string.Empty));
            var missingKey = await resolver.ResolveAsync(
                caller,
                ModelTypes.Asr,
                expectedModel: audioModel,
                pinnedPlatformId: audioPlatformId,
                pinnedModelId: audioModel);
            missingKey.Success.ShouldBeFalse();
            missingKey.ErrorMessage.ShouldNotBeNull();
            missingKey.ErrorMessage.ShouldContain("API Key 配置不完整");
        }
        finally
        {
            await client.DropDatabaseAsync(gatewayDatabaseName);
            await client.DropDatabaseAsync(mapDatabaseName);
        }
    }

    private static async Task InsertAsync<T>(IMongoDatabase database, string collectionName, T value)
    {
        var document = value!.ToBsonDocument();
        document["TenantId"] = GatewayTenantDefaults.InternalTenantId;
        await database.GetCollection<BsonDocument>(collectionName).InsertOneAsync(document);
    }

    private static async Task InsertTenantDocumentAsync<T>(
        IMongoDatabase database,
        string collectionName,
        T value)
    {
        var document = value!.ToBsonDocument();
        document["TenantId"] = GatewayTenantDefaults.InternalTenantId;
        if (collectionName == "llmgw_models")
        {
            // 名录门（ModelResolver）只认「在内置名录里」或「有放行标记」两种模型。
            // 这两条 ASR 模型都是名录外的临时标识，在真实部署里它们会带着放行标记
            // ——要么是管理员导入时显式勾的，要么是名录门上线时的存量迁移补的。
            // 这里照那个形态铺，测的才是「pinned 成员不会被换掉」，不是「名录门存不存在」。
            document["AllowedOutsideCatalog"] = true;
            document["AllowedOutsideCatalogBy"] = "测试夹具（等价于存量迁移补的标记）";
        }
        await database.GetCollection<BsonDocument>(collectionName).InsertOneAsync(document);
    }
}
