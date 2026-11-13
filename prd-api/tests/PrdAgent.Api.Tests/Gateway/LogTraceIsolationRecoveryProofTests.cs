using Microsoft.Extensions.Logging.Abstractions;
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using PrdAgent.Infrastructure.LLM;
using PrdAgent.LlmGw.Logs;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

/// <summary>同一测试先对 c259f5626 失败，再对修复后通过；只使用独立 Mongo 数据库。</summary>
public class LogTraceIsolationRecoveryProofTests
{
    private static LlmGatewayDataContext CreateData() => new(
        Environment.GetEnvironmentVariable("LLMGW_TRACE_TEST_MONGO")
            ?? Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
            ?? throw new InvalidOperationException("必须显式指定隔离 Mongo：LLMGW_TRACE_TEST_MONGO 或 MONGODB_TEST_CONNECTION"),
        "trace_proof_" + Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task ExplicitDifferentRuns_AreNotMergedByReusedLogicalOrProviderTaskId()
    {
        var data = CreateData();
        try
        {
            var logs = data.Database.GetCollection<BsonDocument>("llmrequestlogs");
            BsonDocument Row(string id, string? run, string logical, string task, string platform) => new()
            {
                { "_id", id }, { "TenantId", "tenant-a" }, { "RunId", run is null ? BsonNull.Value : new BsonString(run) },
                { "LogicalRequestId", logical }, { "ProviderTaskId", task }, { "PlatformId", platform }
            };
            var anchor = Row("anchor", "run-a", "client-reused-id", "job-1", "provider-a");
            await logs.InsertManyAsync(new[] {
                anchor, Row("same-run", "run-a", "another-step", "job-2", "provider-a"),
                Row("independent-logical", "run-b", "client-reused-id", "job-3", "provider-a"),
                Row("independent-job", "run-c", "another-action", "job-1", "provider-a"),
                Row("legacy-null-run", null, "client-reused-id", "job-1", "provider-a"),
                Row("legacy-empty-run", "", "another-step", "job-1", "provider-a"),
                Row("other-provider", null, "different-id", "job-1", "provider-b")
            });
            var related = await logs.Find(LogTraceQuery.Related(anchor)).ToListAsync();
            Assert.Equal(new[] { "anchor", "legacy-empty-run", "legacy-null-run", "same-run" },
                related.Select(x => x["_id"].AsString).OrderBy(x => x, StringComparer.Ordinal).ToArray());
        }
        finally { await data.Database.Client.DropDatabaseAsync(data.DatabaseName); }
    }

    [Fact]
    public async Task LostOwner_CallLoggedAfterLeaseExpiry_DoesNotRemainRunningForever()
    {
        var data = CreateData();
        try
        {
            var now = DateTime.UtcNow;
            await data.Database.GetCollection<BsonDocument>("llmgw_log_writer_leases").InsertOneAsync(
                new BsonDocument { { "_id", "lost-owner" }, { "LastSeenAt", now.AddMinutes(-10) }, { "ExpiresAt", now.AddMinutes(-7) } });
            await data.LlmRequestLogs.InsertOneAsync(new LlmRequestLog {
                Id = "logged-after-last-lease", TenantId = "tenant-a", WriterInstanceId = "lost-owner",
                StartedAt = now.AddMinutes(-1), Status = "running"
            });
            var worker = new LlmLogLifecycleReconciler(data, new LlmLogOwner(), NullLogger<LlmLogLifecycleReconciler>.Instance);
            await worker.TickAsync(CancellationToken.None);
            var row = await data.LlmRequestLogs.Find(x => x.Id == "logged-after-last-lease").SingleAsync();
            Assert.Equal("unknown", row.Status);
            Assert.Null(row.EndedAt);
            Assert.Null(row.ProviderReportedCost);
            Assert.Null(row.InputTokens);
            Assert.Contains("WRITER_LEASE_EXPIRED", row.LifecycleReason);
        }
        finally { await data.Database.Client.DropDatabaseAsync(data.DatabaseName); }
    }

    [Fact]
    public async Task ConcurrentReconciliationAndCompletion_PreserveConfirmedTerminalResults()
    {
        var data = CreateData();
        try
        {
            var now = DateTime.UtcNow;
            await data.Database.GetCollection<BsonDocument>("llmgw_log_writer_leases").InsertOneAsync(
                new BsonDocument { { "_id", "lost-owner" }, { "LastSeenAt", now.AddMinutes(-10) }, { "ExpiresAt", now.AddMinutes(-7) } });
            await data.LlmRequestLogs.InsertManyAsync(Enumerable.Range(0, 50).Select(index => new LlmRequestLog {
                Id = "concurrent-" + index, TenantId = "tenant-a", WriterInstanceId = "lost-owner",
                StartedAt = now.AddMinutes(-9), Status = "running"
            }));
            var a = new LlmLogLifecycleReconciler(data, new LlmLogOwner(), NullLogger<LlmLogLifecycleReconciler>.Instance);
            var b = new LlmLogLifecycleReconciler(data, new LlmLogOwner(), NullLogger<LlmLogLifecycleReconciler>.Instance);
            await Task.WhenAll(a.TickAsync(CancellationToken.None), b.TickAsync(CancellationToken.None),
                data.LlmRequestLogs.UpdateManyAsync(x => x.WriterInstanceId == "lost-owner",
                    Builders<LlmRequestLog>.Update.Set(x => x.Status, "succeeded").Set(x => x.EndedAt, now)
                        .Set(x => x.ProviderReportedCost, 0.20m).Set(x => x.ProviderCostCurrency, "USD")));
            await a.TickAsync(CancellationToken.None);
            var rows = await data.LlmRequestLogs.Find(x => x.WriterInstanceId == "lost-owner").ToListAsync();
            Assert.Equal(50, rows.Count);
            Assert.All(rows, row => {
                Assert.Equal("succeeded", row.Status);
                Assert.NotNull(row.EndedAt);
                Assert.Equal(0.20m, row.ProviderReportedCost);
            });
        }
        finally { await data.Database.Client.DropDatabaseAsync(data.DatabaseName); }
    }
}
