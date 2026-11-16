using System.Net;
using System.Text.Json.Nodes;
using PrdAgent.Api.Services.ModelLeaderboard;
using Xunit;

namespace PrdAgent.Tests;

public class HuggingFaceLeaderboardFetcherTests
{
    // 2026-11-16 从官方 latest 实抓：保留同五个模型，不改行内字段；
    // 仅截短分页并重编号 row_idx。各分项保留各自真实排序，验证按名字而非行号关联。
    private static JsonObject Fixture()
    {
        var root = new DirectoryInfo(AppContext.BaseDirectory);
        while (root is not null && !File.Exists(Path.Combine(root.FullName, "prd-api", "PrdAgent.sln")))
            root = root.Parent;
        Assert.NotNull(root);
        return JsonNode.Parse(File.ReadAllText(Path.Combine(root!.FullName,
            "prd-api", "tests", "PrdAgent.Tests", "fixtures", "arena-hf-agent.json")))!.AsObject();
    }

    private sealed class Handler(Func<Uri, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            => Task.FromResult(respond(request.RequestUri!));
    }

    private static string Query(Uri uri, string name) => Uri.UnescapeDataString(uri.Query.TrimStart('?')
        .Split('&').Single(p => p.StartsWith(name + "=", StringComparison.Ordinal))[(name.Length + 1)..]);

    private static HttpResponseMessage Json(JsonNode node, HttpStatusCode status = HttpStatusCode.OK)
        => new(status) { Content = new StringContent(node.ToJsonString(), System.Text.Encoding.UTF8, "application/json") };

    private static HttpClient Client(JsonObject fixture) => new(new Handler(uri => Json(fixture[Query(uri, "config")]!)));

    private sealed class Fallback : IModelLeaderboardFetcher
    {
        public int Calls { get; private set; }
        public ArenaLeaderboardFetcher.ParseResult Result { get; } = new(BoardKind.Agent, [], null, null);
        public Task<ArenaLeaderboardFetcher.ParseResult> FetchAsync(string board, CancellationToken ct)
        {
            Calls++;
            return Task.FromResult(Result);
        }
    }

    [Fact]
    public async Task Agent_真实分项按模型名关联_百分比及幻觉方向正确()
    {
        var evidence = new List<HuggingFaceLeaderboardFetcher.ResponseEvidence>();
        var fetcher = new HuggingFaceLeaderboardFetcher(Client(Fixture()), e => { evidence.Add(e); return Task.CompletedTask; });
        var result = await fetcher.FetchAsync("agent", default);
        Assert.Equal(5, result.Entries.Count);
        var e = result.Entries.Single(x => x.Name == "Claude Fable 5.2 (Max)");
        Assert.Equal(28.612631840600056, e.NetImprovement!.Value, 8);
        Assert.Equal(3.721268594203629, e.NetImprovement.Margin!.Value, 8);
        Assert.Equal(19.41220243047772, e.ConfirmedSuccess!.Value, 8);
        Assert.Equal(76.01511696610654, e.PraiseVsComplaint!.Value, 8);
        Assert.Equal(25.50742961645536, e.Steerability!.Value, 8);
        Assert.Equal(13.573113719448915, e.BashReliability!.Value, 8);
        Assert.Null(e.BashRecovery);
        Assert.Equal(-1.0355374099361825, e.ToolHallucination!.Value, 8);
        Assert.Equal(10406, e.Sessions);
        Assert.Equal(new DateTime(2026, 11, 15, 0, 0, 0, DateTimeKind.Utc), result.PublishedAt);
        Assert.Null(result.SourceFetchedAt);
        Assert.Contains("huggingface.co", result.SourceUrl!);
        Assert.Equal(12, evidence.Count);
        Assert.All(evidence.Take(6), item => Assert.Equal("received", item.Outcome));
        Assert.Equal(evidence.Take(6).Select(x => x.AuditId).Order(), evidence.Skip(6).Select(x => x.AuditId).Order());
        Assert.All(evidence.Skip(6), item => { Assert.Equal("success", item.Outcome); Assert.NotNull(item.Sha256); });
        Assert.Contains("0.286126", evidence[0].Summary);
        Assert.Contains("2026-11-15", evidence[0].Summary);
    }

    [Theory]
    [InlineData("date")]
    [InlineData("missing_model")]
    [InlineData("duplicate_model")]
    [InlineData("partial")]
    [InlineData("truncated")]
    [InlineData("future")]
    public async Task Agent_不完整或跨日期的数据不得成为新快照(string broken)
    {
        var fixture = Fixture();
        var page = fixture["agent_task_outcome_explicit"]!;
        var rows = page["rows"]!.AsArray();
        switch (broken)
        {
            case "date":
                foreach (var row in rows) row!["row"]!["leaderboard_publish_date"] = "2026-11-14";
                break;
            case "future":
                foreach (var row in rows) row!["row"]!["leaderboard_publish_date"] = "2099-01-01";
                break;
            case "missing_model": rows[0]!["row"]!["model_name"] = "Unknown source model"; break;
            case "duplicate_model": rows[0]!["row"]!["model_name"] = rows[1]!["row"]!["model_name"]!.GetValue<string>(); break;
            case "partial": page["partial"] = true; break;
            case "truncated": rows[0]!["truncated_cells"]!.AsArray().Add("score"); break;
        }
        var latest = new Dictionary<string, HuggingFaceLeaderboardFetcher.ResponseEvidence>();
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() => new HuggingFaceLeaderboardFetcher(Client(fixture),
            e => { latest[e.AuditId] = e; return Task.CompletedTask; }).FetchAsync("agent", default));
        Assert.DoesNotContain(latest.Values, e => e.Outcome == "success");
        if (broken == "missing_model")
            Assert.Contains(latest.Values, e => e.Summary.Contains("missing_model_association"));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("null")]
    [InlineData("type_mismatch")]
    public async Task 样本外的指标异常也写入最终失败审计且不保存字符串值(string state)
    {
        var fixture = Fixture();
        var row = fixture["agent"]!["rows"]![4]!["row"]!.AsObject();
        if (state == "missing") row.Remove("score");
        else row["score"] = state == "null" ? null : JsonValue.Create("private_text");
        var latest = new Dictionary<string, HuggingFaceLeaderboardFetcher.ResponseEvidence>();
        await Assert.ThrowsAnyAsync<InvalidOperationException>(() => new HuggingFaceLeaderboardFetcher(Client(fixture),
            e => { latest[e.AuditId] = e; return Task.CompletedTask; }).FetchAsync("agent", default));
        var saved = Assert.Single(latest.Values);
        Assert.Equal("semantic_failed", saved.Outcome);
        Assert.Contains("score", saved.Summary);
        Assert.Contains(state, saved.Summary);
        Assert.DoesNotContain("private_text", saved.Summary);
    }

    [Fact]
    public async Task 最终校验审计写入失败不发布也不调用备用源()
    {
        var fallback = new Fallback();
        await Assert.ThrowsAsync<HuggingFaceLeaderboardFetcher.AuditException>(() =>
            new HuggingFaceLeaderboardFetcher(Client(Fixture()), e => e.Outcome == "success"
                ? Task.FromException(new TimeoutException()) : Task.CompletedTask, fallback).FetchAsync("agent", default));
        Assert.Equal(0, fallback.Calls);
    }

    private static JsonObject ScoreRow(int i, string category = "overall") => new()
    {
        ["model_name"] = "Pagination model " + i, ["organization"] = "anthropic", ["license"] = "Proprietary",
        ["rating"] = 1825.9621938325238, ["rating_lower"] = 1807.1552146756683, ["rating_upper"] = 1844.7691729893788,
        ["vote_count"] = 1445.0, ["rank"] = i + 1, ["category"] = category, ["leaderboard_publish_date"] = "2026-11-15",
    };

    private static JsonObject ScorePage(Uri uri, bool wrongTotal = false)
    {
        var offset = int.Parse(Query(uri, "offset"));
        var rows = new JsonArray();
        for (var i = offset; i < Math.Min(offset + 100, 106); i++)
            rows.Add(new JsonObject { ["row_idx"] = i, ["row"] = ScoreRow(i, i == 105 ? "coding" : "overall"), ["truncated_cells"] = new JsonArray() });
        return new() { ["partial"] = false, ["num_rows_total"] = wrongTotal && offset > 0 ? 107 : 106, ["rows"] = rows };
    }

    [Fact]
    public async Task Score_完整读完分页_只取overall_浮点整数票数不丢失()
    {
        var offsets = new List<string>();
        var client = new HttpClient(new Handler(uri =>
        {
            Assert.Equal("webdev", Query(uri, "config"));
            offsets.Add(Query(uri, "offset")); return Json(ScorePage(uri));
        }));
        var result = await new HuggingFaceLeaderboardFetcher(client).FetchAsync("code", default);
        Assert.Equal(new[] { "0", "100" }, offsets);
        Assert.Equal(105, result.Entries.Count);
        Assert.Equal(105, result.Entries[^1].Rank);
        Assert.Equal(1445, result.Entries[0].Votes);
        Assert.Equal(1825.9621938325238, result.Entries[0].Score);
        Assert.Equal(18.8069791568555, result.Entries[0].ScoreMarginDown!.Value, 8);
    }

    [Fact]
    public async Task Score_翻页时总数变化必须拒绝()
    {
        var client = new HttpClient(new Handler(uri => Json(ScorePage(uri, wrongTotal: true))));
        await Assert.ThrowsAsync<InvalidOperationException>(() => new HuggingFaceLeaderboardFetcher(client).FetchAsync("code", default));
    }

    [Fact]
    public async Task Http失败保留响应证据_额外凭据字段与Bearer不得进入审计()
    {
        HuggingFaceLeaderboardFetcher.ResponseEvidence? evidence = null;
        var client = new HttpClient(new Handler(_ => Json(new JsonObject
        {
            ["error"] = "Service unavailable; Bearer secret_should_not_be_saved",
            ["access_token"] = "private_token_value",
        }, HttpStatusCode.ServiceUnavailable)));
        var fetcher = new HuggingFaceLeaderboardFetcher(client, e => { evidence = e; return Task.CompletedTask; });
        await Assert.ThrowsAsync<HttpRequestException>(() => fetcher.FetchAsync("agent", default));
        Assert.NotNull(evidence);
        Assert.Equal(503, evidence!.StatusCode);
        Assert.Equal("failed", evidence.Outcome);
        Assert.Contains("Service unavailable", evidence.Summary);
        Assert.DoesNotContain("secret_should_not_be_saved", evidence.Summary);
        Assert.DoesNotContain("private_token_value", evidence.Summary);
    }

    [Fact]
    public async Task 无效Json保持格式异常_审计区分收到响应与网络失败()
    {
        HuggingFaceLeaderboardFetcher.ResponseEvidence? evidence = null;
        var client = new HttpClient(new Handler(_ => new(HttpStatusCode.OK) { Content = new StringContent("<html>invalid</html>") }));
        await Assert.ThrowsAsync<InvalidOperationException>(() => new HuggingFaceLeaderboardFetcher(client,
            e => { evidence = e; return Task.CompletedTask; }).FetchAsync("agent", default));
        Assert.Equal(200, evidence!.StatusCode);
        Assert.Equal("JsonReaderException", evidence.ErrorType);
        Assert.True(evidence.Bytes > 0);
    }

    [Fact]
    public async Task Score_同名但不同名次的官方记录均保留()
    {
        var client = new HttpClient(new Handler(uri =>
        {
            var page = ScorePage(uri);
            if (Query(uri, "offset") == "0")
                page["rows"]![1]!["row"]!["model_name"] = page["rows"]![0]!["row"]!["model_name"]!.GetValue<string>();
            return Json(page);
        }));
        var result = await new HuggingFaceLeaderboardFetcher(client).FetchAsync("code", default);
        Assert.Equal(105, result.Entries.Count);
        Assert.Equal(result.Entries[0].Name, result.Entries[1].Name);
        Assert.NotEqual(result.Entries[0].Rank, result.Entries[1].Rank);
    }

    [Fact]
    public async Task 审计写入失败不能被当成超时而绕到备用源()
    {
        var fallback = new Fallback();
        await Assert.ThrowsAsync<HuggingFaceLeaderboardFetcher.AuditException>(
            () => new HuggingFaceLeaderboardFetcher(Client(Fixture()),
                _ => Task.FromException(new TaskCanceledException()), fallback).FetchAsync("agent", default));
        Assert.Equal(0, fallback.Calls);
    }

    [Fact]
    public async Task 上游失败也保留响应证据并排除额外凭据字段()
    {
        HuggingFaceLeaderboardFetcher.ResponseEvidence? evidence = null;
        var client = new HttpClient(new Handler(_ => Json(new JsonObject
        {
            ["error"] = "service busy", ["access_token"] = "must-never-be-stored",
        }, HttpStatusCode.ServiceUnavailable)));
        await Assert.ThrowsAsync<HttpRequestException>(() => new HuggingFaceLeaderboardFetcher(client,
            e => { evidence = e; return Task.CompletedTask; }).FetchAsync("agent", default));
        Assert.Equal(503, evidence!.StatusCode);
        Assert.Contains("service busy", evidence.Summary);
        Assert.DoesNotContain("must-never-be-stored", evidence.Summary);
    }

    [Fact]
    public async Task 限流先保存失败证据_冷却后仅重试一次()
    {
        var calls = 0;
        var waits = new List<TimeSpan>();
        var evidence = new List<HuggingFaceLeaderboardFetcher.ResponseEvidence>();
        var client = new HttpClient(new Handler(uri => ++calls == 1
            ? Json(new JsonObject { ["error"] = "rate limited" }, HttpStatusCode.TooManyRequests)
            : Json(Fixture()[Query(uri, "config")]!)));
        var result = await new HuggingFaceLeaderboardFetcher(client,
            e => { evidence.Add(e); return Task.CompletedTask; },
            delay: (wait, _) => { waits.Add(wait); return Task.CompletedTask; }).FetchAsync("agent", default);
        Assert.Equal(5, result.Entries.Count);
        Assert.Equal(TimeSpan.FromMinutes(5), Assert.Single(waits));
        var failed = Assert.Single(evidence.Where(e => e.StatusCode == 429));
        Assert.Equal("failed", failed.Outcome);
        Assert.Equal(300, failed.RetryAfterSeconds);
        Assert.Equal(6, evidence.Count(e => e.Outcome == "success"));
    }

    [Theory]
    [InlineData(45)]
    [InlineData(600)]
    public async Task 限流遵守RetryAfter_超出等待预算不提前重试(int seconds)
    {
        var calls = 0;
        var waits = new List<TimeSpan>();
        var fallback = new Fallback();
        var client = new HttpClient(new Handler(_ =>
        {
            calls++;
            var response = Json(new JsonObject(), HttpStatusCode.TooManyRequests);
            response.Headers.RetryAfter = new(TimeSpan.FromSeconds(seconds));
            return response;
        }));
        await new HuggingFaceLeaderboardFetcher(client, fallback: fallback,
            delay: (wait, _) => { waits.Add(wait); return Task.CompletedTask; }).FetchAsync("agent", default);
        Assert.Equal(seconds > 300 ? 1 : 2, calls);
        if (seconds > 300) Assert.Empty(waits);
        else Assert.Equal(TimeSpan.FromSeconds(seconds), Assert.Single(waits));
        Assert.Equal(1, fallback.Calls);
    }

    [Fact]
    public async Task 官方源网络失败时继续保留既有备用源恢复能力()
    {
        var fallback = new Fallback();
        var client = new HttpClient(new Handler(_ => Json(new JsonObject { ["error"] = "unavailable" }, HttpStatusCode.ServiceUnavailable)));
        var result = await new HuggingFaceLeaderboardFetcher(client, fallback: fallback).FetchAsync("agent", default);
        Assert.Same(fallback.Result, result);
        Assert.Equal(1, fallback.Calls);
    }
}
