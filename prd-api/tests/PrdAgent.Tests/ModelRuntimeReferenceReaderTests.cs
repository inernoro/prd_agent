using MongoDB.Bson;
using PrdAgent.LlmGw.ModelReferences;
using Xunit;

namespace PrdAgent.Tests;

public sealed class ModelRuntimeReferenceReaderTests
{
    private const string Commit = "461076339cbf20a310d4cedd2403a08a2941ae87";
    internal static BsonDocument Row(DateTime now, string instance = "instance") => new()
    {
        ["SchemaVersion"] = 1, ["TenantId"] = "tenant", ["DeploymentIdentity"] = "project::main",
        ["DeploymentScope"] = "main", ["DurableScope"] = "main", ["ActualCommit"] = Commit,
        ["HeartbeatAt"] = now, ["ExpiresAt"] = now.AddMinutes(2), ["InstanceId"] = instance,
        ["LegacyFallbackAuthority"] = "gateway-only",
        ["ExpectedConsumerKeys"] = new BsonArray(MongoRuntimeModelReferenceSnapshotProvider.ExpectedConsumerKeys),
        ["Entries"] = new BsonArray(MongoRuntimeModelReferenceSnapshotProvider.ExpectedConsumerKeys.Select(k => new BsonDocument
        {
            ["ConsumerKey"] = k, ["Path"] = k, ["IdentityKind"] = MongoRuntimeModelReferenceSnapshotProvider.KindFor(k),
            ["State"] = MongoRuntimeModelReferenceSnapshotProvider.RequiredDefaultKeys.Contains(k) ? "default" : "none",
            ["Value"] = MongoRuntimeModelReferenceSnapshotProvider.RequiredDefaultKeys.Contains(k) ? new BsonString("computed-model") : BsonNull.Value,
            ["PlatformId"] = BsonNull.Value,
        })),
    };
    private static RuntimeModelReferenceSnapshot Validate(params BsonDocument[] rows)
        => MongoRuntimeModelReferenceSnapshotProvider.Validate(rows, "tenant", "project::main", "main", "main", Commit, DateTime.UtcNow);
    [Fact]
    public void CompleteFreshCohortIsAcceptedAndAllDefaultsRemainVisible()
    {
        var row = Row(DateTime.UtcNow); var result = Validate(row);
        Assert.True(result.Complete); Assert.Equal(5, result.Items.Count); Assert.All(result.Items, x => Assert.Equal("computed-model", x.Value));
    }
    [Theory]
    [InlineData("old-commit")]
    [InlineData("missing-consumer")]
    [InlineData("required-none")]
    [InlineData("unknown")]
    [InlineData("wrong-kind")]
    [InlineData("wrong-provider")]
    [InlineData("expired")]
    [InlineData("foreign-tenant")]
    [InlineData("foreign-scope")]
    public void PartialOrMixedRuntimeProofCannotBeClaimedComplete(string mutation)
    {
        var row = Row(DateTime.UtcNow); var first = row["Entries"][0].AsBsonDocument;
        switch (mutation)
        {
            case "old-commit": row["ActualCommit"] = new string('a', 40); break;
            case "missing-consumer": row["Entries"].AsBsonArray.RemoveAt(0); break;
            case "required-none": first["State"] = "none"; first["Value"] = BsonNull.Value; break;
            case "unknown": first["State"] = "unknown"; break;
            case "wrong-kind": first["IdentityKind"] = "upstream-model-id"; break;
            case "wrong-provider": first["PlatformId"] = "p"; break;
            case "expired": row["ExpiresAt"] = DateTime.UtcNow.AddSeconds(-1); break;
            case "foreign-tenant": row["TenantId"] = "another"; break;
            case "foreign-scope": row["DurableScope"] = "feature"; break;
        }
        Assert.False(Validate(Row(DateTime.UtcNow, "current-instance"), row).Complete);
    }
    [Fact]
    public void ChatDefaultMatchesItsGatewayPublicIdRatherThanAnOfferingModel()
    {
        var row = Row(DateTime.UtcNow);
        row["Entries"].AsBsonArray.Select(x => x.AsBsonDocument)
            .Single(x => x["ConsumerKey"] == "chat-agent.default")["Value"] = "default-chat-curated";
        var snapshot = Validate(row);
        Assert.True(snapshot.Complete);
        var chat = snapshot.Items.Single(x => x.ConsumerKey == "chat-agent.default");
        Assert.True(MongoRuntimeModelReferenceSnapshotProvider.Matches(
            new ReferenceIdentity { PublicId = "default-chat-curated", UpstreamModelId = "actual-provider-model" }, chat));
        Assert.False(MongoRuntimeModelReferenceSnapshotProvider.Matches(
            new ReferenceIdentity { PublicId = "another-public-id", UpstreamModelId = "default-chat-curated" }, chat));
    }

    [Fact]
    public void MissingSnapshotOrRepeatedInstanceDoesNotProveCoverage()
    {
        Assert.False(Validate().Complete); var row = Row(DateTime.UtcNow); Assert.False(Validate(row, row).Complete);
    }
    [Fact]
    public void LegacyFallbackUsesActualUpstreamIdentityWhenPublicNameDiffers()
    {
        var row = Row(DateTime.UtcNow); row["LegacyFallbackAuthority"] = "legacy-fallback-permitted";
        foreach (var key in new[] { "llm.environment-fallback", "llm.active-config" })
        {
            var entry = row["Entries"].AsBsonArray.Select(x => x.AsBsonDocument).Single(x => x["ConsumerKey"] == key);
            entry["Value"] = "old-wire-model"; entry["State"] = "configured";
        }
        var snapshot = Validate(row); Assert.True(snapshot.Complete);
        var identity = new ReferenceIdentity { PublicId = "stable-public-name", UpstreamModelId = "old-wire-model" };
        Assert.Equal(2, snapshot.Items.Count(x => MongoRuntimeModelReferenceSnapshotProvider.Matches(identity, x)));
        var oldKind = row["Entries"].AsBsonArray.Select(x => x.AsBsonDocument).Single(x => x["ConsumerKey"] == "llm.active-config");
        oldKind["IdentityKind"] = "public-id";
        Assert.False(Validate(row).Complete); // an old producer cannot masquerade as the corrected proof
    }
}
