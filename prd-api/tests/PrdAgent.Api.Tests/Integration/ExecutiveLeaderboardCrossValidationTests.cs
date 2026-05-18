using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using MongoDB.Driver;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Database;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Integration;

/// <summary>
/// Executive 排行榜「服务端聚合重构」的交叉验证测试。
///
/// 用户明确要求："别把数据搞错了，注意交叉验证测试代码"。
/// 本测试用一条**独立的暴力重算路径**（直接 Find + 内存分组）重算每个维度的
/// per-user 计数，再与重构后的 `/api/executive/leaderboard` 端点（服务端 $group）
/// 输出逐用户比对，证明"新聚合 == 独立重算"。
///
/// 同时锁定本次口径修正：未解决的缺陷不得计入"解决数"。
///
/// 需要：真实 MongoDB + AI_ACCESS_KEY。CI 跳过（Category=Integration），CDS 灰度跑。
///   cd prd-api
///   dotnet test --filter "FullyQualifiedName~ExecutiveLeaderboardCrossValidationTests" --logger "console;verbosity=detailed"
/// </summary>
[Collection("Integration")]
[Trait("Category", TestCategories.Integration)]
public class ExecutiveLeaderboardCrossValidationTests
    : IClassFixture<WebApplicationFactory<Program>>, IAsyncLifetime
{
    private readonly WebApplicationFactory<Program> _factory;
    private readonly ITestOutputHelper _output;
    private string? _aiAccessKey;

    public ExecutiveLeaderboardCrossValidationTests(WebApplicationFactory<Program> factory, ITestOutputHelper output)
    {
        _factory = factory;
        _output = output;
    }

    private void Log(string m) => _output.WriteLine(m);

    public Task InitializeAsync()
    {
        using var scope = _factory.Services.CreateScope();
        var config = scope.ServiceProvider.GetRequiredService<IConfiguration>();
        _aiAccessKey = (config["AI_ACCESS_KEY"] ?? "").Trim();
        Log(string.IsNullOrWhiteSpace(_aiAccessKey)
            ? "[Init] AI_ACCESS_KEY 未配置，测试将跳过"
            : "[Init] AI_ACCESS_KEY found");
        return Task.CompletedTask;
    }

    public Task DisposeAsync() => Task.CompletedTask;

    private HttpClient CreateClient(string impersonate)
    {
        var c = _factory.CreateClient();
        c.DefaultRequestHeaders.Add("X-AI-Access-Key", _aiAccessKey);
        c.DefaultRequestHeaders.Add("X-AI-Impersonate", impersonate);
        return c;
    }

    private bool Ready => !string.IsNullOrWhiteSpace(_aiAccessKey);

    // 独立复刻 NormalizeAppKey（故意独立实现，作为交叉验证的"另一双眼"）
    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        { "prd-agent-desktop", "prd-agent" }, { "prd-agent-web", "prd-agent" },
        { "open-platform-agent", "open-platform" }, { "workflow-agent", "ai-toolbox" },
        { "tutorial-email", "ai-toolbox" },
    };
    private static readonly HashSet<string> KnownKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "prd-agent", "visual-agent", "literary-agent", "defect-agent",
        "ai-toolbox", "open-platform", "report-agent", "video-agent",
    };
    private static string NormalizeAppKey(string code)
    {
        var dot = code.IndexOf('.');
        var key = dot > 0 ? code[..dot] : code;
        if (Aliases.TryGetValue(key, out var n)) key = n;
        if (!KnownKeys.Contains(key)) key = "admin";
        return key;
    }

    [Fact]
    public async Task Leaderboard_AggregationMatches_IndependentRecompute_AllTime()
    {
        if (!Ready) { Log("[Skip] 无 AI_ACCESS_KEY"); return; }

        var client = CreateClient("admin");
        var resp = await client.GetAsync("/api/executive/leaderboard?days=0");
        if (resp.StatusCode == HttpStatusCode.Forbidden || resp.StatusCode == HttpStatusCode.Unauthorized)
        {
            client = CreateClient("root");
            resp = await client.GetAsync("/api/executive/leaderboard?days=0");
        }
        Assert.Equal(HttpStatusCode.OK, resp.StatusCode);

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var data = body.GetProperty("data");
        var dims = data.GetProperty("dimensions");

        // 端点返回：dimensionKey -> { userId -> count }
        var endpoint = new Dictionary<string, Dictionary<string, int>>();
        foreach (var d in dims.EnumerateArray())
        {
            var key = d.GetProperty("key").GetString()!;
            var vals = new Dictionary<string, int>();
            foreach (var kv in d.GetProperty("values").EnumerateObject())
                vals[kv.Name] = kv.Value.GetInt32();
            endpoint[key] = vals;
        }

        // ── 独立暴力重算（all-time: periodStart = MinValue）──
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<MongoDbContext>();
        var start = DateTime.MinValue;

        var users = await db.Users.Find(_ => true).ToListAsync();
        var userIds = users.Where(u => u.UserType != UserType.Bot).Select(u => u.UserId).ToHashSet();

        // 缺陷：提交 + 解决（口径修正：仅 ResolvedById/ResolvedAt 非空才算解决）
        var allDefects = await db.DefectReports.Find(_ => true).ToListAsync();
        var refDefects = new Dictionary<string, int>();
        foreach (var grp in allDefects.Where(d => userIds.Contains(d.ReporterId))
                                      .GroupBy(d => d.ReporterId))
            refDefects[grp.Key] = grp.Count();
        foreach (var d in allDefects.Where(d => d.ResolvedById != null
                                             && d.ResolvedAt != null
                                             && userIds.Contains(d.ResolvedById!)))
            refDefects[d.ResolvedById!] = refDefects.GetValueOrDefault(d.ResolvedById!) + 1;

        AssertDimEquals("defects", refDefects, endpoint);

        // 图片合计
        var imgs = await db.ImageAssets.Find(_ => true).Project(r => new { r.OwnerUserId }).ToListAsync();
        AssertDimEquals("images", GroupCount(imgs.Select(x => x.OwnerUserId), userIds), endpoint);

        // 视觉生图 / 文学配图（仅 Completed）
        var gens = await db.ImageGenRuns
            .Find(r => r.Status == ImageGenRunStatus.Completed)
            .Project(r => new { r.OwnerAdminId, r.AppKey }).ToListAsync();
        AssertDimEquals("image-gen-visual",
            GroupCount(gens.Where(x => x.AppKey == "visual-agent").Select(x => x.OwnerAdminId), userIds), endpoint);
        AssertDimEquals("image-gen-literary",
            GroupCount(gens.Where(x => x.AppKey == "literary-agent").Select(x => x.OwnerAdminId), userIds), endpoint);

        // 上传参考图
        var ups = await db.UploadArtifacts.Find(r => r.Kind == "input_image")
            .Project(r => new { r.CreatedByAdminId }).ToListAsync();
        AssertDimEquals("image-upload", GroupCount(ups.Select(x => x.CreatedByAdminId), userIds), endpoint);

        // 工作流执行
        var wfs = await db.WorkflowExecutions.Find(_ => true).Project(w => new { w.TriggeredBy }).ToListAsync();
        AssertDimEquals("workflows", GroupCount(wfs.Select(x => x.TriggeredBy), userIds), endpoint);

        // 竞技场
        var ars = await db.ArenaBattles.Find(_ => true).Project(a => new { a.UserId }).ToListAsync();
        AssertDimEquals("arena", GroupCount(ars.Select(x => x.UserId), userIds), endpoint);

        // Agent 维度（LLM + API 合并；defect-agent 已不再单列）
        var llm = await db.LlmRequestLogs
            .Find(l => l.AppCallerCode != null && l.UserId != null)
            .Project(l => new { l.AppCallerCode, l.UserId }).ToListAsync();
        var api = await db.ApiRequestLogs
            .Find(l => l.Method != "GET" && l.StatusCode >= 200 && l.StatusCode < 400)
            .Project(l => new { l.Path, l.UserId }).ToListAsync();

        var prefixes = new Dictionary<string, string>
        {
            { "/api/prd-agent/", "prd-agent" }, { "/api/visual-agent/", "visual-agent" },
            { "/api/literary-agent/", "literary-agent" }, { "/api/defect-agent/", "defect-agent" },
            { "/api/ai-toolbox/", "ai-toolbox" }, { "/api/report-agent/", "report-agent" },
            { "/api/video-agent/", "video-agent" },
        };
        var refAgents = new Dictionary<string, Dictionary<string, int>>();
        foreach (var l in llm.Where(x => x.UserId != null && userIds.Contains(x.UserId!)))
        {
            var k = NormalizeAppKey(l.AppCallerCode ?? "");
            if (string.IsNullOrEmpty(k)) continue;
            var inner = refAgents.TryGetValue(k, out var i) ? i : (refAgents[k] = new());
            inner[l.UserId!] = inner.GetValueOrDefault(l.UserId!) + 1;
        }
        foreach (var l in api.Where(x => x.UserId != null && x.UserId != "anonymous" && userIds.Contains(x.UserId!)))
        {
            string? k = null;
            foreach (var p in prefixes)
                if (l.Path != null && l.Path.StartsWith(p.Key, StringComparison.OrdinalIgnoreCase)) { k = p.Value; break; }
            if (k == null) continue;
            var inner = refAgents.TryGetValue(k, out var i) ? i : (refAgents[k] = new());
            inner[l.UserId!] = inner.GetValueOrDefault(l.UserId!) + 1;
        }

        foreach (var appKey in new[] { "prd-agent", "visual-agent", "literary-agent", "ai-toolbox", "report-agent", "video-agent" })
            AssertDimEquals(appKey, refAgents.GetValueOrDefault(appKey) ?? new(), endpoint);

        // defect-agent 不应再作为单列出现
        Assert.False(endpoint.ContainsKey("defect-agent"), "defect-agent 应已合并进「缺陷」列");
        Assert.False(endpoint.ContainsKey("defects-created"), "提缺陷列应已合并");
        Assert.False(endpoint.ContainsKey("defects-resolved"), "解缺陷列应已合并");
    }

    private static Dictionary<string, int> GroupCount(IEnumerable<string?> ids, HashSet<string> userIds)
    {
        var d = new Dictionary<string, int>();
        foreach (var id in ids)
            if (!string.IsNullOrEmpty(id) && userIds.Contains(id))
                d[id] = d.GetValueOrDefault(id) + 1;
        return d;
    }

    private void AssertDimEquals(string key,
        Dictionary<string, int> expected,
        Dictionary<string, Dictionary<string, int>> endpoint)
    {
        Assert.True(endpoint.TryGetValue(key, out var actual), $"端点缺少维度 {key}");
        // 只比对非零项（双方都不写 0 项）
        var expectedNz = expected.Where(kv => kv.Value > 0).ToDictionary(kv => kv.Key, kv => kv.Value);
        foreach (var (uid, cnt) in expectedNz)
            Assert.True(actual!.TryGetValue(uid, out var a) && a == cnt,
                $"[{key}] 用户 {uid}: 期望 {cnt}, 实际 {(actual!.TryGetValue(uid, out var x) ? x : 0)}");
        foreach (var (uid, cnt) in actual!.Where(kv => kv.Value > 0))
            Assert.True(expectedNz.TryGetValue(uid, out var e) && e == cnt,
                $"[{key}] 端点多出用户 {uid}={cnt}（独立重算无此值）");
        Log($"[OK] 维度 {key} 交叉验证通过（{expectedNz.Count} 个非零用户）");
    }
}
