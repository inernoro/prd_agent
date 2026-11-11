using System.Reflection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using Moq;
using PrdAgent.LlmGw.ModelUpgrades;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class ModelUpgradeEvidenceTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task EvidenceValidationUsesAuthoritativeOutputAndDoesNotSendProbe(bool hasOutput)
    {
        var now = DateTime.UtcNow;
        var logical = new BsonDocument { { "_id", "stable-id" }, { "TenantId", "tenant" }, { "IdentityKind", "stable" }, { "Enabled", true }, { "ModelType", "generation" }, { "UpdatedAt", now } };
        var provider = new BsonDocument { { "_id", "official" }, { "TenantId", "tenant" }, { "Enabled", true }, { "ApiUrl", "https://api.openai.com/v1" }, { "UpdatedAt", now } };
        var model = new BsonDocument { { "_id", "physical" }, { "TenantId", "tenant" }, { "Enabled", true }, { "PlatformId", "official" }, { "ModelName", "exact-candidate" }, { "UpdatedAt", now } };
        var log = new BsonDocument { { "TenantId", "tenant" }, { "RequestId", "real-request" }, { "PlatformId", "official" }, { "Model", "exact-candidate" }, { "Status", "succeeded" }, { "StatusCode", 200 }, { "EndedAt", now }, { "ImageSuccessCount", hasOutput ? 1 : 0 } };
        var db = new Mock<IMongoDatabase>(MockBehavior.Strict);
        var collections = new Dictionary<string, Mock<IMongoCollection<BsonDocument>>>();
        foreach (var (name, doc) in new[] { ("llmgw_logical_models", logical), ("llmgw_platforms", provider), ("llmgw_models", model), ("llmrequestlogs", log) })
        {
            var cursor = new Mock<IAsyncCursor<BsonDocument>>();
            cursor.SetupGet(x => x.Current).Returns(new[] { doc });
            cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true).ReturnsAsync(false);
            var collection = new Mock<IMongoCollection<BsonDocument>>();
            collection.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<BsonDocument>>(), It.IsAny<FindOptions<BsonDocument, BsonDocument>>(), It.IsAny<CancellationToken>())).ReturnsAsync(cursor.Object);
            collections[name] = collection;
            db.Setup(x => x.GetCollection<BsonDocument>(name, It.IsAny<MongoCollectionSettings>())).Returns(collection.Object);
        }
        var discovery = new Mock<IModelUpgradeDiscovery>(MockBehavior.Strict);
        var service = new ModelUpgradeService(db.Object, db.Object, discovery.Object, "tenant", NullLogger<ModelUpgradeService>.Instance);
        var state = new ModelUpgradeState { TenantId = "tenant", LogicalModelId = "stable-id", ValidationMode = "evidence", EvidenceRequestId = "real-request", Gates = new() { Capabilities = true },
            Candidate = new() { ModelId = "physical", ProviderId = "official", UpstreamModelId = "exact-candidate", Fingerprint = ModelUpgradeRules.Fingerprint(logical, provider, model) } };
        var operation = typeof(ModelUpgradeService).GetMethod("ValidateAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
        var task = (Task)operation.Invoke(service, new object[] { state })!;
        if (hasOutput)
        {
            await task;
            Assert.True(state.Gates.Validation); Assert.Equal("passed", state.ValidationStatus); Assert.Equal("validated", state.Phase);
            Assert.False(state.Gates.Price); // Unknown pricing permits evidence, never automatic promotion.
            Assert.False(ModelUpgradeRules.CanPromote(state, true, now));
        }
        else
        {
            var error = await Assert.ThrowsAsync<ModelUpgradeException>(async () => await task);
            Assert.Equal("SERVICE_EVIDENCE_REQUIRED", error.Code); Assert.False(state.Gates.Validation);
        }
        discovery.VerifyNoOtherCalls();
        foreach (var collection in collections.Values) collection.Verify(x => x.InsertOneAsync(It.IsAny<BsonDocument>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()), Times.Never);
    }
}
