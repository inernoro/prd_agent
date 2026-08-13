using MongoDB.Bson;
using PrdAgent.LlmGw.LogicalModels;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public sealed class LogicalModelCapabilityPolicyTests
{
    [Fact]
    public void GenericImageGeneration_NormalizesToAllImageScenarios()
    {
        var capabilities = LogicalModelCapabilityPolicy.Normalize(
            "generation",
            [" image_generation "]);

        capabilities.ShouldBe([
            "image_generation",
            "text2img",
            "img2img",
            "vision_generation",
        ]);
    }

    [Fact]
    public void ExplicitScenarioSelection_IsPreservedWithoutBroadening()
    {
        var capabilities = LogicalModelCapabilityPolicy.Normalize(
            "generation",
            ["image_generation", "text2img"]);

        capabilities.ShouldBe(["image_generation", "text2img"]);
    }

    [Fact]
    public void LegacyBackfill_IsRestrictedToGenericGenerationModels()
    {
        var rendered = LogicalModelCapabilityPolicy.BuildLegacyGenerationModelsFilter();

        rendered["ModelType"].AsString.ShouldBe("generation");
        rendered["Capabilities"].AsBsonDocument["$in"].AsBsonArray
            .ShouldContain(LogicalModelCapabilityPolicy.ImageGeneration);
        rendered["Capabilities"].AsBsonDocument["$nin"].AsBsonArray.Count.ShouldBe(3);
    }
}
