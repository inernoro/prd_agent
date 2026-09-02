using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class VisualLogicalModelCatalogTests
{
    [Theory]
    [InlineData(AppCallerRegistry.VisualAgent.Image.Text2Img)]
    [InlineData(AppCallerRegistry.VisualAgent.Image.Img2Img)]
    [InlineData(AppCallerRegistry.VisualAgent.Image.VisionGen)]
    public async Task StrictPool_ExposesBusinessChoices_AndResolvesSelectedIdentity(string caller)
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
        var client = new MongoClient(connection);
        var gatewayName = $"visual_catalog_{Guid.NewGuid():N}";
        var mapName = $"visual_catalog_map_{Guid.NewGuid():N}";
        var gateway = new LlmGatewayDataContext(connection, gatewayName);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ApiKeyCrypto:Secret"] = "visual-model-catalog-test-only-2026",
        }).Build();
        async Task Insert<T>(string collection, T value)
        {
            var doc = value!.ToBsonDocument();
            doc["TenantId"] = GatewayTenantDefaults.InternalTenantId;
            await gateway.Database.GetCollection<BsonDocument>(collection).InsertOneAsync(doc);
        }

        try
        {
            await Insert("llmgw_app_callers", new GatewayAppCallerRecord
            {
                AppCallerCode = caller, RequestType = "generation", Status = "configured",
                AllowedModelPoolIds = ["allowed-pool"], DefaultModelPoolId = "allowed-pool",
            });
            await Insert("llmgw_platforms", new LLMPlatform
            {
                Id = "provider", Name = "测试上游", PlatformType = "openai", Enabled = true,
                ApiUrl = "https://image.example.test/v1", ApiKeyEncrypted = ApiKeyCryptoKeyRing.Encrypt("test-key", config),
            });
            await Insert("llmgw_model_pools", new ModelGroup
            {
                Id = "allowed-pool", Name = "图片生成默认池", Code = "default-generation", ModelType = "generation",
                Models = [
                    new ModelGroupItem { PlatformId = "provider", ModelId = "gpt-image-1", HealthStatus = ModelHealthStatus.Healthy },
                    new ModelGroupItem { PlatformId = "provider", ModelId = "gpt-image-2", HealthStatus = ModelHealthStatus.Healthy },
                ],
            });
            foreach (var (id, upstream, order) in new[] { ("image1", "gpt-image-1", 20), ("image2", "gpt-image-2", 10), ("outside", "outside-model", 0) })
            {
                await Insert("llmgw_models", new LLMModel
                {
                    Id = id + "-upstream", ModelName = upstream, PlatformId = "provider", Enabled = true, Protocol = "openai",
                });
                await Insert("llmgw_logical_models", new GatewayLogicalModel
                {
                    Id = id, PublicId = id, PublicIdNormalized = id, Name = id, ModelType = "generation",
                    Description = id + " 的业务用途",
                    Capabilities = ["image_generation", "text2img", "img2img", "vision_generation"],
                    AllowedAppCallerCodes = [caller], DisplayOrder = order,
                });
                await Insert("llmgw_model_offerings", new GatewayModelOffering
                {
                    Id = id + "-offering", LogicalModelId = id, TargetId = id + "-upstream", Protocol = "openai",
                });
            }

            var resolver = new ModelResolver(new MongoDbContext(connection, mapName), config, NullLogger<ModelResolver>.Instance, gateway);
            var catalog = await resolver.GetAvailablePoolsAsync(caller, "generation");
            Assert.Equal(new[] { "image2", "image1" }, catalog.Select(x => x.Code));
            Assert.All(catalog, item => Assert.Equal("LogicalModel", item.ResolutionType));
            Assert.True(catalog[0].IsDefault);
            Assert.Equal("image2 的业务用途", catalog[0].Description);
            Assert.False(catalog[1].IsDefault);
            foreach (var choice in catalog)
            {
                var resolved = await resolver.ResolveAsync(caller, "generation", choice.Code);
                Assert.True(resolved.Success, resolved.ErrorMessage);
                Assert.Equal(choice.Code, resolved.LogicalModelPublicId);
                Assert.Equal(choice.Code == "image1" ? "gpt-image-1" : "gpt-image-2", resolved.ActualModel);
            }
            var outside = await resolver.ResolveAsync(caller, "generation", "outside");
            Assert.False(outside.Success);

            await gateway.Database.GetCollection<GatewayLogicalModel>("llmgw_logical_models")
                .UpdateManyAsync(FilterDefinition<GatewayLogicalModel>.Empty, Builders<GatewayLogicalModel>.Update.Set(x => x.Enabled, false));
            Assert.Empty(await resolver.GetAvailablePoolsAsync(caller, "generation"));
        }
        finally
        {
            await client.DropDatabaseAsync(gatewayName);
            await client.DropDatabaseAsync(mapName);
        }
    }
}
