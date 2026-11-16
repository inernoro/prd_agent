using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class GatewayLogLifecycleTests
{
    [Fact, Trait("Category", "Integration")]
    public async Task ExpiredOwner_ClosesOnlyItsUnfinishedCalls_WithoutInventingOutcomeOrCost()
    {
        var connection = Environment.GetEnvironmentVariable("LLMGW_TRACE_TEST_MONGO")
            ?? throw new InvalidOperationException("显式指定隔离 Mongo：LLMGW_TRACE_TEST_MONGO");
        var data = new LlmGatewayDataContext(connection, "trace_lifecycle_" + Guid.NewGuid().ToString("N"));
        try
        {
            var now = DateTime.UtcNow;
            var leases = data.Database.GetCollection<BsonDocument>("llmgw_log_writer_leases");
            await leases.InsertManyAsync(new[] {
                new BsonDocument { { "_id", "dead" }, { "LastSeenAt", now.AddMinutes(-5) }, { "ExpiresAt", now.AddMinutes(-2) } },
                new BsonDocument { { "_id", "live" }, { "LastSeenAt", now }, { "ExpiresAt", now.AddMinutes(3) } }
            });
            await data.LlmRequestLogs.InsertManyAsync(new[] {
                new LlmRequestLog { Id = "orphan", TenantId = "a", WriterInstanceId = "dead", StartedAt = now.AddMinutes(-4), Status = "running" },
                new LlmRequestLog { Id = "done", TenantId = "a", WriterInstanceId = "dead", StartedAt = now.AddMinutes(-4), Status = "succeeded", EndedAt = now.AddMinutes(-3), ProviderReportedCost = 0m },
                new LlmRequestLog { Id = "live", TenantId = "b", WriterInstanceId = "live", StartedAt = now.AddHours(-4), Status = "running" },
                new LlmRequestLog { Id = "historical", TenantId = "a", StartedAt = now.AddYears(-1), Status = "running" }
            });
            var worker = new LlmLogLifecycleReconciler(data, new LlmLogOwner(), NullLogger<LlmLogLifecycleReconciler>.Instance);
            await worker.TickAsync(CancellationToken.None);
            await worker.TickAsync(CancellationToken.None);
            var rows = (await data.LlmRequestLogs.Find(_ => true).ToListAsync()).ToDictionary(x => x.Id);
            Assert.Equal("unknown", rows["orphan"].Status);
            Assert.Contains("WRITER_LEASE_EXPIRED", rows["orphan"].LifecycleReason);
            Assert.NotNull(rows["orphan"].LifecycleReconciledAt);
            Assert.Null(rows["orphan"].EndedAt);
            Assert.Null(rows["orphan"].ProviderReportedCost);
            Assert.Null(rows["orphan"].InputTokens);
            Assert.Equal("succeeded", rows["done"].Status);
            Assert.Equal(0m, rows["done"].ProviderReportedCost);
            Assert.Equal("running", rows["live"].Status);
            Assert.Equal("running", rows["historical"].Status);
            // 真实迟到回执可取代未知，后续扫描不能覆盖终态。
            await data.LlmRequestLogs.UpdateOneAsync(x => x.Id == "orphan", Builders<LlmRequestLog>.Update
                .Set(x => x.Status, "succeeded").Set(x => x.EndedAt, now));
            await worker.TickAsync(CancellationToken.None);
            Assert.Equal("succeeded", (await data.LlmRequestLogs.Find(x => x.Id == "orphan").FirstAsync()).Status);
        }
        finally { await data.Database.Client.DropDatabaseAsync(data.DatabaseName); }
    }
}
