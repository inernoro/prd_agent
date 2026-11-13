using MongoDB.Driver;
using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services.ReportAgent;
using PrdAgent.Infrastructure.Database;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ReportEvidencePersistenceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RegenerationKeepsCurrentSavedEvidenceDuringSourceFailureAndNeverReadsFutureReports(bool recollectSameEvidence)
    {
        var connection = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION") ?? "mongodb://127.0.0.1:27018";
        var name = "report_evidence_regeneration_" + Guid.NewGuid().ToString("N");
        var client = new MongoClient(connection);
        var db = new MongoDbContext(connection, name);
        var start = new DateTime(2026, 1, 5);
        ReportEvidenceLedger Ledger(params ReportEvidenceEvent[] events) => new()
        {
            WorkItems = new() { new() { Id = "export", Title = "批量导出" } }, Events = events.ToList()
        };
        ReportEvidenceEvent Event(string id, DateTime day, string kind, string? scope = null) => new()
        {
            Id = id, WorkItemId = "export", Kind = kind, Revision = "v1", Scope = scope,
            Environment = kind.StartsWith("release_") ? "production" : null,
            OccurredAt = new DateTimeOffset(day, TimeSpan.FromHours(8)),
            Source = new() { Uri = "https://example.test/evidence/" + id, Excerpt = kind }
        };
        WeeklyReport Report(string id, DateTime day, ReportEvidenceLedger ledger, string user = "me", string team = "team") => new()
        {
            Id = id, UserId = user, TeamId = team, PeriodStart = day, PeriodEnd = day.AddDays(6), EvidenceLedger = ledger
        };
        var code = Event("code", start.AddDays(-1), "code_complete");
        var validation = Event("validation", start.AddDays(1), "validation_passed", "feature");
        var saved = Ledger(code, validation);
        try
        {
            await db.WeeklyReports.InsertManyAsync(new[]
            {
                Report("previous", start.AddDays(-7), Ledger(code)),
                Report("current", start, saved),
                Report("future", start.AddDays(7), Ledger(code, validation, Event("future-release", start.AddDays(8), "release_succeeded"))),
                Report("another-user", start, Ledger(Event("other-user", start, "started")), user: "other"),
                Report("another-team", start, Ledger(Event("other-team", start, "started")), team: "other")
            });
            var activity = new CollectedActivity
            {
                PeriodStart = start, PeriodEnd = start.AddDays(6),
                CollectionWarnings = new() { "本次来源暂时不可用，不能按无活动处理。" },
                EvidenceLedger = recollectSameEvidence ? saved : null
            };
            var service = new ReportEvidenceService(db);
            var collected = await service.CollectAsync("me", "team", activity, reportStart: start);
            var snapshot = ReportEvidenceEngine.Build(collected, start, start.AddDays(6));
            var item = Assert.Single(snapshot.Items);
            Assert.Equal("complete", item.CodeStatus);
            Assert.Equal("passed", item.ValidationStatus);
            Assert.Equal("unknown", item.ReleaseStatus);
            Assert.Equal(new[] { "code", "validation" }, collected.Events.Select(e => e.Id));
            Assert.Contains(snapshot.Limitations, text => text.Contains("本次来源暂时不可用"));
            // 日报也读取本周已存证据，但不能提前展示次日的验证或未来周的发布。
            var dailySaved = await service.ReadSavedAsync("me", start, "team");
            var daily = ReportEvidenceEngine.Build(Assert.Single(dailySaved), start, start);
            Assert.Equal("complete", Assert.Single(daily.Items).CodeStatus);
            Assert.Equal("unknown", daily.Items[0].ValidationStatus);
            Assert.DoesNotContain(daily.Items[0].Sources, evidence => evidence.Id is "validation" or "future-release" or "other-user" or "other-team");
        }
        finally { await client.DropDatabaseAsync(name); }
    }
}
