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

/// <summary>发布配置检查必须与真实解析结论一致；负面配置只写随机隔离库。</summary>
public sealed class GatewayFeatureReadinessTests
{
    private const string Tenant = GatewayTenantDefaults.InternalTenantId;
    private const string Polish = "defect-agent.polish::chat";
    private const string Stream = "defect-agent.polish-stream::chat";
    private static readonly string[] ExistingFive =
    [
        "prd-agent-web.web-hosting.generate-html::chat", "prd-agent-web.web-hosting.edit-html::chat",
        "md-to-ppt-agent.outline::chat", "md-to-ppt-agent.html-generate::chat", "prd-agent-web.web-hosting.ask::chat",
    ];

    [Theory]
    [InlineData("authorization")]
    [InlineData("disabled-model")]
    [InlineData("disabled-offering")]
    [InlineData("unavailable-offering")]
    [InlineData("capability")]
    public async Task IsolatedConfiguration_FailsBothPredicates_ThenRecovers(string fault)
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
        var client = new MongoClient(connection);
        var gatewayName = $"gw_feature_{Guid.NewGuid():N}";
        var mapName = $"map_feature_{Guid.NewGuid():N}";
        var gateway = new LlmGatewayDataContext(connection, gatewayName);
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:InternalTenantId"] = Tenant,
            ["ApiKeyCrypto:Secret"] = "isolated-feature-readiness-test-secret",
        }).Build();
        var resolver = new ModelResolver(new MongoDbContext(connection, mapName), config,
            NullLogger<ModelResolver>.Instance, gateway);
        var image = fault == "capability";
        var caller = image ? "visual-agent.image.text2img::generation" : Polish;
        var type = image ? "generation" : "chat";
        var logical = new GatewayLogicalModel
        {
            Id = "logical", PublicId = "default-chat-curated", PublicIdNormalized = "default-chat-curated",
            ModelType = type, IsDefaultForType = true, Enabled = true,
            Capabilities = image ? [GatewayCapabilityContract.ImageGeneration] : ["chat"],
            AllowedAppCallerCodes = image ? [caller] : [.. ExistingFive, Polish, Stream],
        };
        var offering = new GatewayModelOffering
        {
            Id = "offering", LogicalModelId = logical.Id, TargetId = "physical", TargetKind = "model",
            Protocol = "openai", Enabled = true, HealthStatus = ModelHealthStatus.Healthy,
        };
        async Task Save<T>(string collection, T value)
        {
            var doc = value!.ToBsonDocument();
            doc["TenantId"] = Tenant;
            await gateway.Database.GetCollection<BsonDocument>(collection).ReplaceOneAsync(
                new BsonDocument("_id", doc["_id"]), doc, new ReplaceOptions { IsUpsert = true });
        }
        async Task<string> RoutingDocuments()
        {
            var collections = new[] { "llmgw_logical_models", "llmgw_model_offerings", "llmgw_platforms", "llmgw_models" };
            var all = new List<string>();
            foreach (var collection in collections)
                all.Add((await gateway.Database.GetCollection<BsonDocument>(collection)
                    .Find(FilterDefinition<BsonDocument>.Empty).ToListAsync()).ToJson());
            return string.Join("\n", all);
        }
        async Task AssertSame(bool expected)
        {
            var before = await RoutingDocuments();
            var metadata = await resolver.ResolveMetadataAsync(caller, type);
            metadata.Success.ShouldBe(expected, metadata.ErrorMessage);
            (await RoutingDocuments()).ShouldBe(before, "metadata probe must not alter health, leases or route configuration");
            var execution = await resolver.ResolveAsync(caller, type);
            execution.Success.ShouldBe(metadata.Success);
            execution.FailureCode.ShouldBe(metadata.FailureCode);
            if (expected) execution.LogicalModelPublicId.ShouldBe(metadata.LogicalModelPublicId);
        }
        try
        {
            await Save("llmgw_platforms", new LLMPlatform
            {
                Id = "platform", Name = "fixture", PlatformType = "openai", ApiUrl = "https://never-called.example.test/v1",
                ApiKeyEncrypted = ApiKeyCryptoKeyRing.Encrypt("test-key", config), Enabled = true,
            });
            await Save("llmgw_models", new LLMModel
            {
                Id = "physical", Name = "fixture", ModelName = "fixture", PlatformId = "platform", Protocol = "openai", Enabled = true,
            });
            await Save("llmgw_logical_models", logical);
            await Save("llmgw_model_offerings", offering);
            await AssertSame(true);

            if (fault == "authorization") logical.AllowedAppCallerCodes = [.. ExistingFive];
            if (fault == "disabled-model") logical.Enabled = false;
            if (fault == "disabled-offering") offering.Enabled = false;
            if (fault == "unavailable-offering")
            {
                offering.HealthStatus = ModelHealthStatus.Unavailable;
                offering.LastFailedAt = DateTime.UtcNow;
            }
            if (fault == "capability") logical.Capabilities = [GatewayCapabilityContract.Img2Img];
            await Save("llmgw_logical_models", logical);
            await Save("llmgw_model_offerings", offering);
            await AssertSame(false);
            if (fault == "authorization")
            {
                (await resolver.ResolveMetadataAsync(Stream, type)).Success.ShouldBeFalse();
                foreach (var unaffected in ExistingFive)
                    (await resolver.ResolveMetadataAsync(unaffected, type)).Success.ShouldBeTrue();
            }

            logical.Enabled = true;
            logical.AllowedAppCallerCodes = image ? [caller] : [.. ExistingFive, Polish, Stream];
            logical.Capabilities = image ? [GatewayCapabilityContract.ImageGeneration] : ["chat"];
            offering.Enabled = true;
            offering.HealthStatus = ModelHealthStatus.Healthy;
            offering.LastFailedAt = null;
            await Save("llmgw_logical_models", logical);
            await Save("llmgw_model_offerings", offering);
            await AssertSame(true);
            if (!image)
            {
                (await resolver.ResolveMetadataAsync(Stream, type)).Success.ShouldBeTrue();
                foreach (var unaffected in ExistingFive)
                    (await resolver.ResolveMetadataAsync(unaffected, type)).Success.ShouldBeTrue();
            }
        }
        finally
        {
            await client.DropDatabaseAsync(gatewayName);
            await client.DropDatabaseAsync(mapName);
        }
    }
}
