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

    // 匹配形如 "xxx.feature.sub::chat" 的字符串字面量,放宽 camelCase / 下划线以便不规范命名
    // 也能走到注册检查 (kebab-case 检查由 RegisteredCodes_ShouldUseKebabCase 兜底)。
    private static readonly Regex AppCallerCodePattern = new(
        @"""(?<code>[a-z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9][a-zA-Z0-9_-]*)+::(?:chat|vision|generation|intent|embedding|rerank|long-context|code))""",
        RegexOptions.Compiled);

    // kebab-case 校验:每一段(用 . 分割,去掉 ::modelType 后)都必须只包含 a-z / 0-9 / -
    private static readonly Regex KebabCaseSegmentPattern = new(
        @"^[a-z][a-z0-9-]*$",
        RegexOptions.Compiled);

    /// <summary>
    /// 已知可豁免的非注册 caller-code 字面量:必须每条都附「为什么不该注册」的注释。
    /// 默认空集合 —— 默认拒绝 (default-deny),任何 src/**.cs 里的 caller-code 字面量
    /// 都必须能在 AppCallerRegistry 找到,除非显式列入此处并说明理由。
    /// </summary>
    private static readonly HashSet<string> KnownNonRegisteredLiterals = new(StringComparer.Ordinal)
    {
        // 暂无:如果将来出现"虚构例子"(纯文档片段、单元测试桩),在此登记并加注释解释。
    };

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
                if (KnownNonRegisteredLiterals.Contains(code)) continue;
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
                "请在 prd-api/src/PrdAgent.Core/Models/AppCallerRegistry.cs 对应的子类下,",
                "新增带 [AppCallerMetadata] 的 public const string,然后用该常量替换字面量。",
                "",
                "(历史教训:之前用 AllowedPrefixes 白名单做 IsKnownPrefix 过滤,",
                "新加的 marketplace-skill / page-agent / prd-agent-web / document-store 等前缀",
                "因未及时同步白名单,被 CI 静默跳过 —— 现已改为 default-deny。)",
                "",
            };
            foreach (var (code, files) in missing.OrderBy(kv => kv.Key))
            {
                lines.Add($"  X {code}");
                foreach (var f in files.Distinct()) lines.Add($"       出现在: {f}");
            }
            var msg = string.Join('\n', lines);
            _output.WriteLine(msg);
            Assert.Fail(msg);
        }

        _output.WriteLine($"OK 已扫描 {seen.Count} 个 AppCallerCode 字面量,全部已在 AppCallerRegistry 注册。");
    }

    /// <summary>
    /// 强制所有已注册的 AppCallerCode 用 kebab-case。
    /// 历史教训:PR #504 的 "prd-admin.changelog.aiSummary::chat" 用了 camelCase,
    /// 既违反约定,又恰好绕过早期版本的扫描正则(只允许 [a-z0-9-]),
    /// 导致 EveryAppCallerCodeLiteral_ShouldBeRegistered 静默漏检。
    /// 本测试与上面的扫描互为兜底。
    /// </summary>
    [Fact]
    public void RegisteredCodes_ShouldUseKebabCase()
    {
        var defs = AppCallerRegistrationService.GetAllDefinitions();
        var bad = new List<string>();

        foreach (var def in defs)
        {
            var code = def.AppCode ?? string.Empty;
            var idx = code.IndexOf("::", StringComparison.Ordinal);
            if (idx < 0)
            {
                bad.Add($"{code}  (缺少 ::modelType 后缀)");
                continue;
            }

            var pathPart = code[..idx];               // "prd-admin.changelog.ai-summary"
            var modelType = code[(idx + 2)..];        // "chat"

            foreach (var seg in pathPart.Split('.'))
            {
                if (!KebabCaseSegmentPattern.IsMatch(seg))
                {
                    bad.Add($"{code}  (段 \"{seg}\" 不是 kebab-case;请用小写字母+数字+连字符)");
                    break;
                }
            }

            if (!KebabCaseSegmentPattern.IsMatch(modelType))
            {
                bad.Add($"{code}  (modelType \"{modelType}\" 不是 kebab-case)");
            }
        }

        if (bad.Count > 0)
        {
            var msg = "以下已注册 AppCallerCode 不符合 kebab-case 规范 ——\n" +
                     "请改用全小写 + 连字符,例如把 aiSummary 改成 ai-summary:\n\n" +
                     string.Join('\n', bad.Select(s => "  ❌ " + s));
            _output.WriteLine(msg);
            Assert.Fail(msg);
        }

        _output.WriteLine($"✓ 已校验 {defs.Count} 个注册项,全部符合 kebab-case 规范。");
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
