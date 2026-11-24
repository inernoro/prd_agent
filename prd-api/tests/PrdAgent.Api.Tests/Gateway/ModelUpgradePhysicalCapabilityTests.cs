using MongoDB.Bson;
using MongoDB.Bson.IO;
using MongoDB.Bson.Serialization;
using PrdAgent.Core.Models;
using PrdAgent.LlmGw.ModelUpgrades;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class ModelUpgradePhysicalCapabilityTests
{
    private static BsonDocument SerializeModel(bool enabled, bool capabilityValue, params LLMModelCapability[] extra)
    {
        var model = new LLMModel { Id = "physical", PlatformId = "official", ModelName = "gpt-image-2.6", Enabled = enabled,
            Capabilities = [new LLMModelCapability { Type = "image_generation", Value = capabilityValue, Source = "user" }, .. extra] };
        using var stream = new MemoryStream();
        using (var writer = new BsonBinaryWriter(stream)) BsonSerializer.Serialize(writer, model);
        return BsonSerializer.Deserialize<BsonDocument>(stream.ToArray());
    }
    private static BsonDocument Logical() => new() { { "ModelType", "generation" }, { "Capabilities", new BsonArray { "image_generation" } } };
    private static ModelSuccessor Relation() => new() { Capabilities = ["image_generation"] };
    [Fact]
    public void RealSerializedPhysicalCapabilitiesUseTrueTypeDocumentsAndLogicalType()
    {
        var physical = SerializeModel(true, true);
        Assert.False(physical.Contains("ModelType"));
        Assert.True(physical["Capabilities"].AsBsonArray[0].IsBsonDocument);
        Assert.True(ModelUpgradeRules.CandidateCapabilitiesPass(Logical(), Relation(), physical));
        Assert.Contains("text2img", ModelUpgradeRules.PhysicalCapabilities(physical, "generation"));
        Assert.Contains("img2img", ModelUpgradeRules.PhysicalCapabilities(physical, "generation"));
    }
    [Theory]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(false, false)]
    public void DisabledPhysicalModelOrCapabilityCannotSatisfyCandidate(bool enabled, bool value)
        => Assert.False(ModelUpgradeRules.CandidateCapabilitiesPass(Logical(), Relation(), SerializeModel(enabled, value)));
    [Fact]
    public void ExplicitFalseScenarioIsNotReenabledByLegacyImageGenerationExpansion()
    {
        var physical = SerializeModel(true, true, new LLMModelCapability { Type = "img2img", Value = false, Source = "user" });
        Assert.DoesNotContain("img2img", ModelUpgradeRules.PhysicalCapabilities(physical, "generation"));
        Assert.False(ModelUpgradeRules.CandidateCapabilitiesPass(Logical(), Relation(), physical));
    }
    [Fact]
    public void MissingOrNonBooleanValueDoesNotDeclareCapability()
    {
        var physical = SerializeModel(true, true);
        var capability = physical["Capabilities"].AsBsonArray[0].AsBsonDocument;
        capability.Remove("Value");
        Assert.False(ModelUpgradeRules.CandidateCapabilitiesPass(Logical(), Relation(), physical));
        capability["Value"] = "true";
        Assert.False(ModelUpgradeRules.CandidateCapabilitiesPass(Logical(), Relation(), physical));
    }
}
