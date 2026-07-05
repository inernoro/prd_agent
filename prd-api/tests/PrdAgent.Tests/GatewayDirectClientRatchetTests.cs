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
        Assert.True(DirectClientNewPattern.IsMatch("var c = new ClaudeClient(httpClient, key);"));
        Assert.True(DirectClientNewPattern.IsMatch("return new OpenAIClient(\n    httpClient, key, model);"));
        Assert.False(DirectClientNewPattern.IsMatch("new GatewayLLMClient(...)"));
        Assert.False(DirectClientNewPattern.IsMatch("new OpenAIImageClient(...)"));
        Assert.False(DirectClientNewPattern.IsMatch("new ClaudeClientFactory(...)"));

        _output.WriteLine($"OK baseline {Baseline.Count} 个文件均存在且含真实直连，正则正/负控制通过。");
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
}
