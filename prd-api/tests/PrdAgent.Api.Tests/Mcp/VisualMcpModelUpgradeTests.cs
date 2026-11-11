using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using MongoDB.Bson;
using Moq;
using PrdAgent.Api.Controllers;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Mcp;
using PrdAgent.Api.Services;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Mcp;

public sealed class VisualMcpModelUpgradeTests
{
    private static VisualModelPolicy Policy() => new()
    {
        DefaultModelId = "image-quality",
        Models =
        [
            new() { ModelId = "image-quality", DisplayName = "画师", Description = "跟随已验证版本" },
            new() { ModelId = "gpt-image-2.6-flare", DisplayName = "固定版本" },
        ],
    };

    private static AvailableModelPool Model(string id, params string[] aliases) => new()
    {
        Code = id, Name = id, ResolutionType = "LogicalModel", Aliases = aliases.ToList(),
    };

    [Fact]
    public void OmittedModelContinuesToFollowDefaultWithoutRequiringNewMetadata()
    {
        Assert.Equal("image-quality", VisualOpenApiController.SelectModelForRequest(Policy(), null, []));
        var changed = Policy();
        changed.DefaultModelId = "gpt-image-2.6-flare";
        Assert.Equal("gpt-image-2.6-flare", VisualOpenApiController.SelectModelForRequest(changed, " ", []));
    }

    [Fact]
    public void ConcreteVersionStaysFixedWhileDefaultChanges()
    {
        var policy = Policy();
        AvailableModelPool[] catalog = [Model("image-quality"), Model("gpt-image-2.6-flare")];
        Assert.Equal("gpt-image-2.6-flare", VisualOpenApiController.SelectModelForRequest(policy, "gpt-image-2.6-flare", catalog));
        policy.DefaultModelId = "other-new-default";
        Assert.Equal("gpt-image-2.6-flare", VisualOpenApiController.SelectModelForRequest(policy, "gpt-image-2.6-flare", catalog));
    }

    [Theory]
    [InlineData("image-2-all")]
    [InlineData(" GPT-IMAGE-2-ALL ")]
    public void RegisteredLegacyAliasSelectsOnlyTheAllowedStableIdentity(string requested)
    {
        Assert.Equal("image-quality", VisualOpenApiController.SelectModelForRequest(Policy(), requested,
            [Model("image-quality", "image-2-all", "gpt-image-2-all")]));
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("gpt-image-retired")]
    public void UnknownExplicitModelNeverFallsBackToDefault(string requested)
        => Assert.Null(VisualOpenApiController.SelectModelForRequest(Policy(), requested, [Model("image-quality")]));

    [Fact]
    public void AliasDoesNotGrantAccessToAnUnopenedLogicalModel()
        => Assert.Null(VisualOpenApiController.SelectModelForRequest(Policy(), "image-2-all", [Model("not-open", "image-2-all")]));

    [Fact]
    public void AmbiguousAliasIsRejectedEvenWhenOnlyOneTargetIsOpen()
        => Assert.Null(VisualOpenApiController.SelectModelForRequest(Policy(), "image-2-all",
            [Model("image-quality", "image-2-all"), Model("not-open", "image-2-all")]));

    [Fact]
    public void ExactVersionDoesNotGetReplacedByAnAliasOnANewerModel()
    {
        Assert.Equal("gpt-image-2.6-flare", VisualOpenApiController.SelectModelForRequest(Policy(), "gpt-image-2.6-flare",
            [Model("image-quality", "gpt-image-2.6-flare"), Model("gpt-image-2.6-flare")]));
    }

    [Fact]
    public void ExplicitModelMustBeInTheAuthorizedTextToImageCatalog()
    {
        Assert.Null(VisualOpenApiController.SelectModelForRequest(Policy(), "gpt-image-2.6-flare", []));
        Assert.Null(VisualOpenApiController.SelectModelForRequest(Policy(), "image-quality",
            [new AvailableModelPool { Code = "image-quality", ResolutionType = "DefaultPool" }]));
        Assert.Null(VisualOpenApiController.SelectModelForRequest(Policy(), new string('x', 201), [Model("image-quality")]));
    }

    [Fact]
    public void ToolSchemaAddsOptionalModelWithoutChangingExistingRequiredInputs()
    {
        var tool = McpBuiltinTools.All.Single(x => x.Name == "map_visual_generate_image");
        var schema = McpGatewayController.BuiltinToolToJson(tool)["inputSchema"]!.AsObject();
        Assert.True(schema["properties"]!.AsObject().ContainsKey("modelId"));
        Assert.DoesNotContain(schema["required"]!.AsArray(), x => x!.GetValue<string>() == "modelId");
        var request = McpGatewayController.BuildBuiltinRequest(tool,
            new() { ["prompt"] = "一只杯子", ["modelId"] = "image-2-all", ["clientRequestId"] = "same-key" });
        Assert.Null(request.err);
        Assert.Equal("image-2-all", request.body!["modelId"]!.GetValue<string>());
        Assert.Equal("same-key", request.body["clientRequestId"]!.GetValue<string>());
    }

    [Fact]
    public void DiscoveryListsOnlyOpenedAuthorizedModelsAndPublishesTheirRegisteredAliases()
    {
        var rows = VisualOpenApiController.DescribeModels(Policy(),
            [Model("image-quality", "image-2-all"), Model("not-open", "hidden-alias")]);
        var row = Assert.Single(rows);
        Assert.Equal("image-quality", row.Id);
        Assert.True(row.IsDefault);
        Assert.Equal("画师", row.DisplayName);
        Assert.Contains("image-2-all", row.Aliases);
    }

    [Fact]
    public async Task UnknownModelGetsActionableFailureBeforeAnyRunIsWritten()
    {
        var policy = new Mock<IVisualModelPolicyService>();
        policy.Setup(x => x.ReadAsync(It.IsAny<CancellationToken>())).ReturnsAsync(Policy());
        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(x => x.GetAvailablePoolsAsync(AppCallerRegistry.VisualAgent.Image.Text2Img,
            ModelTypes.ImageGen, It.IsAny<CancellationToken>())).ReturnsAsync([Model("image-quality")]);
        var controller = new VisualOpenApiController(null!, policy.Object, gateway.Object)
        {
            ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() },
        };
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("boundUserId", "owner")], "ApiKey"));
        var action = Assert.IsType<BadRequestObjectResult>(await controller.Generate(
            new() { Prompt = "一只蓝色杯子", ModelId = "not-open" }, CancellationToken.None));
        var result = JsonSerializer.SerializeToElement(action.Value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.Equal("VISUAL_MODEL_NOT_ALLOWED", result.GetProperty("error").GetProperty("code").GetString());
        Assert.Contains("map_visual_list_models", result.GetProperty("error").GetProperty("message").GetString());
    }

    [Fact]
    public void RequestedAndActualMetadataSurvivePersistenceWithoutInventingHistory()
    {
        var run = new ImageGenRun { ModelId = "image-quality", LogicalModelPublicId = "image-quality", RequestedModelId = "image-2-all" };
        var persisted = MongoDB.Bson.Serialization.BsonSerializer.Deserialize<ImageGenRun>(run.ToBson());
        Assert.Equal("image-2-all", persisted.RequestedModelId);
        Assert.Equal("image-quality", persisted.LogicalModelPublicId);
        var item = new ImageGenRunItem { ActualModel = "gpt-image-2.6-flare" };
        Assert.Equal("gpt-image-2.6-flare", MongoDB.Bson.Serialization.BsonSerializer.Deserialize<ImageGenRunItem>(item.ToBson()).ActualModel);
        Assert.Null(new ImageGenRunItem().ActualModel);
        Assert.Null(new ImageGenRun().RequestedModelId);
    }
}
