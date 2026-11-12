using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.LlmGw.Auth;
using PrdAgent.LlmGw.Logs;
using PrdAgent.LlmGw.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class LogTraceQueryTests
{
    [Fact, Trait("Category", "Integration")]
    public async Task Trace_PagesEveryAuthorizedCall_RejectsAmbiguity_AndWithholdsBodies()
    {
        var connection = Environment.GetEnvironmentVariable("LLMGW_TRACE_TEST_MONGO")
            ?? throw new InvalidOperationException("显式指定隔离 Mongo：LLMGW_TRACE_TEST_MONGO");
        var mongo = new MongoClient(connection);
        var db = mongo.GetDatabase("trace_query_" + Guid.NewGuid().ToString("N"));
        try
        {
            var logs = db.GetCollection<BsonDocument>("logs");
            var rows = Enumerable.Range(0, 55).Select(i => new BsonDocument {
                { "_id", "call-" + i.ToString("D2") }, { "TenantId", "tenant-a" }, { "TeamId", "team-a" },
                { "RunId", "run-a" }, { "RequestId", "request-" + i }, { "StartedAt", DateTime.UtcNow },
                { "Status", "failed" }, { "RequestBodyRedacted", "private prompt must not escape" },
                { "UserId", "another-user" }, { "ProviderTaskId", "job-1" }, { "PlatformId", "provider-a" }
            }).ToList();
            rows.Add(new BsonDocument { { "_id", "foreign-tenant" }, { "TenantId", "tenant-b" }, { "RunId", "run-a" } });
            rows.Add(new BsonDocument { { "_id", "foreign-team" }, { "TenantId", "tenant-a" }, { "TeamId", "team-b" }, { "RunId", "run-a" }, { "ProviderTaskId", "job-1" }, { "PlatformId", "provider-a" } });
            rows.Add(new BsonDocument { { "_id", "job-collision" }, { "TenantId", "tenant-a" }, { "TeamId", "team-a" }, { "ProviderTaskId", "job-1" }, { "PlatformId", "provider-b" } });
            rows.Add(new BsonDocument { { "_id", "independent" }, { "TenantId", "tenant-a" }, { "TeamId", "team-a" }, { "RequestId", "request-0" }, { "RunId", "run-b" } });
            await logs.InsertManyAsync(rows);
            var builder = WebApplication.CreateBuilder();
            builder.WebHost.UseTestServer();
            builder.Services.AddAuthorization(options => options.AddPolicy("LogsRead", policy => policy.RequireAssertion(_ => true)));
            await using var app = builder.Build();
            app.UseRouting();
            app.Use(async (http, next) => {
                http.Items[TenantAccess.ItemKey] = new TenantAccessContext("tenant-a", "A", false, "viewer", "viewer", "member", 1, "viewer", new[] { "team-a" });
                await next();
            });
            app.UseAuthorization();
            app.MapLogTraceEndpoints(logs, db,
                doc => new LlmLogListItem { Id = doc["_id"].AsString, RequestId = LogTraceQuery.Text(doc, "RequestId") ?? "", Status = LogTraceQuery.Text(doc, "Status") ?? "" },
                _ => new(), new JsonSerializerOptions(JsonSerializerDefaults.Web), "internal");
            await app.StartAsync();
            var client = app.GetTestClient();
            var first = await client.GetStringAsync("/gw/logs/trace?reference=run-a");
            using var firstJson = JsonDocument.Parse(first);
            var data = firstJson.RootElement.GetProperty("data");
            Assert.Equal(55, data.GetProperty("total").GetInt32());
            Assert.Equal(50, data.GetProperty("items").GetArrayLength());
            Assert.DoesNotContain("private prompt", first);
            Assert.DoesNotContain("foreign-", first);
            Assert.DoesNotContain("job-collision", first);
            Assert.Equal(JsonValueKind.Null, data.GetProperty("items")[0].GetProperty("log").GetProperty("providerReportedCost").ValueKind);
            using var second = JsonDocument.Parse(await client.GetStringAsync("/gw/logs/trace?reference=run-a&page=2"));
            Assert.Equal(5, second.RootElement.GetProperty("data").GetProperty("items").GetArrayLength());
            using var ambiguous = JsonDocument.Parse(await client.GetStringAsync("/gw/logs/trace?reference=request-0"));
            Assert.True(ambiguous.RootElement.GetProperty("data").GetProperty("ambiguous").GetBoolean());
            var foreign = await client.GetAsync("/gw/logs/trace?reference=foreign-tenant");
            Assert.Equal(System.Net.HttpStatusCode.NotFound, foreign.StatusCode);
            var forgedAnchor = await client.GetAsync("/gw/logs/trace?reference=run-a&anchorId=foreign-team");
            Assert.Equal(System.Net.HttpStatusCode.NotFound, forgedAnchor.StatusCode);
        }
        finally { await mongo.DropDatabaseAsync(db.DatabaseNamespace.DatabaseName); }
    }
}
