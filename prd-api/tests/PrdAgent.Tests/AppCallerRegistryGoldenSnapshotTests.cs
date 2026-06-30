using System.IO;
using System.Text.Json;
using PrdAgent.Core.Models;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Tests;

/// <summary>
/// 注册表黄金快照测试（纯单元，CI 默认执行）。
///
/// 反射 AppCallerRegistry 全部 [AppCallerMetadata] 常量，连同其声明的 ModelTypes，
/// 序列化成稳定排序的快照，与提交进仓库的 golden 文件
/// (fixtures/app-caller-registry.golden.json) 逐项对照，断言零 diff。
///
/// 目的：
///   - 新增一个 AppCallerCode → 快照多出一项 → 忘更新 golden 即红；
///   - 改名 / 删除一个 code → 快照变化 → 即红；
///   - 改动某 code 的 ModelTypes → 快照变化 → 即红。
///
/// golden 文件由「反射当前注册表的真实结果」生成后落盘，保证首次即绿。
/// 对照基准见 doc/design.llm-gateway-unification.md §11.1。
/// </summary>
public class AppCallerRegistryGoldenSnapshotTests
{
    private readonly ITestOutputHelper _output;

    public AppCallerRegistryGoldenSnapshotTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /// <summary>快照单项：一个 code 及其稳定排序的 ModelTypes。</summary>
    private sealed record SnapshotEntry(string Code, List<string> ModelTypes);

    [Fact]
    public void RegistrySnapshot_ShouldMatchGoldenFile()
    {
        var actual = BuildSnapshotFromRegistry();
        var golden = LoadGoldenSnapshot();

        // 逐项对照，给出精确的缺失 / 多出 / ModelTypes 漂移定位。
        var actualByCode = actual.ToDictionary(e => e.Code, e => e.ModelTypes, StringComparer.Ordinal);
        var goldenByCode = golden.ToDictionary(e => e.Code, e => e.ModelTypes, StringComparer.Ordinal);

        var addedCodes = actualByCode.Keys.Except(goldenByCode.Keys, StringComparer.Ordinal).OrderBy(c => c, StringComparer.Ordinal).ToList();
        var removedCodes = goldenByCode.Keys.Except(actualByCode.Keys, StringComparer.Ordinal).OrderBy(c => c, StringComparer.Ordinal).ToList();

        var modelTypeDrift = new List<string>();
        foreach (var code in actualByCode.Keys.Intersect(goldenByCode.Keys, StringComparer.Ordinal).OrderBy(c => c, StringComparer.Ordinal))
        {
            var a = actualByCode[code];
            var g = goldenByCode[code];
            if (!a.SequenceEqual(g, StringComparer.Ordinal))
            {
                modelTypeDrift.Add($"  ~ {code}: golden=[{string.Join(", ", g)}] 实际=[{string.Join(", ", a)}]");
            }
        }

        if (addedCodes.Count == 0 && removedCodes.Count == 0 && modelTypeDrift.Count == 0)
        {
            _output.WriteLine($"OK 注册表快照与 golden 一致，共 {actual.Count} 个 AppCallerCode。");
            return;
        }

        var lines = new List<string>
        {
            "注册表快照与 golden 文件不一致 ——",
            "若本次确实新增/改名/删除了 AppCallerCode 或改了它的 ModelTypes，",
            "请重新生成 golden 文件：",
            "  fixtures/app-caller-registry.golden.json",
            "（用反射当前注册表的真实结果覆盖，再提交）。",
            "",
        };
        if (addedCodes.Count > 0)
        {
            lines.Add("新增（golden 里没有，需补进 golden）：");
            lines.AddRange(addedCodes.Select(c => $"  + {c}"));
        }
        if (removedCodes.Count > 0)
        {
            lines.Add("缺失（golden 里有但注册表已删/改名）：");
            lines.AddRange(removedCodes.Select(c => $"  - {c}"));
        }
        if (modelTypeDrift.Count > 0)
        {
            lines.Add("ModelTypes 漂移：");
            lines.AddRange(modelTypeDrift);
        }

        var msg = string.Join('\n', lines);
        _output.WriteLine(msg);
        Assert.Fail(msg);
    }

    /// <summary>反射注册表，构造稳定排序的快照。</summary>
    private static List<SnapshotEntry> BuildSnapshotFromRegistry()
    {
        return AppCallerRegistrationService.GetAllDefinitions()
            .Select(d => new SnapshotEntry(
                d.AppCode ?? string.Empty,
                (d.ModelTypes ?? Array.Empty<string>())
                    .OrderBy(m => m, StringComparer.Ordinal)
                    .ToList()))
            .OrderBy(e => e.Code, StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>读取 golden 文件并解析为稳定排序的快照。</summary>
    private List<SnapshotEntry> LoadGoldenSnapshot()
    {
        var path = LocateGoldenFile();
        Assert.True(File.Exists(path), $"找不到 golden 文件: {path}");

        var json = File.ReadAllText(path);
        var raw = JsonSerializer.Deserialize<List<GoldenRow>>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        }) ?? new List<GoldenRow>();

        return raw
            .Select(r => new SnapshotEntry(
                r.Code ?? string.Empty,
                (r.ModelTypes ?? new List<string>())
                    .OrderBy(m => m, StringComparer.Ordinal)
                    .ToList()))
            .OrderBy(e => e.Code, StringComparer.Ordinal)
            .ToList();
    }

    private sealed class GoldenRow
    {
        public string? Code { get; set; }
        public List<string>? ModelTypes { get; set; }
    }

    private static string LocateGoldenFile()
    {
        // 测试进程 cwd 通常是 bin/Debug/net8.0/；往上找到 prd-api/tests/PrdAgent.Tests/fixtures。
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(
                dir.FullName, "prd-api", "tests", "PrdAgent.Tests", "fixtures",
                "app-caller-registry.golden.json");
            if (File.Exists(candidate)) return candidate;

            // 当从 prd-api/tests/PrdAgent.Tests/bin/... 往上走时，直接命中本项目 fixtures。
            candidate = Path.Combine(dir.FullName, "fixtures", "app-caller-registry.golden.json");
            if (File.Exists(candidate)) return candidate;

            dir = dir.Parent;
        }
        // 兜底：相对当前目录尝试源码树位置。
        return Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "fixtures",
            "app-caller-registry.golden.json"));
    }
}
