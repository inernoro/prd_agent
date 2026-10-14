using MongoDB.Bson;
using PrdAgent.LlmGw.LogicalModels;
using Xunit;

namespace PrdAgent.Tests;

public sealed class OfferingDeletionPolicyTests
{
    [Fact]
    public void 可用且Provider启用的剩余线路允许删除旧线路()
    {
        var provider = Document("provider-1", enabled: true);
        var model = Document("model-1", enabled: true);
        model["PlatformId"] = "provider-1";
        var offering = Offering("model", "model-1", enabled: true);

        Assert.True(OfferingDeletionPolicy.HasUsableRemaining(
            [offering],
            new Dictionary<string, BsonDocument> { ["model-1"] = model },
            new Dictionary<string, BsonDocument>(),
            new Dictionary<string, BsonDocument> { ["provider-1"] = provider }));
    }

    [Theory]
    [InlineData(false, false, true)]
    [InlineData(true, true, true)]
    [InlineData(true, false, false)]
    public void 停用_被替代或目标失效的线路不能充当最后可用线路(
        bool offeringEnabled,
        bool superseded,
        bool targetEnabled)
    {
        var provider = Document("provider-1", enabled: true);
        var model = Document("model-1", targetEnabled);
        model["PlatformId"] = "provider-1";
        var offering = Offering("model", "model-1", offeringEnabled);
        if (superseded) offering["SupersededByOfferingId"] = "replacement";

        Assert.False(OfferingDeletionPolicy.HasUsableRemaining(
            [offering],
            new Dictionary<string, BsonDocument> { ["model-1"] = model },
            new Dictionary<string, BsonDocument>(),
            new Dictionary<string, BsonDocument> { ["provider-1"] = provider }));
    }

    [Fact]
    public void 没有剩余线路时拒绝删除最后一条()
    {
        Assert.False(OfferingDeletionPolicy.HasUsableRemaining(
            [],
            new Dictionary<string, BsonDocument>(),
            new Dictionary<string, BsonDocument>(),
            new Dictionary<string, BsonDocument>()));
    }

    private static BsonDocument Document(string id, bool enabled) => new()
    {
        { "_id", id },
        { "Enabled", enabled },
    };

    private static BsonDocument Offering(string targetKind, string targetId, bool enabled) => new()
    {
        { "_id", $"offering-{targetId}" },
        { "TargetKind", targetKind },
        { "TargetId", targetId },
        { "Enabled", enabled },
    };
}
