using System.Text.RegularExpressions;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// ResolutionType 是**输出标签**，不是判据。
///
/// 它有六个取值（DirectModel / LogicalModel / PinnedModel / DedicatedPool / Legacy / NotFound），
/// 只写给日志、看板和排障用。问题出在有人拿它当分支条件：
/// <c>resolution.ResolutionType == "DefaultPool"</c> —— 六个取值里根本没有 DefaultPool，
/// 这行比较从写下那天起就**永远为假**，于是那个 DTO 字段恒为 false，编译器不会说话、
/// 测试不会红、通读也挑不出来（2026-09-15 减枝时才被扫出来，字段已删）。
///
/// 这条守卫做的是**数据覆盖**：把源码里所有拿 ResolutionType 比对的字面量收集起来，
/// 逐个核对它真的在产出集合里。拼错一个字、改名忘了同步，这里立刻红。
///
/// 为什么不把枚举收敛成两种（找到 / 没找到）：它是输出标签，收敛会打断日志与看板的既有口径，
/// 换来的只是「枚举值少了四个」——那不是整洁，那是把可诊断性剪掉了。真正该禁的是拿它做分支。
/// </summary>
public sealed class GatewayResolutionLabelGuardTests
{
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "AGENTS.md"))) dir = dir.Parent;
        Assert.NotNull(dir);
        return dir!.FullName;
    }

    private static IEnumerable<string> SourceFiles(string root, params string[] relativeRoots)
        => relativeRoots
            .Select(x => Path.Combine(root, x))
            .Where(Directory.Exists)
            .SelectMany(x => Directory.EnumerateFiles(x, "*.cs", SearchOption.AllDirectories))
            .Where(x => !x.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}")
                        && !x.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}"));

    [Fact]
    public void 比对解析标签的字面量必须真的会被产出()
    {
        var root = RepoRoot();
        var files = SourceFiles(root, "prd-api/src", "llmgw").ToList();
        Assert.NotEmpty(files);

        // 产出集合：赋值给 ResolutionType 的那些字面量。
        var produced = new HashSet<string>(StringComparer.Ordinal);
        var consumedAt = new List<(string File, string Literal)>();

        var assign = new Regex("ResolutionType\\s*=\\s*\"([A-Za-z]+)\"");
        // 消费：== "X" / != "X" / switch 分支里的 "X" =>，都跟在 ResolutionType 后面不远处。
        var compare = new Regex("ResolutionType\\s*(?:==|!=)\\s*\"([A-Za-z]+)\"");
        var switchArm = new Regex("ResolutionType\\s+switch\\s*\\{([^}]*)\\}", RegexOptions.Singleline);
        var armLiteral = new Regex("\"([A-Za-z]+)\"\\s*=>");

        foreach (var file in files)
        {
            var src = File.ReadAllText(file);
            if (!src.Contains("ResolutionType")) continue;
            foreach (Match m in assign.Matches(src)) produced.Add(m.Groups[1].Value);
            foreach (Match m in compare.Matches(src)) consumedAt.Add((file, m.Groups[1].Value));
            foreach (Match block in switchArm.Matches(src))
                foreach (Match arm in armLiteral.Matches(block.Groups[1].Value))
                    consumedAt.Add((file, arm.Groups[1].Value));
        }

        Assert.NotEmpty(produced);

        var orphans = consumedAt
            .Where(x => !produced.Contains(x.Literal))
            .Select(x => $"{Path.GetRelativePath(root, x.File)} 比对了 \"{x.Literal}\"")
            .Distinct(StringComparer.Ordinal)
            .ToList();

        Assert.True(
            orphans.Count == 0,
            userMessage: "有人拿 ResolutionType 跟一个永远不会被产出的字面量比对，这行判断恒为假：\n  "
                + string.Join("\n  ", orphans)
                + "\n产出集合是：" + string.Join(" / ", produced.OrderBy(x => x, StringComparer.Ordinal)));
    }

    /// <summary>
    /// 权威判据用的是裸数字 0/1/2，而池那边传的是 ModelHealthStatus 强转。
    /// 这条对齐是**承重的**：把枚举值改一下（比如给 Healthy 赋 1），排序会整体反过来，
    /// 而编译器一句话都不会说。收敛判据时靠的就是这个对齐，所以单独钉住。
    /// </summary>
    [Fact]
    public void 健康枚举的底层值必须与权威判据对齐()
    {
        Assert.Equal(0, (int)PrdAgent.Core.Models.ModelHealthStatus.Healthy);
        Assert.Equal(1, (int)PrdAgent.Core.Models.ModelHealthStatus.Degraded);
        Assert.Equal(
            PrdAgent.Core.LlmGateway.GatewayRouteSelection.HealthUnavailable,
            (int)PrdAgent.Core.Models.ModelHealthStatus.Unavailable);
    }

    [Fact]
    public void 挑选判据只许有权威与镜像两份()
    {
        var root = RepoRoot();
        // 「健康优先 → 顺位」这个排序是整个网关的核心判据。2026-09-15 之前它有四份：
        // 权威、控制台镜像、ModelResolver 里一个无人调用的 SelectBestModel、以及测试里一份
        // 自己的模拟。后两份已删/已改为调权威那份。这条守卫挡住第五份。
        var allowed = new[]
        {
            Path.Combine("prd-api", "src", "PrdAgent.Core", "LlmGateway", "GatewayRouteSelection.cs"),
            Path.Combine("llmgw", "console-api", "LogicalModels", "CallTracePlanner.cs"),
        };

        var pattern = new Regex(@"OrderBy\(\s*\w+\s*=>\s*\w+\.HealthStatus\s*==\s*(?:0|ModelHealthStatus\.Healthy)");
        var offenders = SourceFiles(root, "prd-api/src", "llmgw")
            .Where(f => pattern.IsMatch(File.ReadAllText(f)))
            .Select(f => Path.GetRelativePath(root, f))
            .Where(rel => !allowed.Any(a => rel.EndsWith(a, StringComparison.Ordinal)))
            .ToList();

        Assert.True(
            offenders.Count == 0,
            userMessage: "「健康优先 → 顺位」这份判据又长出了新的一份，只许权威 + 控制台镜像两处：\n  "
                + string.Join("\n  ", offenders));
    }
}
