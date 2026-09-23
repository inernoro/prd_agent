using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.ImageGen;
using PrdAgent.Infrastructure.Security;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class VisualLogicalModelCatalogTests
{
    [Fact]
    public void MapCatalog_UsesGatewayCapabilitySnapshot_WithoutKnowingUpstreamModelName()
    {
        var model = new AvailableModelPool
        {
            Id = "dynamic",
            Code = "dynamic-public-id",
            Name = "动态模型",
            ResolutionType = "LogicalModel",
            Models =
            [
                new PoolModelInfo
                {
                    ModelId = "dynamic-public-id",
                    PlatformId = "logical-model",
                    ActualModelId = "a-model-map-has-never-seen",
                    ImageCapabilities = new GatewayImageCapabilitiesSnapshot
                    {
                        SizeConstraintType = "whitelist",
                        SizeParamFormat = "WxH",
                        SizesByResolution = new Dictionary<string, List<string>>
                        {
                            ["custom"] = ["1024x1024", "1536x1024", "bad-size"],
                        },
                        SupportsImageToImage = true,
                    },
                },
            ],
        };

        var info = GatewayImageModelCatalog.Describe(model);

        Assert.NotNull(info);
        Assert.True(info.SupportsImageToImage);
        Assert.Equal(new[] { "1024x1024", "1536x1024" }, info.SizesByResolution["custom"].Select(x => x.Size));
        Assert.Equal(new[] { "1:1", "3:2" }, info.SizesByResolution["custom"].Select(x => x.AspectRatio));
    }

    [Fact]
    public void MapCatalog_DoesNotInferCapabilitiesFromActualModelName()
    {
        var model = new AvailableModelPool
        {
            Id = "legacy",
            Code = "legacy-public-id",
            Name = "旧目录项",
            ResolutionType = "LogicalModel",
            Models =
            [
                new PoolModelInfo
                {
                    ModelId = "legacy-public-id",
                    PlatformId = "logical-model",
                    ActualModelId = "gpt-image-1",
                },
            ],
        };

        Assert.Null(GatewayImageModelCatalog.Describe(model));
    }

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
            // 这条测试的不变量是「不该被这个调用方选到的模型，既不出现在清单里、也解析不出来」。
            //
            // 旧架构靠模型池表达它：池里没有的物理模型选不到。池退场之后，「谁能选什么」
            // 由对外模型的放行名单回答，所以 outside 换成**没有放行给这个调用方**——
            // 同一个不变量，换了它在新架构里的表达方式，不是把判据放宽。
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
                    AllowedAppCallerCodes = id == "outside" ? ["someone-else.agent::generation"] : [caller],
                    DisplayOrder = order,
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
            Assert.Equal("gpt-image-2", Assert.Single(catalog[0].Models).ActualModelId);
            Assert.Equal("gpt-image-1", Assert.Single(catalog[1].Models).ActualModelId);
            Assert.All(catalog, item => Assert.NotNull(Assert.Single(item.Models).ImageCapabilities));
            foreach (var choice in catalog)
            {
                var resolved = await resolver.ResolveAsync(caller, "generation", choice.Code);
                Assert.True(resolved.Success, resolved.ErrorMessage);
                Assert.Equal(choice.Code, resolved.LogicalModelPublicId);
                Assert.Equal(choice.Code == "image1" ? "gpt-image-1" : "gpt-image-2", resolved.ActualModel);
            }
            // 没放行给这个调用方的模型：点名也选不到。
            var outside = await resolver.ResolveAsync(caller, "generation", "outside");
            Assert.False(outside.Success);

            // 目录与参数面板属于只读路径：即使线路已进入可半开探测窗口，也只能读取
            // 解析能力快照，不能抢占真正业务请求需要的恢复租约。
            var offerings = gateway.Database.GetCollection<GatewayModelOffering>("llmgw_model_offerings");
            await offerings.UpdateOneAsync(
                x => x.Id == "image2-offering",
                Builders<GatewayModelOffering>.Update
                    .Set(x => x.HealthStatus, ModelHealthStatus.Unavailable)
                    .Set(x => x.LastFailedAt, DateTime.UtcNow.AddHours(-1))
                    .Unset(x => x.HalfOpenLeaseUntil));
            var halfOpenCatalog = await resolver.GetAvailablePoolsAsync(caller, "generation");
            var halfOpenMember = Assert.Single(halfOpenCatalog[0].Models);
            Assert.Equal("gpt-image-2", halfOpenMember.ActualModelId);
            Assert.Equal("Unavailable", halfOpenMember.HealthStatus);
            Assert.Equal(0, halfOpenMember.HealthScore);
            var afterCatalogRead = await offerings.Find(x => x.Id == "image2-offering").SingleAsync();
            Assert.Null(afterCatalogRead.HalfOpenLeaseUntil);
            var recoveryAttempt = await resolver.ResolveAsync(caller, "generation", "image2");
            Assert.True(recoveryAttempt.Success, recoveryAttempt.ErrorMessage);
            var afterRecoveryAttempt = await offerings.Find(x => x.Id == "image2-offering").SingleAsync();
            Assert.NotNull(afterRecoveryAttempt.HalfOpenLeaseUntil);

            await offerings
                .UpdateManyAsync(
                    FilterDefinition<GatewayModelOffering>.Empty,
                    Builders<GatewayModelOffering>.Update
                        .Set(x => x.HealthStatus, ModelHealthStatus.Unavailable)
                        .Set(x => x.LastFailedAt, DateTime.UtcNow));
            var unavailableCatalog = await resolver.GetAvailablePoolsAsync(caller, "generation");
            Assert.Equal(new[] { "image2", "image1" }, unavailableCatalog.Select(x => x.Code));
            Assert.All(unavailableCatalog, item =>
                Assert.Equal("Unavailable", Assert.Single(item.Models).HealthStatus));
            Assert.False((await resolver.ResolveAsync(caller, "generation", "image2")).Success);

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
