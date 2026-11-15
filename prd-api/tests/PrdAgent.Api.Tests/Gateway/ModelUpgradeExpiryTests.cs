using System.Reflection;
using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Moq;
using PrdAgent.LlmGw.ModelUpgrades;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class ModelUpgradeExpiryTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task OnlySuccessfulExpiredPendingCasReleasesBudgetAndMakesRequestRetryable(bool winsCas)
    {
        var now = DateTime.UtcNow;
        var database = new Mock<IMongoDatabase>(MockBehavior.Strict);
        var queue = new Mock<IMongoCollection<BsonDocument>>(MockBehavior.Strict);
        var audits = new Mock<IMongoCollection<BsonDocument>>(MockBehavior.Strict);
        var states = new Mock<IMongoCollection<ModelUpgradeState>>(MockBehavior.Strict);
        database.Setup(x => x.GetCollection<BsonDocument>(ModelUpgradeService.ValidationCollectionName, It.IsAny<MongoCollectionSettings>())).Returns(queue.Object);
        database.Setup(x => x.GetCollection<BsonDocument>("llmgw_operation_audits", It.IsAny<MongoCollectionSettings>())).Returns(audits.Object);
        database.Setup(x => x.GetCollection<ModelUpgradeState>(ModelUpgradeService.CollectionName, It.IsAny<MongoCollectionSettings>())).Returns(states.Object);
        BsonDocument? casFilter = null; BsonDocument? casUpdate = null; var persisted = 0;
        queue.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<BsonDocument>>(), It.IsAny<UpdateDefinition<BsonDocument>>(), It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>()))
            .Callback<FilterDefinition<BsonDocument>, UpdateDefinition<BsonDocument>, UpdateOptions, CancellationToken>((filter, update, _, _) =>
            { casFilter = filter.Render(new RenderArgs<BsonDocument>(BsonSerializer.LookupSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry)); casUpdate = update.Render(new RenderArgs<BsonDocument>(BsonSerializer.LookupSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry)).AsBsonDocument; })
            .ReturnsAsync(new UpdateResult.Acknowledged(winsCas ? 1 : 0, winsCas ? 1 : 0, null));
        audits.Setup(x => x.InsertOneAsync(It.IsAny<BsonDocument>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>())).Returns(Task.CompletedTask);
        audits.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<BsonDocument>>(), It.IsAny<UpdateDefinition<BsonDocument>>(), It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>())).ReturnsAsync(new UpdateResult.Acknowledged(1, 1, null));
        states.Setup(x => x.ReplaceOneAsync(It.IsAny<FilterDefinition<ModelUpgradeState>>(), It.IsAny<ModelUpgradeState>(), It.IsAny<ReplaceOptions>(), It.IsAny<CancellationToken>()))
            .Callback<FilterDefinition<ModelUpgradeState>, ModelUpgradeState, ReplaceOptions, CancellationToken>((_, _, _, _) => persisted++)
            .ReturnsAsync(new ReplaceOneResult.Acknowledged(1, 1, null));
        var state = new ModelUpgradeState { Id = "policy", TenantId = "tenant", LogicalModelId = "stable", BudgetDate = now.ToString("yyyy-MM-dd"), ReservedCostUsd = .1m,
            OutcomeUnknown = true, ValidationStatus = "unknown", Candidate = new() { ValidationRequestId = "original-request" } };
        var job = new BsonDocument { { "_id", "original-request" }, { "PolicyId", "policy" }, { "Status", "pending" }, { "ExpiresAt", now.AddMinutes(-1) }, { "CreatedAt", now.AddMinutes(-15) }, { "EstimatedCostUsd", new Decimal128(.05m) } };
        var service = new ModelUpgradeService(database.Object, database.Object, Mock.Of<IModelUpgradeDiscovery>(), "tenant", NullLogger<ModelUpgradeService>.Instance, ModelUpgradeTestConfiguration.AuthorizedProduction());
        var operation = typeof(ModelUpgradeService).GetMethod("ExpireUnsentValidationAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
        async Task<bool> Run() => await (Task<bool>)operation.Invoke(service, new object[] { state, job, now })!;
        Assert.Equal(winsCas, await Run());
        Assert.Equal("pending", casFilter!["Status"].AsString); Assert.Equal("tenant", casFilter["TenantId"].AsString);
        Assert.Equal("policy", casFilter["PolicyId"].AsString); Assert.True(casFilter["ExpiresAt"].AsBsonDocument.Contains("$lt"));
        Assert.Equal("failed", casUpdate!["$set"]["Status"].AsString); Assert.True(casUpdate["$set"]["ExpiredUnsent"].AsBoolean);
        Assert.Equal("original-request", state.Candidate.ValidationRequestId);
        if (winsCas)
        {
            Assert.False(state.OutcomeUnknown); Assert.Equal("not-run", state.ValidationStatus); Assert.Equal(.05m, state.ReservedCostUsd);
            Assert.Single(state.History, x => x.Action == "validate.expire-unused" && x.RequestId == "original-request"); Assert.Equal(1, persisted);
            // Crash/retry after the job CAS uses the durable unsent marker and persisted request history, without a second refund.
            job["Status"] = "failed"; job["ExpiredUnsent"] = true;
            Assert.True(await Run()); Assert.Equal(.05m, state.ReservedCostUsd); Assert.Single(state.History);
            queue.Verify(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<BsonDocument>>(), It.IsAny<UpdateDefinition<BsonDocument>>(), It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>()), Times.Once);
        }
        else
        {
            Assert.True(state.OutcomeUnknown); Assert.Equal("unknown", state.ValidationStatus); Assert.Equal(.1m, state.ReservedCostUsd);
            Assert.Equal(0, persisted); Assert.Empty(state.History);
        }
    }
}
