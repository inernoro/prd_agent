using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 解析黄金回归测试（集成，CI 默认跳过 —— [Trait("Category","Integration")]）。
///
/// 遍历 fixtures/llm-resolution-golden.main.json（注册表全部 153 个 AppCallerCode 在 live main
/// 上的真实解析结果快照），对每条 code 断言「当前解析出的模型 == 记录值」。
///
/// P1 协议下沉重构的安全网：重构前后各跑一次，与本基准逐行 diff。全一致 = 对外行为零变化。
/// 详见 doc/design.llm-gateway-unification.md §11 + fixtures/README.md。
///
/// 运行方式（CDS / 集成环境，需要 live main 数据）：
///   PRD_TEST_API_BASE=https://...           接口根域名
///   PRD_TEST_AI_ACCESS_KEY=...              X-AI-Access-Key
///   PRD_TEST_AI_IMPERSONATE=...             X-AI-Impersonate（被模拟用户）
///   dotnet test --filter "Category=Integration&FullyQualifiedName~LlmResolutionGolden"
///
/// 缺少上述环境变量时本测试静默跳过（与本仓库其它集成测试一致），不会让 CI 变红。
/// </summary>
[Trait("Category", "Integration")]
public class LlmResolutionGoldenIntegrationTests
{
    private readonly ITestOutputHelper _output;

    public LlmResolutionGoldenIntegrationTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /// <summary>黄金基准单行（与 fixtures/llm-resolution-golden.main.json 字段一一对应）。</summary>
    public sealed class GoldenRow
    {
        [JsonPropertyName("code")] public string Code { get; set; } = string.Empty;
        [JsonPropertyName("ok")] public bool Ok { get; set; }
        [JsonPropertyName("resolutionType")] public string? ResolutionType { get; set; }
        [JsonPropertyName("actualModel")] public string? ActualModel { get; set; }
        [JsonPropertyName("platformType")] public string? PlatformType { get; set; }
        [JsonPropertyName("apiUrl")] public string? ApiUrl { get; set; }
        [JsonPropertyName("modelGroupId")] public string? ModelGroupId { get; set; }
        [JsonPropertyName("isFallback")] public bool IsFallback { get; set; }
        [JsonPropertyName("healthStatus")] public string? HealthStatus { get; set; }
    }

    /// <summary>
    /// 解析端点返回的 ApiResponse 信封：{ success, data: GatewayModelResolution, error }。
    /// </summary>
    private sealed class ApiEnvelope
    {
        [JsonPropertyName("success")] public bool Success { get; set; }
        [JsonPropertyName("data")] public ResolveData? Data { get; set; }
    }

    /// <summary>GatewayModelResolution 的最小子集（仅取断言用到的字段）。</summary>
    private sealed class ResolveData
    {
        // GatewayModelResolution.Success（解析是否成功）。
        [JsonPropertyName("success")] public bool Success { get; set; }
        [JsonPropertyName("actualModel")] public string? ActualModel { get; set; }
        [JsonPropertyName("resolutionType")] public string? ResolutionType { get; set; }
        [JsonPropertyName("platformType")] public string? PlatformType { get; set; }
        [JsonPropertyName("modelGroupId")] public string? ModelGroupId { get; set; }
        [JsonPropertyName("isFallback")] public bool IsFallback { get; set; }
    }

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true
    };

    /// <summary>从 fixture 驱动 Theory：每条 code 一个测试用例。</summary>
    public static IEnumerable<object[]> GoldenRows()
    {
        foreach (var row in LoadGolden())
        {
            yield return new object[] { row };
        }
    }

    [Theory]
    [MemberData(nameof(GoldenRows))]
    public async Task ResolvedModel_ShouldMatchGolden(GoldenRow expected)
    {
        var apiBase = Environment.GetEnvironmentVariable("PRD_TEST_API_BASE");
        var accessKey = Environment.GetEnvironmentVariable("PRD_TEST_AI_ACCESS_KEY");
        var impersonate = Environment.GetEnvironmentVariable("PRD_TEST_AI_IMPERSONATE");

        if (string.IsNullOrWhiteSpace(apiBase) ||
            string.IsNullOrWhiteSpace(accessKey) ||
            string.IsNullOrWhiteSpace(impersonate))
        {
            _output.WriteLine(
                "[SKIP] 缺少 PRD_TEST_API_BASE / PRD_TEST_AI_ACCESS_KEY / PRD_TEST_AI_IMPERSONATE，" +
                "本解析黄金测试需要 live main 数据，跳过。");
            return;
        }

        // code 形如 "xxx.feature::chat"，:: 后缀就是 modelType。
        var idx = expected.Code.IndexOf("::", StringComparison.Ordinal);
        var modelType = idx >= 0 ? expected.Code[(idx + 2)..] : "chat";

        using var http = new HttpClient { BaseAddress = new Uri(apiBase), Timeout = TimeSpan.FromSeconds(15) };
        http.DefaultRequestHeaders.Add("X-AI-Access-Key", accessKey);
        http.DefaultRequestHeaders.Add("X-AI-Impersonate", impersonate);

        var url = $"/api/open-platform/app-callers/resolve-model" +
                  $"?appCallerCode={Uri.EscapeDataString(expected.Code)}" +
                  $"&modelType={Uri.EscapeDataString(modelType)}";

        var resp = await http.GetAsync(url);
        var body = await resp.Content.ReadAsStringAsync();

        // 黄金值 ok=false 的 code（如未注册的 embedding modelType）端点会返回 400
        // APP_CODE_NOT_REGISTERED 或 success=false，二者都视为「解析未命中」与黄金值一致。
        if (!expected.Ok)
        {
            var unresolved = !resp.IsSuccessStatusCode;
            if (resp.IsSuccessStatusCode)
            {
                var env400 = JsonSerializer.Deserialize<ApiEnvelope>(body, JsonOpts);
                unresolved = env400?.Data == null || !env400.Data.Success;
            }
            Assert.True(unresolved,
                $"黄金值标记 {expected.Code} 解析失败，但端点返回了成功解析: {body}");
            return;
        }

        Assert.True(resp.IsSuccessStatusCode,
            $"resolve-model 返回非 2xx ({(int)resp.StatusCode}) for {expected.Code}: {body}");

        var envelope = JsonSerializer.Deserialize<ApiEnvelope>(body, JsonOpts);
        Assert.NotNull(envelope);
        Assert.True(envelope!.Success, $"ApiResponse.success=false for {expected.Code}: {body}");
        var actual = envelope.Data;
        Assert.NotNull(actual);

        // 核心断言：解析出的模型 == 记录值；以及 success / resolutionType 一致。
        Assert.True(actual!.Success, $"解析失败（GatewayModelResolution.success=false）: {expected.Code}");
        Assert.Equal(expected.ResolutionType, actual.ResolutionType);
        Assert.Equal(expected.ActualModel ?? string.Empty, actual.ActualModel ?? string.Empty);

        // 附带校验平台调度结果（modelGroupId / isFallback）。
        Assert.Equal(expected.ModelGroupId, actual.ModelGroupId);
        Assert.Equal(expected.IsFallback, actual.IsFallback);
    }

    private static List<GoldenRow> LoadGolden()
    {
        var path = LocateGoldenFile();
        if (!File.Exists(path)) return new List<GoldenRow>();
        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<List<GoldenRow>>(json, JsonOpts) ?? new List<GoldenRow>();
    }

    private static string LocateGoldenFile()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(
                dir.FullName, "prd-api", "tests", "PrdAgent.Tests", "fixtures",
                "llm-resolution-golden.main.json");
            if (File.Exists(candidate)) return candidate;

            candidate = Path.Combine(dir.FullName, "fixtures", "llm-resolution-golden.main.json");
            if (File.Exists(candidate)) return candidate;

            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "fixtures",
            "llm-resolution-golden.main.json"));
    }
}
