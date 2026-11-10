using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using PrdAgent.LlmGw.LogicalModels;
using Xunit;

namespace PrdAgent.Tests;

public sealed class OfferingRemovalPolicyTests
{
    private static BsonDocument Logical(bool enabled = true) => new() { { "_id", "logical" }, { "Enabled", enabled } };
    private static BsonDocument Offering(string id = "old", bool enabled = false, int health = 0) => new()
    {
        { "_id", id }, { "TenantId", "tenant" }, { "LogicalModelId", "logical" },
        { "TargetKind", "model" }, { "TargetId", "physical" }, { "Enabled", enabled }, { "HealthStatus", health },
    };
    private static BsonDocument Model(bool enabled = true) => new()
    {
        { "_id", "physical" }, { "PlatformId", "official" }, { "ModelName", "gpt-4o" }, { "Enabled", enabled },
    };
    private static BsonDocument Platform(bool enabled = true) => new() { { "_id", "official" }, { "Enabled", enabled } };

    [Fact]
    public void EnabledOfferingMustBeDisabledBeforeRemoval()
        => Assert.Equal("OFFERING_MUST_BE_DISABLED", OfferingRemovalPolicy.Evaluate(Logical(), Offering(enabled: true), true, false, false)?.Code);

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public void ActiveOrMapReferencedPublicModelRequiresAlternative(bool enabled, bool referenced)
        => Assert.Equal("OFFERING_LAST_USABLE_ROUTE", OfferingRemovalPolicy.Evaluate(Logical(enabled), Offering(), false, referenced, false)?.Code);

    [Fact]
    public void DisabledUnreferencedPublicModelCanKeepEmptyIdentity()
        => Assert.Null(OfferingRemovalPolicy.Evaluate(Logical(false), Offering(), false, false, false));

    [Theory]
    [InlineData("IsDefaultForType")]
    [InlineData("DefaultForAppCallerCodes")]
    public void DisabledButDefaultOrClaimedModelIsStillProtected(string field)
    {
        var logical = Logical(false);
        logical[field] = field == "IsDefaultForType" ? BsonBoolean.True : new BsonArray { "visual-agent.image.text2img" };
        Assert.Equal("OFFERING_LAST_USABLE_ROUTE", OfferingRemovalPolicy.Evaluate(logical, Offering(), false, false, false)?.Code);
    }

    [Fact]
    public void InFlightJobsPreventRemovalEvenWhenAlternativeExists()
        => Assert.Equal("OFFERING_HAS_INFLIGHT_JOBS", OfferingRemovalPolicy.Evaluate(Logical(), Offering(), true, false, true)?.Code);

    [Theory]
    [InlineData(true, true, true, 0, true)]
    [InlineData(true, true, true, 1, true)]
    [InlineData(true, true, true, 2, false)]
    [InlineData(false, true, true, 0, false)]
    [InlineData(true, false, true, 0, false)]
    [InlineData(true, true, false, 0, false)]
    public void AlternativeMustMatchActualRouteEligibility(bool routeEnabled, bool modelEnabled, bool platformEnabled, int health, bool expected)
    {
        Assert.Equal(expected, OfferingRemovalPolicy.HasUsableAlternative("old", [Offering("official", routeEnabled, health)],
            [Model(modelEnabled)], [Platform(platformEnabled)], []));
    }

    [Fact]
    public void SupersededAndCatalogBlockedRoutesAreNotAlternatives()
    {
        var route = Offering("official", true);
        route["SupersededByOfferingId"] = "newer";
        Assert.False(OfferingRemovalPolicy.HasUsableAlternative("old", [route], [Model()], [Platform()], []));
        route.Remove("SupersededByOfferingId");
        var model = Model();
        model["ModelName"] = "unknown-private-image-model";
        Assert.False(OfferingRemovalPolicy.HasUsableAlternative("old", [route], [model], [Platform()], []));
        model["AllowedOutsideCatalog"] = true;
        Assert.True(OfferingRemovalPolicy.HasUsableAlternative("old", [route], [model], [Platform()], []));
    }

    [Fact]
    public void RemovalCasIncludesTenantParentDisabledAndSnapshotTime()
    {
        var offering = Offering();
        offering["UpdatedAt"] = new BsonDateTime(new DateTime(2026, 11, 11, 0, 0, 0, DateTimeKind.Utc));
        var args = new RenderArgs<BsonDocument>(BsonSerializer.SerializerRegistry.GetSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry);
        var rendered = OfferingRemovalPolicy.UnchangedDisabledFilter(offering).Render(args);
        Assert.Equal("tenant", rendered["TenantId"].AsString);
        Assert.Equal("logical", rendered["LogicalModelId"].AsString);
        Assert.False(rendered["Enabled"].AsBoolean);
        Assert.Equal(offering["UpdatedAt"], rendered["UpdatedAt"]);
        offering.Remove("UpdatedAt");
        var legacy = OfferingRemovalPolicy.UnchangedDisabledFilter(offering).Render(args);
        Assert.False(legacy["UpdatedAt"]["$exists"].AsBoolean);
    }
}
