using System.IO;
using System.Text.RegularExpressions;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 直连守卫（棘轮 / ratchet）：全仓扫描 prd-api/src，禁止在 LLM Gateway 之外新增对
/// ClaudeClient / OpenAIClient 的**直接** new。所有大模型调用必须走 ILlmGateway
/// （见 .claude/rules/llm-gateway.md），直连 = 绕过网关的模型解析 / 日志 / 配额 / 密钥管理。
///
/// 棘轮语义（只收不放）：
///   - baseline = 当前仓库里「已知、暂时保留」的直连点集合。
///   - 出现 baseline **之外**的**新**直连 → 测试 red（防止直连债务反弹增长）。
///   - baseline 里的某条被真正迁移到网关后，从 baseline 删除即可（棘轮往「更严」方向拧一格）；
///     baseline 收缩到空 = 直连清零达标。
///
/// 排除项（不算直连债务，不入 baseline）：
///   - 已迁移到网关的上游客户端 OpenAIImageClient / OpenRouterVideoClient（生图 / 视频走网关侧封装）。
///   - 网关本体内部（PrdAgent.Infrastructure/LlmGateway/** 与 PrdAgent.LlmGateway/**）——
///     网关有权直接构造上游客户端，那正是它的职责。
///
/// 与 GatewayDirectClientRatchetTests 互补的是 AppCallerCodeRegistryGuardTests（注册守卫）：
/// 一个管「调用必须注册」，一个管「调用必须走网关」。二者都在 CI 常驻（非 Integration）。
/// </summary>
public class GatewayDirectClientRatchetTests
{
    private readonly ITestOutputHelper _output;

    public GatewayDirectClientRatchetTests(ITestOutputHelper output)
    {
        _output = output;
    }

    // 匹配 `new ClaudeClient(` / `new OpenAIClient(`（允许中间任意空白，含换行前的构造名）。
    // 只认这两个「裸上游客户端」；GatewayLLMClient / HttpLlmClient / OpenAIImageClient /
    // OpenRouterVideoClient 等封装型客户端不在直连口径内。
    private static readonly Regex DirectClientNewPattern = new(
        @"\bnew\s+(?<cls>ClaudeClient|OpenAIClient)\s*\(",
        RegexOptions.Compiled);

    // 网关本体目录（路径片段，正斜杠归一后匹配）：网关内部有权直接构造上游客户端。
    private static readonly string[] GatewayInternalPathFragments =
    {
        "/PrdAgent.Infrastructure/LlmGateway/",
        "/PrdAgent.LlmGateway/",
    };

    /// <summary>
    /// baseline：当前已知、暂时保留的直连点，key = 源文件相对路径（正斜杠），value = 该文件里
    /// 允许存在的直连条数。当前必须为空；任何 Gateway 外 `new ClaudeClient/OpenAIClient` 都直接 red。
    /// </summary>
    private static readonly Dictionary<string, int> Baseline = new(StringComparer.Ordinal)
    {
    };

    /// <summary>
    /// 手写上游 HTTP 端点的剩余债务。它们不是主业务生成链路，但仍然会直接访问模型供应商；
    /// 零惊吓发布前必须逐项迁入 llmgw-serve，或在发布 gate 中继续明确排除。
    /// </summary>
    private static readonly Dictionary<string, string> ManualUpstreamHttpBaseline = new(StringComparer.Ordinal)
    {
    };

    [Fact]
    public void NoNewDirectUpstreamClient_OutsideGatewayAndBaseline()
    {
        var srcRoot = LocateSrcRoot();
        Assert.True(Directory.Exists(srcRoot), $"找不到源码目录: {srcRoot}");

        // 实测：每个 src 相对路径的直连条数。
        var actual = new Dictionary<string, int>(StringComparer.Ordinal);

        foreach (var file in Directory.EnumerateFiles(srcRoot, "*.cs", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(srcRoot, file).Replace('\\', '/');
            if (rel.Contains("/bin/") || rel.Contains("/obj/")) continue;

            // 网关本体内部有权直连上游客户端，跳过。
            var relForFragment = "/" + rel;
            if (GatewayInternalPathFragments.Any(frag =>
                    relForFragment.Contains(frag, StringComparison.Ordinal)))
                continue;

            // 客户端类定义文件本身（LLM/ClaudeClient.cs / LLM/OpenAIClient.cs）不含 `new`，
            // 但保险起见也不特判——DirectClientNewPattern 只匹配 `new Xxx(`，类定义不会命中。

            string content;
            try { content = File.ReadAllText(file); }
            catch { continue; }

            var count = DirectClientNewPattern.Matches(content).Count;
            if (count > 0) actual[rel] = count;
        }

        var violations = new List<string>();

        // 规则 1：出现 baseline 之外的新直连文件，或 baseline 文件里直连条数超过登记值 → red。
        foreach (var (rel, count) in actual.OrderBy(kv => kv.Key))
        {
            var allowed = Baseline.TryGetValue(rel, out var b) ? b : 0;
            if (count > allowed)
            {
                violations.Add(allowed == 0
                    ? $"  X 新增直连（未走 ILlmGateway）: {rel} 出现 {count} 处 `new ClaudeClient/OpenAIClient`"
                    : $"  X 直连超出 baseline: {rel} 现有 {count} 处，baseline 登记 {allowed} 处（新增了 {count - allowed} 处）");
            }
        }

        if (violations.Count > 0)
        {
            var msg = string.Join('\n', new[]
            {
                "检测到 baseline 之外的 LLM 直连（绕过 ILlmGateway）——",
                "所有大模型调用必须走 ILlmGateway（见 .claude/rules/llm-gateway.md）。",
                "若确属对照评测等设计上必须直连的场景，把它加进 GatewayDirectClientRatchetTests.Baseline 并注释理由；",
                "否则改为经 ILlmGateway.CreateClient / SendAsync / StreamAsync 调用。",
                "",
            }.Concat(violations));
            _output.WriteLine(msg);
            Assert.Fail(msg);
        }

        _output.WriteLine(
            $"OK 直连守卫通过：网关外直连均在 baseline 内（baseline 文件 {Baseline.Count} 个，" +
            $"实测直连文件 {actual.Count} 个）。baseline 收缩到空即代表直连清零达标。");
    }

    /// <summary>
    /// 反向自检（canary）：确保扫描正则真的能命中「直连」而非恒空跑绿。
    /// baseline 文件应当真实存在且真的含直连——否则 baseline 是死登记，棘轮形同虚设。
    /// </summary>
    [Fact]
    public void Baseline_EntriesStillExist_AndActuallyContainDirectCalls()
    {
        var srcRoot = LocateSrcRoot();
        var stale = new List<string>();

        foreach (var (rel, expected) in Baseline)
        {
            var full = Path.Combine(srcRoot, rel.Replace('/', Path.DirectorySeparatorChar));
            if (!File.Exists(full))
            {
                stale.Add($"  ! baseline 登记的文件已不存在，应从 Baseline 删除: {rel}");
                continue;
            }
            var count = DirectClientNewPattern.Matches(File.ReadAllText(full)).Count;
            if (count == 0)
            {
                stale.Add($"  ! baseline 登记 {rel} 期望 {expected} 处直连，实测 0 处 —— 已收口，请从 Baseline 删除该行（棘轮往更严拧一格）");
            }
            else if (count < expected)
            {
                stale.Add($"  ! baseline 登记 {rel}={expected}，实测仅 {count} 处 —— 已部分收口，请把登记值下调为 {count}");
            }
        }

        if (stale.Count > 0)
        {
            var msg = "GatewayDirectClientRatchetTests.Baseline 与源码漂移（棘轮只收不放，收口后必须同步收紧）——\n"
                      + string.Join('\n', stale);
            _output.WriteLine(msg);
            Assert.Fail(msg);
        }

        // 正/负控制：正则命中真代码、拒绝封装型客户端。
        Assert.Matches(DirectClientNewPattern, "var c = new ClaudeClient(httpClient, key);");
        Assert.Matches(DirectClientNewPattern, "return new OpenAIClient(\n    httpClient, key, model);");
        Assert.DoesNotMatch(DirectClientNewPattern, "new GatewayLLMClient(...)");
        Assert.DoesNotMatch(DirectClientNewPattern, "new OpenAIImageClient(...)");
        Assert.DoesNotMatch(DirectClientNewPattern, "new ClaudeClientFactory(...)");

        _output.WriteLine($"OK baseline {Baseline.Count} 个文件均存在且含真实直连，正则正/负控制通过。");
    }

    [Fact]
    public void ManualUpstreamHttpCalls_AreExplicitlyTracked_AndDoNotGrow()
    {
        var srcRoot = LocateSrcRoot();
        Assert.True(Directory.Exists(srcRoot), $"找不到源码目录: {srcRoot}");

        var actual = DiscoverManualUpstreamHttpFiles(srcRoot);
        var violations = new List<string>();

        foreach (var rel in actual.OrderBy(x => x, StringComparer.Ordinal))
        {
            if (!ManualUpstreamHttpBaseline.ContainsKey(rel))
            {
                violations.Add($"  X 未登记的手写上游 HTTP 调用: {rel}");
            }
        }

        foreach (var rel in ManualUpstreamHttpBaseline.Keys.OrderBy(x => x, StringComparer.Ordinal))
        {
            if (!actual.Contains(rel))
            {
                violations.Add($"  ! baseline 已过期，应删除或收紧: {rel}");
            }
        }

        if (violations.Count > 0)
        {
            var msg = string.Join('\n', new[]
            {
                "检测到 LLM Gateway 外手写上游 HTTP 调用清单漂移。",
                "这些路径会绕过 llmgw-serve 的密钥门、transport 观测、shadow 证据和回滚 gate；",
                "若是新业务 AI 请求，必须改走 ILlmGateway；若是管理/探活路径，必须先登记原因并作为后续收口 debt。",
                "",
            }.Concat(violations));
            _output.WriteLine(msg);
            Assert.Fail(msg);
        }

        _output.WriteLine(
            $"OK 手写上游 HTTP 守卫通过：当前剩余 {actual.Count} 个文件，均已登记为待迁移 debt。");
    }

    [Theory]
    [InlineData("/v1/chat/completions")]
    [InlineData("/v1/messages")]
    [InlineData("/v1/responses")]
    [InlineData("/v1/images/generations")]
    [InlineData("/v1/images/edits")]
    [InlineData("/v1/audio/transcriptions")]
    [InlineData("/v1/audio/speech")]
    [InlineData("/v1/embeddings")]
    [InlineData("/v1/rerank")]
    [InlineData("/videos")]
    public void ManualUpstreamHttpDetector_CoversTextImageAudioVideoEndpoints(string endpoint)
    {
        var directHttp = $$"""
            using var req = new HttpRequestMessage(HttpMethod.Post, "https://api.example.com{{endpoint}}");
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
            using var resp = await http.SendAsync(req, ct);
            """;

        Assert.True(
            LooksLikeManualUpstreamHttp(directHttp),
            $"手写上游 HTTP 检测必须覆盖 {endpoint}，否则图片/ASR/视频可能绕过 llmgw-serve。");
    }

    [Fact]
    public void ManualUpstreamHttpDetector_DoesNotFlagGatewayRawRequests()
    {
        var gatewayRaw = """
            var rawRequest = new GatewayRawRequest
            {
                EndpointPath = "/v1/images/generations",
                RequestBody = body,
            };
            var rawResp = await _llmGateway.SendRawWithResolutionAsync(rawRequest, resolution, ct);
            """;

        Assert.False(
            LooksLikeManualUpstreamHttp(gatewayRaw),
            "业务代码通过 GatewayRawRequest 进入 ILlmGateway 时不应被识别为手写上游 HTTP。");
    }

    [Fact]
    public void NoProductionDoubaoStreamAsrDirectUsage_OutsideGatewayMigrationStub()
    {
        var srcRoot = LocateSrcRoot();
        Assert.True(Directory.Exists(srcRoot), $"找不到源码目录: {srcRoot}");

        var violations = new List<string>();
        foreach (var file in Directory.EnumerateFiles(srcRoot, "*.cs", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(srcRoot, file).Replace('\\', '/');
            if (rel.Contains("/bin/") || rel.Contains("/obj/")) continue;
            if (rel == "PrdAgent.Infrastructure/LlmGateway/Asr/DoubaoStreamAsrService.cs") continue;
            if (rel.StartsWith("PrdAgent.Infrastructure/LlmGateway/", StringComparison.Ordinal)) continue;
            if (rel.StartsWith("PrdAgent.LlmGateway/", StringComparison.Ordinal)) continue;

            var content = File.ReadAllText(file);
            if (content.Contains("DoubaoStreamAsrService", StringComparison.Ordinal)
                || content.Contains("TranscribeWithCallbackAsync(", StringComparison.Ordinal))
            {
                violations.Add($"  X ASR WebSocket 直连残留: {rel}");
            }
        }

        if (violations.Count > 0)
        {
            var msg = string.Join('\n', new[]
            {
                "检测到 MAP 生产路径仍引用 DoubaoStreamAsrService 或其 WebSocket 调用。",
                "LLM Gateway 全量迁移要求 ASR 不能在 API 进程内直连上游；",
                "请改走 ILlmGateway.SendRawWithResolutionAsync（HTTP ASR/Exchange），或先 fail-closed，直到 WebSocket 协议迁入 llmgw-serve。",
                "",
            }.Concat(violations));
            _output.WriteLine(msg);
            Assert.Fail(msg);
        }

        _output.WriteLine("OK ASR WebSocket 直连守卫通过：业务路径没有引用 DoubaoStreamAsrService。");
    }

    [Fact]
    public void ApiLayer_DoesNotDependOnConcreteOpenAIImageClient_OutsideCompositionRoot()
    {
        var srcRoot = LocateSrcRoot();
        var apiRoot = Path.Combine(srcRoot, "PrdAgent.Api");
        Assert.True(Directory.Exists(apiRoot), $"找不到 API 源码目录: {apiRoot}");

        var violations = new List<string>();
        foreach (var file in Directory.EnumerateFiles(apiRoot, "*.cs", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(srcRoot, file).Replace('\\', '/');
            if (rel.Contains("/bin/") || rel.Contains("/obj/")) continue;
            if (rel == "PrdAgent.Api/Program.cs") continue;

            var content = File.ReadAllText(file);
            if (content.Contains("OpenAIImageClient", StringComparison.Ordinal))
                violations.Add($"  X API 层直接依赖具体生图客户端: {rel}");
        }

        if (violations.Count > 0)
        {
            var msg = string.Join('\n', new[]
            {
                "检测到 API/Worker 层直接引用 OpenAIImageClient。",
                "LLM Gateway 全量迁移要求图片请求经生图网关接口进入，业务层不得持有具体上游客户端；",
                "请改为依赖 IImageGenerationClient / IImageGenGateway，并只在 Program.cs composition root 注册具体实现。",
                "",
            }.Concat(violations));
            _output.WriteLine(msg);
            Assert.Fail(msg);
        }

        _output.WriteLine("OK 图片直连守卫通过：API 层只依赖生图网关接口，不直接引用 OpenAIImageClient。");
    }

    [Fact]
    public void ApiLayer_DoesNotDependOnConcreteOpenRouterVideoClient_OutsideCompositionRoot()
    {
        var srcRoot = LocateSrcRoot();
        var apiRoot = Path.Combine(srcRoot, "PrdAgent.Api");
        Assert.True(Directory.Exists(apiRoot), $"找不到 API 源码目录: {apiRoot}");

        var violations = new List<string>();
        foreach (var file in Directory.EnumerateFiles(apiRoot, "*.cs", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(srcRoot, file).Replace('\\', '/');
            if (rel.Contains("/bin/") || rel.Contains("/obj/")) continue;
            if (rel == "PrdAgent.Api/Program.cs") continue;

            var content = File.ReadAllText(file);
            if (Regex.IsMatch(content, @"\bOpenRouterVideoClient\b"))
                violations.Add($"  X API 层直接依赖具体视频客户端: {rel}");
        }

        if (violations.Count > 0)
        {
            var msg = string.Join('\n', new[]
            {
                "检测到 API/Worker 层直接引用 OpenRouterVideoClient。",
                "LLM Gateway 全量迁移要求视频请求经视频网关接口进入，业务层不得持有具体上游客户端；",
                "请改为依赖 IOpenRouterVideoClient，并只在 Program.cs composition root 注册具体实现。",
                "",
            }.Concat(violations));
            _output.WriteLine(msg);
            Assert.Fail(msg);
        }

        _output.WriteLine("OK 视频直连守卫通过：API 层只依赖视频网关接口，不直接引用 OpenRouterVideoClient。");
    }

    private static string LocateSrcRoot()
    {
        // 测试进程 cwd 通常是 bin/Debug/net8.0/；向上找到仓库根，定位 prd-api/src。
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "prd-api", "src");
            if (Directory.Exists(candidate)) return candidate;
            candidate = Path.Combine(dir.FullName, "src");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln")))
                return candidate;
            dir = dir.Parent;
        }
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src"));
    }

    private static HashSet<string> DiscoverManualUpstreamHttpFiles(string srcRoot)
    {
        var result = new HashSet<string>(StringComparer.Ordinal);

        foreach (var file in Directory.EnumerateFiles(srcRoot, "*.cs", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(srcRoot, file).Replace('\\', '/');
            if (rel.Contains("/bin/") || rel.Contains("/obj/")) continue;

            var relForFragment = "/" + rel;
            if (GatewayInternalPathFragments.Any(frag =>
                    relForFragment.Contains(frag, StringComparison.Ordinal)))
                continue;

            string content;
            try { content = File.ReadAllText(file); }
            catch { continue; }

            if (LooksLikeManualUpstreamHttp(content))
                result.Add(rel);
        }

        return result;
    }

    private static bool LooksLikeManualUpstreamHttp(string content)
    {
        if (!ContainsProviderModelEndpoint(content)) return false;

        var lines = content.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            if (!ContainsProviderModelEndpoint(lines[i])) continue;

            var from = Math.Max(0, i - 80);
            var to = Math.Min(lines.Length - 1, i + 80);
            var window = string.Join('\n', lines[from..(to + 1)]);
            if (ContainsHttpSendEvidence(window) && ContainsProviderAuthEvidence(window))
                return true;
        }

        // Infra runtime profile 把 endpoint 构造、鉴权和发送拆成多个 helper，单个窗口不一定覆盖完整。
        return content.Contains("BuildTestUrl(secret.BaseUrl", StringComparison.Ordinal)
               && content.Contains("ApplyAuthHeaders(req", StringComparison.Ordinal)
               && content.Contains("http.SendAsync(req", StringComparison.Ordinal);
    }

    private static bool ContainsProviderModelEndpoint(string content)
    {
        return content.Contains("/v1/chat/completions", StringComparison.Ordinal)
               || content.Contains("/v1/messages", StringComparison.Ordinal)
               || content.Contains("/v1/responses", StringComparison.Ordinal)
               || content.Contains("/v1/images/generations", StringComparison.Ordinal)
               || content.Contains("/v1/images/edits", StringComparison.Ordinal)
               || content.Contains("/v1/audio/transcriptions", StringComparison.Ordinal)
               || content.Contains("/v1/audio/speech", StringComparison.Ordinal)
               || content.Contains("/v1/embeddings", StringComparison.Ordinal)
               || content.Contains("/v1/rerank", StringComparison.Ordinal)
               || content.Contains("/videos", StringComparison.Ordinal);
    }

    private static bool ContainsHttpSendEvidence(string content)
    {
        return content.Contains("new HttpRequestMessage", StringComparison.Ordinal)
               || content.Contains(".SendAsync(", StringComparison.Ordinal)
               || content.Contains(".PostAsync(", StringComparison.Ordinal)
               || content.Contains(".GetAsync(", StringComparison.Ordinal);
    }

    private static bool ContainsProviderAuthEvidence(string content)
    {
        return content.Contains("AuthenticationHeaderValue(\"Bearer\"", StringComparison.Ordinal)
               || content.Contains("Headers.Authorization", StringComparison.Ordinal)
               || content.Contains("TryAddWithoutValidation(\"x-api-key\"", StringComparison.Ordinal)
               || content.Contains("Headers.Add(\"x-api-key\"", StringComparison.Ordinal)
               || content.Contains("TryAddWithoutValidation(\"Authorization\"", StringComparison.Ordinal);
    }
}
