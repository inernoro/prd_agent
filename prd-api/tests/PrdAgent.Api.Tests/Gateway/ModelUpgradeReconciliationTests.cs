using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Moq;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.ModelUpgrades;
using PrdAgent.LlmGw.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class ModelUpgradeReconciliationTests
{
    private sealed class Store
    {
        public Mock<IMongoDatabase> Database { get; } = new(MockBehavior.Strict);
        public Mock<IMongoCollection<ModelUpgradeState>> States { get; } = new(MockBehavior.Strict);
        public List<BsonDocument> AuditRecords { get; } = [];
        public ModelUpgradeState State { get; } = new() { Id = "policy", TenantId = "tenant", LogicalModelId = "stable", ActorConsoleUserId = "actor", ActorUsername = "admin",
            PendingAction = "await-validation", Phase = "validating", ValidationStatus = "pending", BudgetDate = DateTime.UtcNow.ToString("yyyy-MM-dd"), ReservedCostUsd = .05m,
            Candidate = new() { ModelId = "candidate", ProviderId = "provider", UpstreamModelId = "candidate", ValidationRequestId = "original-request", Fingerprint = "original-fingerprint" } };
        public ModelUpgradeService Service { get; }
        public Store()
        {
            Database.Setup(x => x.GetCollection<ModelUpgradeState>(ModelUpgradeService.CollectionName, It.IsAny<MongoCollectionSettings>())).Returns(States.Object);
            States.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<ModelUpgradeState>>(), It.IsAny<FindOptions<ModelUpgradeState, ModelUpgradeState>>(), It.IsAny<CancellationToken>())).Returns(() => Task.FromResult(Cursor(new[] { State })));
            States.Setup(x => x.FindOneAndUpdateAsync(It.IsAny<FilterDefinition<ModelUpgradeState>>(), It.IsAny<UpdateDefinition<ModelUpgradeState>>(), It.IsAny<FindOneAndUpdateOptions<ModelUpgradeState, ModelUpgradeState>>(), It.IsAny<CancellationToken>()))
                .Returns<FilterDefinition<ModelUpgradeState>, UpdateDefinition<ModelUpgradeState>, FindOneAndUpdateOptions<ModelUpgradeState, ModelUpgradeState>, CancellationToken>((_, update, _, _) =>
                {
                    var doc = update.Render(new RenderArgs<ModelUpgradeState>(BsonSerializer.LookupSerializer<ModelUpgradeState>(), BsonSerializer.SerializerRegistry));
                    State.LeaseToken = doc["$set"]["LeaseToken"].AsString; State.LeaseUntil = doc["$set"]["LeaseUntil"].ToUniversalTime(); State.Version++;
                    return Task.FromResult(State);
                });
            States.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<ModelUpgradeState>>(), It.IsAny<UpdateDefinition<ModelUpgradeState>>(), It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>()))
                .Callback<FilterDefinition<ModelUpgradeState>, UpdateDefinition<ModelUpgradeState>, UpdateOptions, CancellationToken>((_, update, _, _) =>
                {
                    var doc = update.Render(new RenderArgs<ModelUpgradeState>(BsonSerializer.LookupSerializer<ModelUpgradeState>(), BsonSerializer.SerializerRegistry));
                    if (doc["$set"].AsBsonDocument.TryGetValue("LeaseUntil", out var until)) State.LeaseUntil = until.IsBsonNull ? null : until.ToUniversalTime();
                    if (doc["$set"].AsBsonDocument.TryGetValue("LeaseToken", out var token)) State.LeaseToken = token.IsBsonNull ? null : token.AsString;
                }).ReturnsAsync(new UpdateResult.Acknowledged(1, 1, null));
            States.Setup(x => x.ReplaceOneAsync(It.IsAny<FilterDefinition<ModelUpgradeState>>(), It.IsAny<ModelUpgradeState>(), It.IsAny<ReplaceOptions>(), It.IsAny<CancellationToken>())).ReturnsAsync(new ReplaceOneResult.Acknowledged(1, 1, null));
            var audits = Collection<BsonDocument>("llmgw_operation_audits", _ => AuditRecords);
            audits.Setup(x => x.InsertOneAsync(It.IsAny<BsonDocument>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>())).Callback<BsonDocument, InsertOneOptions, CancellationToken>((doc, _, _) => AuditRecords.Add(doc.DeepClone().AsBsonDocument)).Returns(Task.CompletedTask);
            audits.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<BsonDocument>>(), It.IsAny<UpdateDefinition<BsonDocument>>(), It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>()))
                .Returns<FilterDefinition<BsonDocument>, UpdateDefinition<BsonDocument>, UpdateOptions, CancellationToken>((filter, update, _, _) =>
                {
                    var id = filter.Render(new RenderArgs<BsonDocument>(BsonSerializer.LookupSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry))["_id"];
                    Apply(AuditRecords.Single(x => x["_id"] == id), update);
                    return Task.FromResult<UpdateResult>(new UpdateResult.Acknowledged(1, 1, null));
                });
            Service = new(Database.Object, Database.Object, Mock.Of<IModelUpgradeDiscovery>(MockBehavior.Strict), "tenant", NullLogger<ModelUpgradeService>.Instance, ModelUpgradeTestConfiguration.AuthorizedProduction());
        }
        public Mock<IMongoCollection<T>> Collection<T>(string name, Func<FilterDefinition<T>, IEnumerable<T>> data)
        {
            var collection = new Mock<IMongoCollection<T>>(MockBehavior.Strict);
            collection.Setup(x => x.FindAsync(It.IsAny<FilterDefinition<T>>(), It.IsAny<FindOptions<T, T>>(), It.IsAny<CancellationToken>()))
                .Returns<FilterDefinition<T>, FindOptions<T, T>, CancellationToken>((filter, _, _) => Task.FromResult(Cursor(data(filter))));
            Database.Setup(x => x.GetCollection<T>(name, It.IsAny<MongoCollectionSettings>())).Returns(collection.Object);
            return collection;
        }
        public void Actor(bool active, string id = "actor")
        {
            Collection<BsonDocument>("llmgw_console_users", _ => active ? new[] { new BsonDocument("_id", id) } : []);
            Collection<LlmGwMembership>("llmgw_memberships", _ => new[] { new LlmGwMembership { Id = "member", TenantId = "tenant", UserId = id, Role = "admin", Status = "active" } });
            Collection<LlmGwTenant>("llmgw_tenants", _ => new[] { new LlmGwTenant { Id = "tenant", Status = "active" } });
        }
        private static IAsyncCursor<T> Cursor<T>(IEnumerable<T> docs)
        {
            var cursor = new Mock<IAsyncCursor<T>>(); cursor.SetupGet(x => x.Current).Returns(docs);
            cursor.SetupSequence(x => x.MoveNextAsync(It.IsAny<CancellationToken>())).ReturnsAsync(true).ReturnsAsync(false); return cursor.Object;
        }
        public static void Apply(BsonDocument doc, UpdateDefinition<BsonDocument> update)
        {
            var ops = update.Render(new RenderArgs<BsonDocument>(BsonSerializer.LookupSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry));
            if (ops.AsBsonDocument.TryGetValue("$set", out var set)) foreach (var value in set.AsBsonDocument) doc[value.Name] = value.Value;
            if (ops.AsBsonDocument.TryGetValue("$unset", out var unset)) foreach (var value in unset.AsBsonDocument) doc.Remove(value.Name);
        }
    }
    [Fact]
    public async Task CandidateChangeRetainsOriginalRequestLockAndConfirmedUnsentCanStillReconcile()
    {
        var store = new Store(); store.Actor(true);
        store.Collection<BsonDocument>("llmgw_logical_models", _ => new[] { new BsonDocument { { "_id", "stable" }, { "IdentityKind", "stable" }, { "Enabled", true } } });
        store.Collection<BsonDocument>("llmgw_platforms", _ => new[] { new BsonDocument { { "_id", "provider" }, { "Enabled", false } } });
        store.Collection<BsonDocument>("llmgw_models", _ => new[] { new BsonDocument { { "_id", "candidate" }, { "Enabled", true } } });
        var job = new BsonDocument { { "_id", "original-request" }, { "PolicyId", "policy" }, { "Status", "running" }, { "ExpiresAt", DateTime.UtcNow.AddMinutes(5) }, { "CreatedAt", DateTime.UtcNow }, { "EstimatedCostUsd", new Decimal128(.05m) } };
        var queue = store.Collection<BsonDocument>(ModelUpgradeService.ValidationCollectionName, _ => new[] { job });
        await store.Service.TickAsync(CancellationToken.None);
        Assert.True(store.State.OutcomeUnknown); Assert.Equal("unknown", store.State.ValidationStatus); Assert.Equal("", store.State.PendingAction);
        Assert.Equal("original-request", store.State.Candidate!.ValidationRequestId); Assert.Equal(.05m, store.State.ReservedCostUsd);
        var actor = new TenantAccessContext("tenant", "", true, "admin", "admin", "member", 1, "admin", []);
        var blocked = await Assert.ThrowsAsync<ModelUpgradeException>(() => store.Service.QueueAsync(actor, "stable", "check", new() { Version = store.State.Version }));
        Assert.Equal("OUTCOME_UNKNOWN", blocked.Code);
        var paid = await Assert.ThrowsAsync<ModelUpgradeException>(() => store.Service.QueueAsync(actor, "stable", "validate", new() { Version = store.State.Version, Mode = "canary", RequestId = "original-request" }));
        Assert.Equal("OUTCOME_UNKNOWN", paid.Code);
        store.Collection<BsonDocument>("llmgw_model_offerings", _ => []);
        await store.Service.SavePolicyAsync(actor, "stable", new() { Version = store.State.Version });
        Assert.True(store.State.OutcomeUnknown); Assert.Equal("original-request", store.State.Candidate!.ValidationRequestId);
        store.Actor(true, "admin");
        await store.Service.QueueAsync(actor, "stable", "validate", new() { Version = store.State.Version, Mode = "evidence", RequestId = "original-request" });
        Assert.Equal("await-validation", store.State.PendingAction);
        job["Status"] = "failed"; job["UnsentConfirmed"] = true;
        await store.Service.TickAsync(CancellationToken.None);
        Assert.False(store.State.OutcomeUnknown); Assert.Equal("not-run", store.State.ValidationStatus); Assert.Equal("", store.State.PendingAction);
        Assert.Equal(0m, store.State.ReservedCostUsd); Assert.Equal("original-request", store.State.Candidate.ValidationRequestId);
        queue.Verify(x => x.InsertOneAsync(It.IsAny<BsonDocument>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()), Times.Never);
    }
    [Fact]
    public async Task ActorRevocationBeforePollingAlsoPreservesRequestAndUnknownLock()
    {
        var store = new Store(); store.Actor(false);
        await store.Service.TickAsync(CancellationToken.None);
        Assert.True(store.State.OutcomeUnknown); Assert.Equal("unknown", store.State.ValidationStatus); Assert.Equal("", store.State.PendingAction);
        Assert.Equal("original-request", store.State.Candidate!.ValidationRequestId); Assert.Equal(.05m, store.State.ReservedCostUsd);
        Assert.Contains("失去配置权限", store.State.Message);
        store.Collection<BsonDocument>("llmgw_logical_models", _ => new[] { new BsonDocument { { "_id", "stable" }, { "IdentityKind", "stable" }, { "Enabled", true } } });
        store.Collection<BsonDocument>("llmgw_model_offerings", _ => []);
        var replacement = new TenantAccessContext("tenant", "", true, "replacement", "admin", "member", 1, "admin", []);
        await store.Service.SavePolicyAsync(replacement, "stable", new() { Version = store.State.Version });
        Assert.Equal("replacement", store.State.ActorConsoleUserId); Assert.True(store.State.OutcomeUnknown);
        await store.Service.QueueAsync(replacement, "stable", "validate", new() { Version = store.State.Version, Mode = "evidence", RequestId = "original-request" });
        Assert.Equal("await-validation", store.State.PendingAction); Assert.Equal("original-request", store.State.Candidate.ValidationRequestId);
    }
    [Fact]
    public async Task DurableSwitchCompensationFinishesWithoutOriginalActorAuthorityOrNewAction()
    {
        var store = new Store(); store.State.PendingAction = "promote";
        store.State.PendingSwitch = new() { OperationId = "authorized-operation", PreviousOfferingId = "old", NewOfferingId = "new" };
        var old = new BsonDocument { { "_id", "old" }, { "TargetId", "old-model" }, { "Enabled", true }, { "UpgradeOperationId", "authorized-operation" } };
        var next = new BsonDocument { { "_id", "new" }, { "TargetId", "new-model" }, { "Enabled", true }, { "UpgradeOperationId", "authorized-operation" } };
        var offerings = store.Collection<BsonDocument>("llmgw_model_offerings", filter =>
        {
            var id = filter.Render(new RenderArgs<BsonDocument>(BsonSerializer.LookupSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry))["_id"].AsString;
            return new[] { id == "old" ? old : next };
        });
        offerings.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<BsonDocument>>(), It.IsAny<UpdateDefinition<BsonDocument>>(), It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>()))
            .Returns<FilterDefinition<BsonDocument>, UpdateDefinition<BsonDocument>, UpdateOptions, CancellationToken>((filter, update, _, _) =>
            {
                var doc = filter.Render(new RenderArgs<BsonDocument>(BsonSerializer.LookupSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry));
                Assert.Equal("tenant", doc["TenantId"].AsString); Assert.Equal("authorized-operation", doc["UpgradeOperationId"].AsString);
                Store.Apply(doc["_id"] == "old" ? old : next, update); return Task.FromResult<UpdateResult>(new UpdateResult.Acknowledged(1, 1, null));
            });
        // Actor collections and paid queue are deliberately unavailable: recovery must not read them or dispatch anything new.
        await store.Service.TickAsync(CancellationToken.None);
        Assert.Null(store.State.PendingSwitch); Assert.Equal("", store.State.PendingAction); Assert.True(old["Enabled"].AsBoolean); Assert.False(next["Enabled"].AsBoolean);
        Assert.Equal("old-model", old["TargetId"].AsString); Assert.Equal("new-model", next["TargetId"].AsString);
        Assert.Contains("已恢复中断切换", store.State.Message); Assert.Single(store.AuditRecords);
        Assert.True(store.AuditRecords[0]["Success"].AsBoolean);
        offerings.Verify(x => x.InsertOneAsync(It.IsAny<BsonDocument>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()), Times.Never);
    }
}
