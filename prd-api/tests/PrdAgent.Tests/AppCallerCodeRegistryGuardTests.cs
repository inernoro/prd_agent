using System.IO;
using System.Text.RegularExpressions;
using PrdAgent.Core.Models;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 防守性测试:全仓扫描所有 AppCallerCode 字面量,确保它们都在 AppCallerRegistry 中注册过。
///
/// 背景:一个常踩的坑是——开发者在 service / controller 里硬编码
/// "my-agent.feature::chat" 字符串,忘了去 AppCallerRegistry 注册 [AppCallerMetadata]。
/// 运行时第一次调 LLM Gateway 才会炸「appCallerCode 未注册」,部署才发现。
///
/// 本测试在 CI 阶段就把这种遗漏揪出来,让开发者在 push 前就知道要加注册项。
/// </summary>
public class AppCallerCodeRegistryGuardTests
{
    private readonly ITestOutputHelper _output;

    public AppCallerCodeRegistryGuardTests(ITestOutputHelper output)
    {
        _output = output;
    }

    // 匹配形如 "xxx-agent.feature.sub::chat" 的字符串字面量
    // - 前缀:kebab-case 应用键
    // - 中段:点号分隔的路径(至少一段)
    // - 结尾:::modelType
    private static readonly Regex AppCallerCodePattern = new(
        @"""(?<code>[a-z][a-z0-9-]*(?:-[a-z0-9]+)*(?:\.[a-z0-9][a-z0-9-]*)+::(?:chat|vision|generation|intent|embedding|rerank|long-context|code))""",
        RegexOptions.Compiled);

    /// <summary>允许的命名空间前缀(与 AppCallerRegistry 对齐)。未在此列则不参与扫描。</summary>
    private static readonly string[] AllowedPrefixes =
    {
        "prd-agent", "visual-agent", "literary-agent", "defect-agent", "video-agent",
        "report-agent", "review-agent", "transcript-agent", "workflow-agent",
        "pr-review", "emergence-explorer", "skill-agent", "arena", "ai-toolbox",
        "tutorial-email", "open-platform", "channel-adapter", "document-store-agent",
        "prd-admin", "prd-agent-desktop", "admin", "system",
    };

    private static bool IsKnownPrefix(string code)
    {
        foreach (var p in AllowedPrefixes)
        {
            if (code.StartsWith(p + ".", StringComparison.Ordinal)) return true;
        }
        return false;
    }

    [Fact]
    public void EveryAppCallerCodeLiteral_ShouldBeRegistered()
    {
        var srcRoot = LocateSrcRoot();
        Assert.True(Directory.Exists(srcRoot), $"找不到源码目录: {srcRoot}");

        var missing = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var file in Directory.EnumerateFiles(srcRoot, "*.cs", SearchOption.AllDirectories))
        {
            // 跳过 AppCallerRegistry 本身(定义源)和 bin/obj
            var rel = Path.GetRelativePath(srcRoot, file).Replace('\\', '/');
            if (rel.Contains("/bin/") || rel.Contains("/obj/")) continue;
            if (rel.EndsWith("AppCallerRegistry.cs", StringComparison.Ordinal)) continue;

            string content;
            try { content = File.ReadAllText(file); }
            catch { continue; }

            foreach (Match m in AppCallerCodePattern.Matches(content))
            {
                var code = m.Groups["code"].Value;
                if (!IsKnownPrefix(code)) continue;           // 忽略测试数据 / 第三方
                if (!seen.Add(code)) continue;                // 本轮已验过

                if (AppCallerRegistrationService.FindByAppCode(code) == null)
                {
                    if (!missing.TryGetValue(code, out var list))
                    {
                        list = new List<string>();
                        missing[code] = list;
                    }
                    list.Add(rel);
                }
            }
        }

        if (missing.Count > 0)
        {
            var lines = new List<string>
            {
                "发现以下 AppCallerCode 字面量未在 AppCallerRegistry 中注册 ——",
                "请在 prd-api/src/PrdAgent.Core/Models/AppCallerRegistry.cs 对应的 Agent 子类下,",
                "新增带 [AppCallerMetadata] 的 public const string,然后用该常量替换字面量。",
                "",
            };
            foreach (var (code, files) in missing.OrderBy(kv => kv.Key))
            {
                lines.Add($"  ❌ {code}");
                foreach (var f in files.Distinct()) lines.Add($"       出现在: {f}");
            }
            var msg = string.Join('\n', lines);
            _output.WriteLine(msg);
            Assert.Fail(msg);
        }

        _output.WriteLine($"✓ 已扫描 {seen.Count} 个 AppCallerCode 字面量,全部已在 AppCallerRegistry 注册。");
    }

    private static string LocateSrcRoot()
    {
        // 测试进程的 cwd 通常是 bin/Debug/net8.0/;往上找到仓库根,定位到 prd-api/src
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "prd-api", "src");
            if (Directory.Exists(candidate)) return candidate;
            // 到达 prd-api 自己 (如果测试从 prd-api/tests/xxx/bin/... 往上走)
            candidate = Path.Combine(dir.FullName, "src");
            if (Directory.Exists(candidate) && File.Exists(Path.Combine(dir.FullName, "PrdAgent.sln")))
            {
                return candidate;
            }
            dir = dir.Parent;
        }
        // 兜底:相对当前目录尝试
        return Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src"));
    }
}
