using System.Net;
using System.Text;
using Microsoft.Extensions.Configuration;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Moq;
using PrdAgent.LlmGw.ModelUpgrades;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class ModelUpgradeDiscoveryAuditTests
{
    private const string Secret = "audit-only-test-secret";
    private sealed class Handler(Func<HttpResponseMessage> response) : HttpMessageHandler
    {
        public int Calls { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        { Calls++; return Task.FromResult(response()); }
    }
    private sealed class Store
    {
        public Mock<IMongoDatabase> Database { get; } = new(MockBehavior.Strict);
        public Mock<IMongoCollection<BsonDocument>> Collection { get; } = new(MockBehavior.Strict);
        public BsonDocument? Record { get; private set; }
        public Store(bool failWrite = false)
        {
            Database.Setup(x => x.GetCollection<BsonDocument>("llmgw_operation_audits", It.IsAny<MongoCollectionSettings>())).Returns(Collection.Object);
            Collection.Setup(x => x.InsertOneAsync(It.IsAny<BsonDocument>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()))
                .Callback<BsonDocument, InsertOneOptions, CancellationToken>((d, _, _) => Record = d.DeepClone().AsBsonDocument).Returns(Task.CompletedTask);
            Collection.Setup(x => x.UpdateOneAsync(It.IsAny<FilterDefinition<BsonDocument>>(), It.IsAny<UpdateDefinition<BsonDocument>>(), It.IsAny<UpdateOptions>(), It.IsAny<CancellationToken>()))
                .Returns<FilterDefinition<BsonDocument>, UpdateDefinition<BsonDocument>, UpdateOptions, CancellationToken>((filter, update, _, _) =>
                {
                    if (failWrite) return Task.FromException<UpdateResult>(new IOException("audit unavailable"));
                    var f = filter.Render(new RenderArgs<BsonDocument>(BsonSerializer.LookupSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry));
                    Assert.Equal("tenant", f["TenantId"].AsString); Assert.Equal(Record!["_id"], f["_id"]);
                    var set = update.Render(new RenderArgs<BsonDocument>(BsonSerializer.LookupSerializer<BsonDocument>(), BsonSerializer.SerializerRegistry))["$set"].AsBsonDocument;
                    foreach (var item in set) Record![item.Name] = item.Value.DeepClone();
                    return Task.FromResult<UpdateResult>(new UpdateResult.Acknowledged(1, 1, null));
                });
        }
    }
    private static HttpResponseMessage Reply(HttpStatusCode code, string body, string mediaType = "application/json")
    {
        var response = new HttpResponseMessage(code) { Content = new StringContent(body, Encoding.UTF8, mediaType) };
        response.Headers.Add("x-request-id", "req_safe_123"); response.Headers.Add("Set-Cookie", "session=" + Secret);
        return response;
    }
    private static Task<HashSet<string>> Execute(Store store, HttpClient client) => new ModelUpgradeDiscoveryAudit(store.Database.Object,
        new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?> { ["GIT_COMMIT"] = "abc123", [ModelUpgradeDeploymentAuthority.WorkerDeploymentKey] = "project::main" }).Build())
        .ExecuteAsync(new() { Id = "policy", TenantId = "tenant", LogicalModelId = "logical", ActorConsoleUserId = "actor", ActorUsername = "admin" },
            new BsonDocument { { "_id", "provider" }, { "UpdatedAt", DateTime.UtcNow } }, new Uri("https://api.openai.com/v1/models"), client, Secret, CancellationToken.None);
    [Fact]
    public async Task SuccessfulDirectoryPersistsTenantScopedModelIdsWithoutNestedSecretsOrPii()
    {
        var store = new Store(); var handler = new Handler(() => Reply(HttpStatusCode.OK,
            "{\"data\":[{\"id\":\"gpt-image-2.6\",\"access_token\":\"" + Secret + "\",\"nested\":{\"email\":\"private@example.com\"}}]}"));
        using var client = new HttpClient(handler);
        Assert.Contains("gpt-image-2.6", await Execute(store, client));
        var record = store.Record!; var changes = record["Changes"].AsBsonDocument;
        Assert.Equal("completed", record["State"].AsString); Assert.Equal("actor", record["ActorUserId"].AsString);
        Assert.Equal("provider", changes["providerId"].AsString); Assert.Equal("policy", changes["policyId"].AsString);
        Assert.Equal("models-parsed", changes["classification"].AsString);
        Assert.Equal("req_safe_123", changes["safeHeaders"]["x-request-id"].AsString);
        Assert.Contains("gpt-image-2.6", changes["response"]["modelIds"].AsBsonArray.Select(x => x.AsString));
        Assert.DoesNotContain(Secret, record.ToJson()); Assert.DoesNotContain("private@example.com", record.ToJson()); Assert.DoesNotContain("Set-Cookie", record.ToJson());
    }
    [Fact]
    public async Task HttpRejectionPreservesSafeCodeAndReasonCategoryWithoutCredentialMessage()
    {
        var store = new Store(); using var client = new HttpClient(new Handler(() => Reply(HttpStatusCode.Forbidden,
            "{\"error\":{\"code\":\"invalid_api_key\",\"type\":\"authentication_error\",\"message\":\"Invalid API key " + Secret + " for private@example.com\",\"password\":\"other-secret\"}}")));
        var error = await Assert.ThrowsAsync<ModelUpgradeException>(() => Execute(store, client)); Assert.Equal("DISCOVERY_REJECTED", error.Code);
        var changes = store.Record!["Changes"].AsBsonDocument;
        Assert.Equal(403, changes["httpStatus"].AsInt32); Assert.Equal("http-rejected", changes["classification"].AsString);
        Assert.Equal("invalid_api_key", changes["response"]["error"]["code"]["value"].AsString);
        Assert.Equal("authentication-rejected", changes["response"]["error"]["message"]["summary"].AsString);
        Assert.DoesNotContain(Secret, store.Record.ToJson()); Assert.DoesNotContain("other-secret", store.Record.ToJson()); Assert.DoesNotContain("private@example.com", store.Record.ToJson());
    }
    [Theory]
    [InlineData("{invalid", "invalid-json")]
    [InlineData("[]", "invalid-model-list-shape")]
    [InlineData("{\"unexpected\":[]}", "invalid-model-list-shape")]
    [InlineData("{\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"too many requests\"}}", "upstream-business-error")]
    public async Task ParseAndBusinessErrorsHavePersistentDistinctClassifications(string body, string classification)
    {
        var store = new Store(); using var client = new HttpClient(new Handler(() => Reply(HttpStatusCode.OK, body)));
        await Assert.ThrowsAsync<ModelUpgradeException>(() => Execute(store, client));
        Assert.Equal(classification, store.Record!["Changes"]["classification"].AsString);
        Assert.Equal("failed", store.Record["State"].AsString);
    }
    [Fact]
    public void NumericBusinessCodeIsRetainedWithoutUntrustedMessage()
    {
        var snapshot = ModelUpgradeDiscoveryAudit.Snapshot(Encoding.UTF8.GetBytes("{\"error\":{\"code\":403,\"message\":\"private@example.com\"}}"), Secret, false);
        Assert.Equal(403, snapshot["error"]["code"]["value"].AsInt64);
        Assert.DoesNotContain("private@example.com", snapshot.ToJson());
    }
    [Fact]
    public async Task TimeoutRecordsNoResponseWithoutInventingHttpStatus()
    {
        var store = new Store(); using var client = new HttpClient(new Handler(() => throw new TaskCanceledException(Secret)));
        await Assert.ThrowsAsync<ModelUpgradeException>(() => Execute(store, client));
        var changes = store.Record!["Changes"].AsBsonDocument;
        Assert.False(changes["receivedResponse"].AsBoolean); Assert.False(changes.Contains("httpStatus")); Assert.Equal("timeout", changes["classification"].AsString);
        Assert.DoesNotContain(Secret, store.Record.ToJson());
    }
    [Fact]
    public async Task NonJsonAndOversizeBodiesOnlyRetainBoundedSummaryAndDigest()
    {
        var store = new Store(); using var client = new HttpClient(new Handler(() => Reply(HttpStatusCode.OK, "<html>" + Secret + new string('x', ModelUpgradeDiscoveryAudit.BodyLimit) + "</html>", "text/html")));
        await Assert.ThrowsAsync<ModelUpgradeException>(() => Execute(store, client));
        Assert.True(store.Record!["Changes"]["response"]["truncated"].AsBoolean);
        Assert.Equal("response-too-large", store.Record["Changes"]["classification"].AsString);
        Assert.True(store.Record.ToBson().Length < 16_384); Assert.DoesNotContain(Secret, store.Record.ToJson());
    }
    [Fact]
    public async Task AuditWriteFailureBlocksResultInsteadOfReportingSuccess()
    {
        var store = new Store(failWrite: true); using var client = new HttpClient(new Handler(() => Reply(HttpStatusCode.OK, "{\"data\":[]}")));
        var error = await Assert.ThrowsAsync<ModelUpgradeException>(() => Execute(store, client));
        Assert.Equal("DISCOVERY_AUDIT_FAILED", error.Code); Assert.Equal("pending", store.Record!["State"].AsString);
    }
}
