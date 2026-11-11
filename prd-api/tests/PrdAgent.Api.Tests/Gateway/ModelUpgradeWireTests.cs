using MongoDB.Bson;
using PrdAgent.LlmGw.ModelUpgrades;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class ModelUpgradeWireTests
{
    private static BsonDocument Model() => new() { { "_id", "physical" }, { "ModelName", "candidate" }, { "Protocol", "openai" } };
    private static BsonDocument Provider() => new() { { "PlatformType", "openai" } };
    private static BsonDocument Route() => new() { { "_id", "fixed-route" }, { "LogicalModelId", "fixed-logical" }, { "TargetKind", "model" },
        { "TargetId", "physical" }, { "UpstreamModelId", "candidate" }, { "Protocol", "openai-responses" }, { "EndpointPath", "custom/responses" },
        { "Enabled", true }, { "UpdatedAt", DateTime.UtcNow }, { "Priority", 900 } };
    [Fact]
    public void PromotionCopiesValidatedOfferingOverridesAndPreservesStableSettings()
    {
        var snapshot = ModelUpgradeWire.Capture(Route(), Model(), Provider());
        var stable = new BsonDocument { { "Priority", 10 }, { "Weight", 70 }, { "MaxConcurrency", 2 }, { "Protocol", "openai" }, { "EndpointPath", "old/path" } };
        ModelUpgradeWire.Apply(stable, snapshot);
        Assert.Equal("openai-responses", stable["Protocol"].AsString); Assert.Equal("custom/responses", stable["EndpointPath"].AsString);
        Assert.Equal(10, stable["Priority"].AsInt32); Assert.Equal(70, stable["Weight"].AsInt32); Assert.Equal(2, stable["MaxConcurrency"].AsInt32);
    }
    [Theory]
    [InlineData("_id", "different")]
    [InlineData("LogicalModelId", "different")]
    [InlineData("TargetKind", "exchange")]
    [InlineData("TargetId", "different")]
    [InlineData("UpstreamModelId", "different")]
    [InlineData("Protocol", "openai")]
    [InlineData("EndpointPath", "different/path")]
    public void ChangingAnyWireIdentityOrOverrideRejectsPreviousValidation(string field, string value)
    {
        var route = Route(); var snapshot = ModelUpgradeWire.Capture(route, Model(), Provider()); route[field] = value;
        Assert.False(ModelUpgradeWire.Matches(snapshot, route, Model(), Provider()));
    }
    [Fact]
    public void DisabledRouteRejectsButHealthTimestampAndPriorityDoNotInvalidateWire()
    {
        var route = Route(); var snapshot = ModelUpgradeWire.Capture(route, Model(), Provider());
        route["UpdatedAt"] = DateTime.UtcNow.AddMinutes(1); route["HealthStatus"] = 0; route["ConsecutiveSuccesses"] = 20; route["Priority"] = 1;
        Assert.True(ModelUpgradeWire.Matches(snapshot, route, Model(), Provider()));
        route["Enabled"] = false; Assert.False(ModelUpgradeWire.Matches(snapshot, route, Model(), Provider()));
    }
    [Fact]
    public void EvidenceRequiresExactOfferingProtocolAndMatchingPath()
    {
        var route = Route(); var snapshot = ModelUpgradeWire.Capture(route, Model(), Provider());
        var log = new BsonDocument { { "OfferingId", "fixed-route" }, { "Protocol", "openai-responses" }, { "Path", "/v1/custom/responses" } };
        Assert.True(ModelUpgradeWire.LogMatches(snapshot, log));
        foreach (var field in new[] { "OfferingId", "Protocol", "Path" })
        { var changed = log.DeepClone().AsBsonDocument; changed[field] = "other"; Assert.False(ModelUpgradeWire.LogMatches(snapshot, changed)); changed.Remove(field); Assert.False(ModelUpgradeWire.LogMatches(snapshot, changed)); }
    }
    [Fact]
    public void NullEndpointIsCopiedAsInheritedRatherThanKeepingOldStableOverride()
    {
        var route = Route(); route.Remove("EndpointPath"); var snapshot = ModelUpgradeWire.Capture(route, Model(), Provider());
        var stable = new BsonDocument("EndpointPath", "old/path"); ModelUpgradeWire.Apply(stable, snapshot);
        Assert.False(stable.Contains("EndpointPath"));
    }
}
