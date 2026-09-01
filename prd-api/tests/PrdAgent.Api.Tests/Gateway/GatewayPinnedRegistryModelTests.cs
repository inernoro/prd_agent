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
            const string poolId = "asr-stable-pool";
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
                    ModelPoolId = poolId,
                });

            var pool = new ModelGroup
            {
                Id = poolId,
                Name = "ASR 稳定转写",
                Code = "asr-stable",
                ModelType = ModelTypes.Asr,
                Models =
                [
                    new ModelGroupItem
                    {
                        PlatformId = transcriptPlatformId,
                        ModelId = transcriptModel,
                        Priority = 0,
                        HealthStatus = ModelHealthStatus.Healthy,
                    },
                    new ModelGroupItem
                    {
                        PlatformId = audioPlatformId,
                        ModelId = audioModel,
                        Protocol = "openai-chat-audio",
                        Priority = 1,
                        HealthStatus = ModelHealthStatus.Unavailable,
                    },
                ],
            };
            var poolDocument = pool.ToBsonDocument();
            poolDocument["TenantId"] = GatewayTenantDefaults.InternalTenantId;
            await gatewayData.Database
                .GetCollection<BsonDocument>("llmgw_model_pools")
                .InsertOneAsync(poolDocument);

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

            var resolver = new ModelResolver(
                mapData,
                configuration,
                NullLogger<ModelResolver>.Instance,
                gatewayData);

            var result = await resolver.ResolveAsync(
                caller,
                ModelTypes.Asr,
                expectedModel: audioModel,
                pinnedPlatformId: audioPlatformId,
                pinnedModelId: audioModel);

            result.Success.ShouldBeTrue(result.ErrorMessage);
            result.ResolutionType.ShouldBe("GatewayRegistryPool");
            result.ModelGroupId.ShouldBe(poolId);
            result.ActualPlatformId.ShouldBe(audioPlatformId);
            result.ActualModel.ShouldBe(audioModel);
            result.ActualModel.ShouldNotBe(transcriptModel);
            result.ApiUrl.ShouldBe("https://audio-model.example.test/v1");
            result.ApiKey.ShouldBe("sk-test-model");
            result.Protocol.ShouldBe("openai-chat-audio");
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
