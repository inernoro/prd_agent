using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.ModelUpgrades;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class ModelUpgradeReadTests
{
    private static Mock<IMongoCollection<T>> Collection<T>(Mock<IMongoDatabase> db, string name, params T[] docs)
    {
        var collection = new Mock<IMongoCollection<T>>(MockBehavior.Strict);
        collection.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<T>>(), It.IsAny<FindOptions<T, T>>(), It.IsAny<CancellationToken>()))
            .Returns(() =>
            {
                var cursor = new Mock<IAsyncCursor<T>>();
                cursor.SetupGet(x => x.Current).Returns(docs);
                cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true).ReturnsAsync(false);
                return Task.FromResult(cursor.Object);
            });
        db.Setup(x => x.GetCollection<T>(name, It.IsAny<MongoCollectionSettings>())).Returns(collection.Object);
        return collection;
    }
    private static BsonDocument Logical() => new() { { "_id", "stable" }, { "TenantId", "tenant" }, { "IdentityKind", "stable" }, { "ModelType", "generation" },
        { "DefaultForAppCallerCodes", new BsonArray { "visual-agent.image.img2img::generation", "visual-agent.image.text2img::generation" } },
        { "Capabilities", new BsonArray { "image_generation" } } };
    private static BsonDocument Caller(string code, string status = "active") => new() { { "AppCallerCode", code }, { "RequestType", "generation" }, { "Status", status } };
    private static ModelUpgradeService Service(Mock<IMongoDatabase> db) => new(db.Object, db.Object, Mock.Of<IModelUpgradeDiscovery>(), "tenant", NullLogger<ModelUpgradeService>.Instance);
    [Fact]
    public async Task ReadReturnsActualCanaryModeRatherThanDefaultEvidence()
    {
        var db = new Mock<IMongoDatabase>(MockBehavior.Strict);
        Collection(db, "llmgw_logical_models", Logical());
        Collection(db, ModelUpgradeService.CollectionName, new ModelUpgradeState { ValidationMode = "canary" });
        Collection<BsonDocument>(db, "llmgw_model_offerings");
        var view = await Service(db).ReadAsync("tenant", "stable");
        Assert.Equal("canary", view.ValidationMode);
    }
    [Fact]
    public async Task FirstPolicyUsesExistingAuthorizedClaimAndPrefersTextToImage()
    {
        var db = new Mock<IMongoDatabase>(MockBehavior.Strict);
        Collection(db, "llmgw_logical_models", Logical());
        Collection<ModelUpgradeState>(db, ModelUpgradeService.CollectionName);
        Collection<BsonDocument>(db, "llmgw_model_offerings");
        Collection(db, "llmgw_app_callers", Caller("visual-agent.image.img2img::generation"), Caller("visual-agent.image.text2img::generation"));
        var view = await Service(db).ReadAsync("tenant", "stable");
        Assert.Equal("visual-agent.image.text2img::generation", view.Policy.ValidationAppCallerCode);
    }
    [Fact]
    public async Task FirstPolicyDoesNotInventUnregisteredOrBlockedCaller()
    {
        var db = new Mock<IMongoDatabase>(MockBehavior.Strict);
        Collection(db, "llmgw_logical_models", Logical());
        Collection<ModelUpgradeState>(db, ModelUpgradeService.CollectionName);
        Collection<BsonDocument>(db, "llmgw_model_offerings");
        Collection(db, "llmgw_app_callers", Caller("visual-agent.image.text2img::generation", "disabled"), Caller("unclaimed::generation"));
        var view = await Service(db).ReadAsync("tenant", "stable");
        Assert.Equal("", view.Policy.ValidationAppCallerCode);
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SaveRejectsUnregisteredOrUnauthorizedValidationCallerBeforeWrites(bool registered)
    {
        var db = new Mock<IMongoDatabase>(MockBehavior.Strict);
        var logical = Logical(); logical["AllowedAppCallerCodes"] = new BsonArray { "different::generation" };
        Collection(db, "llmgw_logical_models", logical);
        Collection(db, "llmgw_app_callers", registered ? new[] { Caller("visual-agent.image.text2img::generation") } : []);
        var actor = new TenantAccessContext("tenant", "", true, "user", "admin", "member", 1, "admin", []);
        var error = await Assert.ThrowsAsync<ModelUpgradeException>(() => Service(db).SavePolicyAsync(actor, "stable", new ModelUpgradePolicyWrite { ValidationAppCallerCode = "visual-agent.image.text2img::generation" }));
        Assert.Equal("VALIDATION_CALLER_UNAUTHORIZED", error.Code);
    }
}
