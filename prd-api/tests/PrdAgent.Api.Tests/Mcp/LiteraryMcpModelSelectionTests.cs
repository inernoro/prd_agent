using MongoDB.Driver;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services.Mcp;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

public sealed class LiteraryMcpModelSelectionTests
{
    [Fact]
    public async Task ApiKeyModelModePersistsAndFollowModeClearsFixedModel()
    {
        var (db, connection, name) = CreateDatabase("persist");
        try
        {
            await db.AgentApiKeys.InsertOneAsync(new AgentApiKey
            {
                Id = "key-writer",
                OwnerUserId = "writer",
            });
            var service = new AgentApiKeyService(db, NullLogger<AgentApiKeyService>.Instance);

            await service.UpdateMetadataAsync(
                "key-writer", null, null, null, null, CancellationToken.None,
                literaryImageModel: new AgentApiKeyLiteraryImageModelPatch(
                    McpLiteraryImageModelMode.Fixed,
                    " gpt-image-2.5-sunburst "));
            var fixedKey = await service.GetByIdAsync("key-writer", CancellationToken.None);
            Assert.NotNull(fixedKey);
            Assert.Equal(McpLiteraryImageModelMode.Fixed, fixedKey.McpLiteraryImageModelMode);
            Assert.Equal("gpt-image-2.5-sunburst", fixedKey.McpLiteraryImageModelPublicId);

            await service.UpdateMetadataAsync(
                "key-writer", null, null, null, null, CancellationToken.None,
                literaryImageModel: new AgentApiKeyLiteraryImageModelPatch(
                    McpLiteraryImageModelMode.FollowUserPanel,
                    "must-be-cleared"));
            var followKey = await service.GetByIdAsync("key-writer", CancellationToken.None);
            Assert.NotNull(followKey);
            Assert.Equal(McpLiteraryImageModelMode.FollowUserPanel, followKey.McpLiteraryImageModelMode);
            Assert.Null(followKey.McpLiteraryImageModelPublicId);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task LiteraryAdapterInfoUsesLiteraryCatalogInsteadOfVisualPolicy()
    {
        var (db, connection, name) = CreateDatabase("adapter");
        try
        {
            var gateway = Gateway();
            gateway.Setup(x => x.GetAvailablePoolsAsync(
                    AppCallerRegistry.LiteraryAgent.Illustration.Text2Img,
                    ModelTypes.ImageGen,
                    It.IsAny<CancellationToken>()))
                .ReturnsAsync([
                    new AvailableModelPool
                    {
                        Id = "image2",
                        Code = "gpt-image-2",
                        Name = "GPT Image 2",
                        ResolutionType = "LogicalModel",
                        Capabilities = [GatewayCapabilityContract.ImageGeneration],
                        Models =
                        [
                            new PoolModelInfo
                            {
                                ModelId = "gpt-image-2",
                                PlatformId = "logical-model",
                                ImageCapabilities = new GatewayImageCapabilitiesSnapshot
                                {
                                    SizeConstraintType = "whitelist",
                                    SizeConstraintDescription = "固定尺寸",
                                    SizesByResolution = new() { ["1k"] = ["1024x1024"] },
                                    SupportsImageToImage = true,
                                },
                            },
                        ],
                    },
                ]);
            var controller = new LiteraryAgentImageGenController(
                db, null!, gateway.Object, NullLogger<LiteraryAgentImageGenController>.Instance)
            {
                ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
            };
            controller.HttpContext.User = new System.Security.Claims.ClaimsPrincipal(
                new System.Security.Claims.ClaimsIdentity(
                    [new System.Security.Claims.Claim("sub", "writer")], "Bearer"));

            var result = await controller.GetAdapterInfo("gpt-image-2", CancellationToken.None);

            var ok = Assert.IsType<OkObjectResult>(result);
            var json = System.Text.Json.JsonSerializer.SerializeToElement(
                Assert.IsType<ApiResponse<object>>(ok.Value).Data);
            Assert.Equal("gpt-image-2", json.GetProperty("modelId").GetString());
            Assert.True(json.GetProperty("SupportsImageToImage").GetBoolean());
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task FollowModeUsesPanelPreferenceAndReturnsLogicalPublicId()
    {
        var (db, connection, name) = CreateDatabase("follow");
        try
        {
            await db.AgentApiKeys.InsertOneAsync(new AgentApiKey
            {
                Id = "key-writer",
                OwnerUserId = "writer",
                McpLiteraryImageModelMode = McpLiteraryImageModelMode.FollowUserPanel,
            });
            await db.UserPreferences.InsertOneAsync(new UserPreferences
            {
                UserId = "writer",
                LiteraryAgentPreferences = new LiteraryAgentPreferences { ImageModelId = "pool_preferred-id" },
            });
            var gateway = Gateway();
            gateway.Setup(x => x.GetAvailablePoolsAsync(
                    AppCallerRegistry.LiteraryAgent.Illustration.Text2Img,
                    ModelTypes.ImageGen,
                    It.IsAny<CancellationToken>()))
                .ReturnsAsync([
                    new AvailableModelPool { Id = "preferred-id", Code = "gpt-image-2" },
                    new AvailableModelPool { Id = "default-id", Code = "gpt-image-2.5-sunburst", IsDefault = true },
                ]);
            var service = new LiteraryMcpModelSelectionService(db, gateway.Object, Microsoft.Extensions.Logging.Abstractions.NullLogger<LiteraryMcpModelSelectionService>.Instance);

            var selected = await service.ResolveForRunAsync(
                "writer", "key-writer", AppCallerRegistry.LiteraryAgent.Illustration.Text2Img, CancellationToken.None);

            Assert.True(selected.Success);
            Assert.Equal("gpt-image-2", selected.LogicalModelPublicId);
            gateway.Verify(x => x.ResolveRequiredLogicalModelAsync(
                AppCallerRegistry.LiteraryAgent.Illustration.Text2Img,
                ModelTypes.ImageGen,
                "gpt-image-2", It.IsAny<CancellationToken>()), Times.Never);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task FollowModeWithoutPreferenceUsesCurrentDefault()
    {
        var (db, connection, name) = CreateDatabase("default");
        try
        {
            await db.AgentApiKeys.InsertOneAsync(new AgentApiKey
            {
                Id = "key-writer", OwnerUserId = "writer",
            });
            var gateway = Gateway();
            gateway.Setup(x => x.GetAvailablePoolsAsync(
                    AppCallerRegistry.LiteraryAgent.Illustration.Text2Img,
                    ModelTypes.ImageGen,
                    It.IsAny<CancellationToken>()))
                .ReturnsAsync([new AvailableModelPool { Code = "gpt-image-2", IsDefault = true }]);
            var service = new LiteraryMcpModelSelectionService(db, gateway.Object, Microsoft.Extensions.Logging.Abstractions.NullLogger<LiteraryMcpModelSelectionService>.Instance);

            var selected = await service.ResolveForRunAsync(
                "writer", "key-writer", AppCallerRegistry.LiteraryAgent.Illustration.Text2Img, CancellationToken.None);

            Assert.True(selected.Success);
            Assert.Equal("gpt-image-2", selected.LogicalModelPublicId);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task FixedModeIgnoresPanelPreferenceAndUnavailableModelDoesNotFallback()
    {
        var (db, connection, name) = CreateDatabase("fixed");
        try
        {
            await db.AgentApiKeys.InsertOneAsync(new AgentApiKey
            {
                Id = "key-writer",
                OwnerUserId = "writer",
                McpLiteraryImageModelMode = McpLiteraryImageModelMode.Fixed,
                McpLiteraryImageModelPublicId = "gpt-image-2.5-sunburst",
            });
            await db.UserPreferences.InsertOneAsync(new UserPreferences
            {
                UserId = "writer",
                LiteraryAgentPreferences = new LiteraryAgentPreferences { ImageModelId = "pool-gpt-image-2" },
            });
            var gateway = Gateway();
            gateway.Setup(x => x.GetAvailablePoolsAsync(
                    AppCallerRegistry.LiteraryAgent.Illustration.Img2Img,
                    ModelTypes.ImageGen, It.IsAny<CancellationToken>()))
                .ReturnsAsync([new AvailableModelPool { Code = "gpt-image-2", IsDefault = true }]);
            var service = new LiteraryMcpModelSelectionService(db, gateway.Object, Microsoft.Extensions.Logging.Abstractions.NullLogger<LiteraryMcpModelSelectionService>.Instance);

            var selected = await service.ResolveForRunAsync(
                "writer", "key-writer", AppCallerRegistry.LiteraryAgent.Illustration.Img2Img, CancellationToken.None);

            Assert.False(selected.Success);
            Assert.Equal("MODEL_UNAVAILABLE", selected.ErrorCode);
            Assert.Contains("没有自动切换", selected.ErrorMessage);
            gateway.Verify(x => x.GetAvailablePoolsAsync(
                It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()), Times.Once);
            gateway.Verify(x => x.ResolveModelAsync(
                It.IsAny<string>(), It.IsAny<string>(), null, null, null, It.IsAny<CancellationToken>()), Times.Never);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    [Fact]
    public async Task FixedModelMustSupportBothLiteraryScenarios()
    {
        var (db, connection, name) = CreateDatabase("validate");
        try
        {
            var gateway = Gateway();
            SetupResolution(gateway, AppCallerRegistry.LiteraryAgent.Illustration.Text2Img,
                "text-only-model", success: true);
            SetupResolution(gateway, AppCallerRegistry.LiteraryAgent.Illustration.Img2Img,
                "text-only-model", success: false);
            var service = new LiteraryMcpModelSelectionService(db, gateway.Object, Microsoft.Extensions.Logging.Abstractions.NullLogger<LiteraryMcpModelSelectionService>.Instance);

            var result = await service.ValidateFixedModelAsync("text-only-model", CancellationToken.None);

            Assert.False(result.Success);
            Assert.Equal("MODEL_UNAVAILABLE", result.ErrorCode);
            Assert.Contains("文生图与图生图", result.ErrorMessage);
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    private static Mock<ILlmGateway> Gateway() => new(MockBehavior.Strict);

    [Fact]
    public async Task CatalogSnapshotRetainsStandardRatiosThroughActualCapabilityService()
    {
        // 使用正式目录的快照生产器；它只下发像素，不下发注册表中的比例标签。
        var builder = typeof(PrdAgent.Infrastructure.LlmGateway.ModelResolver).GetMethod(
            "BuildImageCapabilitiesSnapshot", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!;
        var snapshot = Assert.IsType<GatewayImageCapabilitiesSnapshot>(builder.Invoke(null, ["nano-banana-2"]));
        var gateway = Gateway();
        gateway.Setup(x => x.GetAvailablePoolsAsync(
                AppCallerRegistry.LiteraryAgent.Illustration.Text2Img,
                ModelTypes.ImageGen, It.IsAny<CancellationToken>()))
            .ReturnsAsync([new AvailableModelPool
            {
                Code = "nano-banana-2", ResolutionType = "LogicalModel",
                Models = [new PoolModelInfo { ImageCapabilities = snapshot }],
            }]);
        var service = new LiteraryMcpModelSelectionService(null!, gateway.Object,
            NullLogger<LiteraryMcpModelSelectionService>.Instance);
        var model = await service.GetImageCapabilitiesAsync(
            AppCallerRegistry.LiteraryAgent.Illustration.Text2Img, "nano-banana-2", CancellationToken.None);
        Assert.NotNull(model);
        var sizes = PrdAgent.Api.Services.LiteraryIllustrationChoices.SupportedSizes(model);
        Assert.Equal(7, sizes.Count);
        Assert.Contains(sizes, x => x.Aspect == "4:3" && x.Size == "1184x864");
        Assert.Contains(sizes, x => x.Aspect == "3:4" && x.Size == "864x1184");
        Assert.Contains(sizes, x => x.Aspect == "16:9" && x.Size == "1344x768");
        foreach (var choice in sizes)
            Assert.Equal(choice.Size, PrdAgent.Api.Services.LiteraryIllustrationChoices.FitSize(
                PrdAgent.Api.Services.LiteraryIllustrationChoices.ParseSize(choice.Aspect).request!, model, "nano-banana-2").size);
        foreach (var unsupported in new[] { "4:5", "5:4", "21:9" })
            Assert.NotNull(PrdAgent.Api.Services.LiteraryIllustrationChoices.FitSize(
                PrdAgent.Api.Services.LiteraryIllustrationChoices.ParseSize(unsupported).request!, model, "nano-banana-2").error);
        gateway.Verify(x => x.GetAvailablePoolsAsync(
            AppCallerRegistry.LiteraryAgent.Illustration.Text2Img, ModelTypes.ImageGen,
            It.IsAny<CancellationToken>()), Times.Once);
        gateway.VerifyNoOtherCalls();
    }

    [Theory]
    [InlineData("fixed", "selected")]
    [InlineData("preferred", "selected")]
    [InlineData("default", "default")]
    public async Task PresetAndEnqueueModelSelectionNeverClaimsRecoveryProbe(string mode, string expected)
    {
        var (db, connection, name) = CreateDatabase("readonly");
        try
        {
            await db.AgentApiKeys.InsertOneAsync(new AgentApiKey
            {
                Id = "key-writer", OwnerUserId = "writer",
                McpLiteraryImageModelMode = mode == "fixed" ? McpLiteraryImageModelMode.Fixed : McpLiteraryImageModelMode.FollowUserPanel,
                McpLiteraryImageModelPublicId = mode == "fixed" ? "selected" : null,
            });
            if (mode == "preferred")
                await db.UserPreferences.InsertOneAsync(new UserPreferences
                {
                    UserId = "writer",
                    LiteraryAgentPreferences = new() { ImageModelId = "pool_selected-id" },
                });
            // 严格 Mock 只允许无副作用的目录查询；旧实现会进入真实线路解析并抢半开租约。
            var gateway = Gateway();
            gateway.Setup(x => x.GetAvailablePoolsAsync(
                    AppCallerRegistry.LiteraryAgent.Illustration.Text2Img,
                    ModelTypes.ImageGen, It.IsAny<CancellationToken>()))
                .ReturnsAsync([
                    new AvailableModelPool { Id = "selected-id", Code = "selected" },
                    new AvailableModelPool { Code = "default", IsDefault = true },
                ]);
            var service = new LiteraryMcpModelSelectionService(db, gateway.Object, NullLogger<LiteraryMcpModelSelectionService>.Instance);
            for (var i = 0; i < 2; i++)
            {
                var selected = await service.ResolveForRunAsync("writer", "key-writer",
                    AppCallerRegistry.LiteraryAgent.Illustration.Text2Img, CancellationToken.None);
                Assert.True(selected.Success);
                Assert.Equal(expected, selected.LogicalModelPublicId);
            }
            gateway.Verify(x => x.GetAvailablePoolsAsync(It.IsAny<string>(), It.IsAny<string>(),
                It.IsAny<CancellationToken>()), Times.Exactly(2));
            gateway.VerifyNoOtherCalls();
        }
        finally { await new MongoClient(connection).DropDatabaseAsync(name); }
    }

    private static void SetupResolution(Mock<ILlmGateway> gateway, string appCaller, string publicId, bool success)
        => gateway.Setup(x => x.ResolveRequiredLogicalModelAsync(
                appCaller, ModelTypes.ImageGen, publicId, It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayModelResolution
            {
                Success = success,
                LogicalModelPublicId = success ? publicId : null,
                ActualModel = success ? publicId + "-upstream" : string.Empty,
            });

    private static (MongoDbContext db, string connection, string name) CreateDatabase(string suffix)
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27017";
        var name = $"literary_mcp_model_{suffix}_{Guid.NewGuid():N}";
        return (new MongoDbContext(connection, name), connection, name);
    }
}
