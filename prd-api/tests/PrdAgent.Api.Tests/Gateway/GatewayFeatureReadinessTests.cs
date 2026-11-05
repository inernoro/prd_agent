using System.Diagnostics;
using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Moq;
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
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    [InlineData(null)]
    public async Task ThinkingRequirement_ProbeAndActualGatewayAgree_ForSameMetadata(bool? supportsThinking)
    {
        var resolution = new ModelResolutionResult
        {
            Success = true, ActualModel = "future-thinking-readiness-fixture", ResolutionType = "Pinned",
            ActualPlatformId = "fixture-platform", PlatformType = "openai", Protocol = "openai",
            ApiUrl = "https://never-called.example.test/v1", ApiKey = "fixture",
            SupportsThinking = supportsThinking,
            ParameterCapabilities = new() { ["temperature"] = true },
        };
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(x => x.ResolveMetadataAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>())).ReturnsAsync(resolution);
        resolver.Setup(x => x.ResolveAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<string?>(),
            It.IsAny<string?>(), It.IsAny<string?>(), It.IsAny<CancellationToken>())).ReturnsAsync(resolution);
        var upstream = new ThinkingFixtureUpstream();
        var gateway = new LlmGateway(resolver.Object, upstream, NullLogger<LlmGateway>.Instance);
        var metadata = await gateway.ResolveModelMetadataAsync(Stream, "chat");
        metadata.Success.ShouldBeTrue(); // 能路由与满足本用途的请求能力是两条独立判据。
        metadata.SupportsThinking.ShouldBe(supportsThinking);

        using var checks = await ProbeMetadataAsync(metadata);
        var sync = checks.RootElement.EnumerateArray().Single(x => x.GetProperty("appCallerCode").GetString() == Polish);
        var stream = checks.RootElement.EnumerateArray().Single(x => x.GetProperty("appCallerCode").GetString() == Stream);
        sync.GetProperty("requiresThinking").GetBoolean().ShouldBeFalse();
        sync.GetProperty("ok").GetBoolean().ShouldBeTrue();
        stream.GetProperty("requiresThinking").GetBoolean().ShouldBeTrue();
        stream.GetProperty("ok").GetBoolean().ShouldBe(supportsThinking != false);

        var chunks = new List<GatewayStreamChunk>();
        await foreach (var chunk in gateway.StreamAsync(new GatewayRequest
        {
            AppCallerCode = Stream, ModelType = "chat", IncludeThinking = true,
            RequestBody = new JsonObject
            {
                ["messages"] = new JsonArray(new JsonObject { ["role"] = "user", ["content"] = "fixture" }),
                ["temperature"] = 0.4, ["max_tokens"] = 2048,
            },
        })) chunks.Add(chunk);
        if (supportsThinking == false)
        {
            var error = chunks.Single(x => x.Type == GatewayChunkType.Error);
            error.ErrorCode.ShouldBe("THINKING_UNSUPPORTED");
            stream.GetProperty("failureCode").GetString().ShouldBe(error.ErrorCode);
            upstream.Calls.ShouldBe(0, "明确不支持时在真实 Gateway 能力门禁处拒绝，不发送上游请求");
        }
        else
        {
            chunks.ShouldNotContain(x => x.Type == GatewayChunkType.Error);
            chunks.ShouldContain(x => x.Type == GatewayChunkType.Done);
            upstream.Calls.ShouldBe(1); // true/null 都沿现有非 strict 策略执行，handler 仅在内存返回。
        }
    }

    private static async Task<JsonDocument> ProbeMetadataAsync(GatewayModelResolution metadata)
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root != null && !File.Exists(Path.Combine(root.FullName, "scripts", "llmgw-serving-probe.py")))
            root = root.Parent;
        root.ShouldNotBeNull();
        var start = new ProcessStartInfo("python3")
        {
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add("-c");
        start.ArgumentList.Add("""
            import importlib.util,json,sys
            spec=importlib.util.spec_from_file_location('probe',sys.argv[1])
            probe=importlib.util.module_from_spec(spec)
            spec.loader.exec_module(probe)
            metadata=json.load(sys.stdin)
            probe._request=lambda *args,**kwargs:(200,json.dumps(metadata),0)
            print(json.dumps(probe._check_feature_routes('http://not-called','fixture',probe._feature_routes(['defect-agent']))))
            """);
        start.ArgumentList.Add(Path.Combine(root.FullName, "scripts", "llmgw-serving-probe.py"));
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync();
        var error = process.StandardError.ReadToEndAsync();
        await process.StandardInput.WriteAsync(JsonSerializer.Serialize(metadata));
        process.StandardInput.Close();
        await process.WaitForExitAsync();
        process.ExitCode.ShouldBe(0, await error);
        return JsonDocument.Parse(await output);
    }

    private sealed class ThinkingFixtureUpstream : IHttpClientFactory
    {
        public int Calls;
        public HttpClient CreateClient(string name) => new(new Handler(this));
        private sealed class Handler(ThinkingFixtureUpstream owner) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                owner.Calls++;
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("data: {\"choices\":[{\"delta\":{\"content\":\"fixture\"}}]}\n\ndata: [DONE]\n\n"),
                });
            }
        }
    }

}
