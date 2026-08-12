using System.Text.RegularExpressions;
using PrdAgent.Core.Analytics;
using PrdAgent.Core.Models;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 周报「用量口径」标签的守卫。
///
/// 这一行是「本周上线了什么」与「产品里有没有人用」之间唯一的连接键。写错一个字，
/// 采用度报告就会把这条能力报成 unknown-key，而周报本身照样发得出去——错误静默发生。
///
/// 校验源刻意选 <see cref="AppCallerRegistrationService"/> 的实际注册项，不另写正则、
/// 也不用 app-identity.md（只登记 13 个）或 KnownAgentKeys（只有 8 个）：那两份清单
/// 都比实际窄，拿来当白名单会把真实存在的 appKey 判成非法。
/// route: 的校验在前端做（复用 navCoverage 已有的路由提取），这里不重复实现。
/// </summary>
public class AdoptionTokenGuardTests
{
    private readonly ITestOutputHelper _output;
    public AdoptionTokenGuardTests(ITestOutputHelper output) => _output = output;

    private static readonly Regex TokenLine = new(@"\*\*用量口径\*\*\s*[：:]\s*(.+)", RegexOptions.Compiled);
    private static readonly Regex Backticked = new("`([^`]+)`", RegexOptions.Compiled);

    [Fact]
    public void 周报里的用量口径token必须都解析得到目标()
    {
        var repoRoot = LocateRepoRoot();
        var docDir = Path.Combine(repoRoot, "doc");
        if (!Directory.Exists(docDir))
        {
            _output.WriteLine($"跳过：找不到 doc 目录（{docDir}）");
            return;
        }

        var reports = Directory.GetFiles(docDir, "report.*.md");
        var validLlmKeys = AppCallerRegistrationService.GetAllDefinitions()
            .Select(d => d.AppCode.Split('.')[0])
            .Where(k => !string.IsNullOrWhiteSpace(k))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var problems = new List<string>();
        var checkedCount = 0;

        foreach (var file in reports)
        {
            foreach (var line in File.ReadLines(file))
            {
                var m = TokenLine.Match(line);
                if (!m.Success) continue;

                var body = m.Groups[1].Value;
                var raw = Backticked.Matches(body).Select(x => x.Groups[1].Value).ToList();
                if (raw.Count == 0)
                    raw = body.Split(' ', StringSplitOptions.RemoveEmptyEntries).Where(t => t.Contains(':')).ToList();

                // 模板占位（`{llm:appKey}` 这种）不参与校验——它不是真实标签。
                raw = raw.Where(t => !t.StartsWith("{") && !t.Contains('|')).ToList();
                if (raw.Count == 0) continue;

                foreach (var t in AdoptionToken.ParseList(string.Join(",", raw)))
                {
                    checkedCount++;
                    var where = $"{Path.GetFileName(file)}：{t.Raw}";
                    switch (t.Kind)
                    {
                        case "llm" when !validLlmKeys.Contains(t.Key):
                            problems.Add($"{where} —— appKey 前缀不在 AppCallerRegistry 里");
                            break;
                        case "dim" when !AdoptionToken.KnownDimensions.Contains(t.Key):
                            problems.Add($"{where} —— 维度只允许 {string.Join(" / ", AdoptionToken.KnownDimensions)}");
                            break;
                        case "none" when !AdoptionToken.KnownNoSignalReasons.Contains(t.Key):
                            problems.Add($"{where} —— none 的原因只允许 {string.Join(" / ", AdoptionToken.KnownNoSignalReasons)}");
                            break;
                        case "malformed":
                            problems.Add($"{where} —— 必须写成 <前缀>:<值>");
                            break;
                        case var k when !AdoptionToken.KnownKinds.Contains(k):
                            problems.Add($"{where} —— 前缀只允许 {string.Join(" / ", AdoptionToken.KnownKinds)}");
                            break;
                    }
                }
            }
        }

        Assert.True(problems.Count == 0,
            $"周报的用量口径标签有 {problems.Count} 处解析不到目标：\n" + string.Join("\n", problems));
        _output.WriteLine(checkedCount == 0
            ? $"扫描 {reports.Length} 份周报，暂无用量口径标签（约定从落地后的第一份周报开始生效）"
            : $"扫描 {reports.Length} 份周报，校验 {checkedCount} 个用量口径 token，全部可解析");
    }

    [Fact]
    public void 校验源必须是注册表实际前缀_而不是那两份更窄的清单()
    {
        // 这条锁死「别拿 app-identity.md 或 KnownAgentKeys 当白名单」这个结论。
        // 两份清单都只有十来个，而注册表实际前缀远多于它们——用窄清单会把真 key 判成非法。
        var prefixes = AppCallerRegistrationService.GetAllDefinitions()
            .Select(d => d.AppCode.Split('.')[0])
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        Assert.True(prefixes.Count > 13,
            $"注册表实际前缀只有 {prefixes.Count} 个，比 app-identity.md 还窄——本守卫的前提不成立，请核对");
    }

    private static string LocateRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            if (Directory.Exists(Path.Combine(dir.FullName, "doc"))
                && Directory.Exists(Path.Combine(dir.FullName, "prd-api")))
                return dir.FullName;
            dir = dir.Parent;
        }
        return AppContext.BaseDirectory;
    }
}
