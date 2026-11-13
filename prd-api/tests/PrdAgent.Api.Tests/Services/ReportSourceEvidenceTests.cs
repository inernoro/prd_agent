using System.Net;
using System.Text;
using System.Text.Json;
using PrdAgent.Api.Services.ReportAgent;
using PrdAgent.Core.Models;
using MongoDB.Bson.Serialization;
using MongoDB.Driver;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ReportSourceEvidenceTests
{
    private static readonly DateTime From = new(2026, 1, 30, 0, 0, 0, DateTimeKind.Utc);
    private static readonly DateTime To = From.AddDays(4);
    private const string FullSha = "0123456789abcdef0123456789abcdef01234567";

    [Fact]
    public void WorkflowMetadataSurvivesParsingAndMemberAttribution()
    {
        var json = """
        [{"source":"github","collectionWarnings":["来源窗口尚未覆盖完整"],"summary":{"commits":1},"details":[
          {"id":"e-1","title":"联调仍被供应商阻塞","type":"commit","assignee":"author",
           "workItemId":"issue:42","sourceUrl":"https://github.com/example/repo/issues/42",
           "revision":"0123456789abcdef0123456789abcdef01234567","evidenceKind":"blocked",
           "scope":"feature","environment":"preview","blockReason":"供应商账号未提供",
           "nextStep":"由供应商补齐账号","timeBasis":"occurred","timestamp":"2026-01-31T10:30:00+08:00"}]}]
        """;
        var parsed = ArtifactStatsParser.Parse(new() { new() { MimeType = "application/json", InlineContent = json } });
        var attributed = ArtifactStatsParser.SplitByMember(parsed, new()
        {
            new() { UserId = "member", IdentityMappings = new() { ["github"] = "author" } }
        });
        var source = Assert.Single(Assert.Single(attributed).Sources);
        var detail = Assert.Single(source.Details);
        Assert.Equal("issue:42", detail.WorkItemId);
        Assert.Equal(FullSha, detail.Revision);
        Assert.Equal("https://github.com/example/repo/issues/42", detail.SourceUrl);
        Assert.Equal("blocked", detail.EvidenceKind);
        Assert.Equal("feature", detail.Scope);
        Assert.Equal("preview", detail.Environment);
        Assert.Equal("供应商账号未提供", detail.BlockReason);
        Assert.Equal("由供应商补齐账号", detail.NextStep);
        Assert.Equal("occurred", detail.TimeBasis);
        Assert.Equal(new DateTime(2026, 1, 31, 2, 30, 0, DateTimeKind.Utc), detail.Timestamp);
        Assert.Contains("来源窗口尚未覆盖完整", source.CollectionWarnings);
    }

    [Fact]
    public void MemberSummaryIsNotInventedByDividingTeamCounts()
    {
        var team = new TeamCollectedStats { Sources = new() { new()
        {
            SourceType = "github", Summary = new() { ["commits"] = 100, ["lines_added"] = 9999, ["prs_merged"] = 25 },
            Details = new()
            {
                new() { Id = "a", Type = "commit", Assignee = "author" },
                new() { Id = "b", Type = "commit", Assignee = "someone-else" }
            }
        } } };
        var member = Assert.Single(ArtifactStatsParser.SplitByMember(team, new()
        {
            new() { UserId = "member", IdentityMappings = new() { ["github"] = "author" } }
        }));
        var source = Assert.Single(member.Sources);
        Assert.Single(source.Details);
        Assert.Empty(source.Summary);
        Assert.Equal(3, source.CollectionWarnings.Count);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("{\"details\":[]}")]
    public void InvalidWorkflowPayloadRetainsGapThroughMemberSplit(string input)
    {
        var parsed = ArtifactStatsParser.Parse(new() { new() { MimeType = "application/json", InlineContent = input } });
        Assert.Empty(parsed.Sources);
        Assert.NotEmpty(parsed.CollectionWarnings);
        var member = Assert.Single(ArtifactStatsParser.SplitByMember(parsed,new() { new() { UserId = "member" } }));
        Assert.NotEmpty(member.CollectionWarnings);
        Assert.Empty(member.Sources);
    }

    [Fact]
    public void MissingMemberMappingCarriesAvailabilityGapInsteadOfTeamTotals()
    {
        var team = new TeamCollectedStats { Sources = new() { new() { SourceType = "github", Summary = new() { ["commits"] = 50 } } } };
        var member = Assert.Single(ArtifactStatsParser.SplitByMember(team, new() { new() { UserId = "member" } }));
        var source = Assert.Single(member.Sources);
        Assert.Empty(source.Summary);
        Assert.Empty(source.Details);
        Assert.Contains(source.CollectionWarnings, w => w.Contains("身份映射"));
    }

    [Fact]
    public async Task RepoCollectionRetainsFullShaUrlAndActualCommitTime()
    {
        var payload = JsonSerializer.Serialize(new[] { new
        {
            sha = FullSha, html_url = "https://github.com/example/repo/commit/" + FullSha,
            commit = new { message = "跨日功能修复\n更多原文", author = new { date = "2026-01-30T23:30:00Z" }, committer = new { date = "2026-01-31T02:00:00Z" } }
        } });
        var handler = new StubHandler(HttpStatusCode.OK, payload);
        var connector = new PersonalGitHubConnector("fixture-token", "author", "https://github.com/example/repo.git", new(handler));
        var result = await connector.CollectStatsAsync(From, To, default);
        var detail = Assert.Single(result.Details);
        Assert.Equal(FullSha, detail.Id);
        Assert.Equal(FullSha, detail.Revision);
        Assert.Equal("https://github.com/example/repo/commit/" + FullSha, detail.SourceUrl);
        Assert.Equal(new DateTime(2026, 1, 31, 2, 0, 0, DateTimeKind.Utc), detail.Timestamp);
        Assert.Equal("commit", detail.EvidenceKind);
        Assert.Null(detail.WorkItemId);
        Assert.Equal(1, handler.Requests);
    }

    [Fact]
    public async Task PullRequestEventsPreserveMergeEvidenceWithoutClaimingFeatureCompletion()
    {
        var payload = JsonSerializer.Serialize(new object[]
        {
            new { id = "evt-pr", type = "PullRequestEvent", created_at = "2026-01-31T11:00:00Z", payload = new
            {
                action = "closed", pull_request = new
                {
                    html_url = "https://github.com/example/repo/pull/17", title = "同一功能的后续修复", merged = true,
                    state = "closed", merged_at = "2026-01-31T10:59:00Z", merge_commit_sha = FullSha
                }
            } },
            new { id = "evt-push", type = "PushEvent", created_at = "2026-01-31T09:00:00Z", payload = new
            {
                commits = new[] { new { sha = FullSha, message = "修复", url = "https://api.github.com/repos/example/repo/commits/" + FullSha } }
            } }
        });
        var connector = new PersonalGitHubConnector("fixture-token", "author", null, new(new StubHandler(HttpStatusCode.OK,payload)));
        var result = await connector.CollectStatsAsync(From,To,default);
        var pr = Assert.Single(result.Details.Where(d => d.Type == "pull_request"));
        Assert.Equal("https://github.com/example/repo/pull/17", pr.WorkItemId);
        Assert.Equal("merged", pr.EvidenceKind);
        Assert.NotEqual("code_complete", pr.EvidenceKind);
        Assert.Equal(FullSha, pr.Revision);
        Assert.Equal(new DateTime(2026,1,31,10,59,0,DateTimeKind.Utc),pr.Timestamp);
        var commit = Assert.Single(result.Details.Where(d => d.Type == "commit"));
        Assert.Equal(FullSha,commit.Revision);
        Assert.Equal("observed",commit.TimeBasis);
        Assert.Equal(1,result.Summary["commits"]);
        Assert.Equal(1,result.Summary["prs_merged"]);
    }

    [Fact]
    public async Task DifferentPullRequestsWithOneExplicitIssueStayInSameWorkItem()
    {
        var payload = JsonSerializer.Serialize(new[] { 17, 18 }.Select(number => new
        {
            id = "event-" + number, type = "PullRequestEvent", created_at = "2026-01-31T11:00:00Z",
            payload = new { action = "closed", pull_request = new
            {
                html_url = "https://github.com/example/repo/pull/" + number,
                title = "标题不能作为归属依据 " + number, body = "本次修复\nFixes #42",
                merged = true, state = "closed", merged_at = "2026-01-31T10:59:00Z", merge_commit_sha = FullSha
            } }
        }));
        var result = await new PersonalGitHubConnector("fixture-token","author",null,new(new StubHandler(HttpStatusCode.OK,payload))).CollectStatsAsync(From,To,default);
        Assert.Equal(2,result.Details.Count);
        Assert.All(result.Details,d => Assert.Equal("https://github.com/example/repo/issues/42",d.WorkItemId));
        Assert.Equal(2,result.Details.Select(d => d.SourceUrl).Distinct().Count());
        Assert.Equal(2,result.Summary["prs_merged"]);
        Assert.All(result.Details,d => Assert.Equal("merged",d.EvidenceKind));
    }

    [Theory]
    [InlineData("Fixes #42\nCloses #43")]
    [InlineData("Fixes #42, #43")]
    public void AmbiguousClosingIssuesDoNotCollapseDistinctBusinessItems(string body)
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new { body }));
        var warnings = new List<string>();
        Assert.Equal("https://github.com/example/repo/pull/17",PersonalGitHubConnector.ResolvePullRequestWorkItem(doc.RootElement,"https://github.com/example/repo/pull/17",warnings));
        Assert.Contains(warnings,w => w.Contains("不明确"));
    }

    [Fact]
    public void ClosingTextInsideCodeBlockDoesNotCreateIssueAssociation()
    {
        using var doc = JsonDocument.Parse(JsonSerializer.Serialize(new { body = "示例：\n```text\nFixes #42\n```" }));
        var warnings = new List<string>();
        Assert.Equal("https://github.com/example/repo/pull/17",PersonalGitHubConnector.ResolvePullRequestWorkItem(doc.RootElement,"https://github.com/example/repo/pull/17",warnings));
        Assert.Empty(warnings);
    }

    [Fact]
    public async Task FailedRequestIsNotReturnedAsZeroActivity()
    {
        var connector = new PersonalGitHubConnector("fixture-token","author",null,new(new StubHandler(HttpStatusCode.Forbidden,"{\"message\":\"private upstream details\"}")));
        var result = await connector.CollectStatsAsync(From,To,default);
        Assert.Empty(result.Summary);
        Assert.Empty(result.Details);
        Assert.Contains(result.CollectionWarnings,w => w.Contains("HTTP 403"));
        Assert.DoesNotContain(result.CollectionWarnings,w => w.Contains("private upstream details"));
    }

    [Fact]
    public async Task OneHundredCommitPagePreservesRecordsAndSignalsCoverageGap()
    {
        var payload = JsonSerializer.Serialize(Enumerable.Range(0,100).Select(n => new
        {
            sha = n.ToString("x40"), html_url = "https://github.com/example/repo/commit/" + n.ToString("x40"),
            commit = new { message = "已观察的代码记录", committer = new { date = "2026-01-31T02:00:00Z" } }
        }));
        var handler = new StubHandler(HttpStatusCode.OK,payload);
        var result = await new PersonalGitHubConnector("fixture-token","author","https://github.com/example/repo",new(handler)).CollectStatsAsync(From,To,default);
        Assert.Equal(100,result.Details.Count);
        Assert.Contains(result.CollectionWarnings,w => w.Contains("100 条上限"));
        Assert.Equal(1,handler.Requests);
    }

    [Fact]
    public async Task MissingCommitTimestampIsNotReplacedByCollectionTime()
    {
        var payload = JsonSerializer.Serialize(new[] { new { sha = FullSha, commit = new { message = "仅有提交记录" } } });
        var result = await new PersonalGitHubConnector("fixture-token","author","https://github.com/example/repo",new(new StubHandler(HttpStatusCode.OK,payload))).CollectStatsAsync(From,To,default);
        Assert.Null(Assert.Single(result.Details).Timestamp);
        Assert.Contains(result.CollectionWarnings,w => w.Contains("缺少提交时间"));
    }

    [Fact]
    public void TimezoneFreeWorkflowTimestampRemainsUnknown()
    {
        var json = """{"source":"workflow","details":[{"id":"1","type":"task","status":"done","timestamp":"2026-02-01T00:30:00"}]}""";
        var parsed = ArtifactStatsParser.Parse(new() { new() { MimeType = "application/json", InlineContent = json } });
        var source = Assert.Single(parsed.Sources);
        Assert.Null(Assert.Single(source.Details).Timestamp);
        Assert.Null(source.Details[0].EvidenceKind);
        Assert.Contains(source.CollectionWarnings,w => w.Contains("时区"));
    }

    [Fact]
    public void RefreshPreservesExistingCachedIdentityAndWorkAssociation()
    {
        var update = GitHubConnector.BuildCommitRefresh(new ReportCommit { Id = "new-insert-id", CommitHash = FullSha, SourceUrl = "https://github.com/example/repo/commit/" + FullSha });
        var registry = BsonSerializer.SerializerRegistry;
        var rendered = update.Render(new RenderArgs<ReportCommit>(registry.GetSerializer<ReportCommit>(),registry));
        Assert.True(rendered["$setOnInsert"].AsBsonDocument.Contains("_id") || rendered["$setOnInsert"].AsBsonDocument.Contains("Id"));
        var fields = rendered["$set"].AsBsonDocument;
        Assert.DoesNotContain(fields.Names,n => n.Equals("_id",StringComparison.OrdinalIgnoreCase) || n.Equals("Id",StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(fields.Names,n => n.Equals("WorkItemId",StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(fields.Names,n => n.Equals("Additions",StringComparison.OrdinalIgnoreCase));
    }

    private sealed class StubHandler(HttpStatusCode status, string body) : HttpMessageHandler
    {
        public int Requests { get; private set; }
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken cancellationToken)
        {
            Requests++;
            return Task.FromResult(new HttpResponseMessage(status) { Content = new StringContent(body,Encoding.UTF8,"application/json") });
        }
    }
}
