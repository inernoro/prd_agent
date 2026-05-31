using System.Text.RegularExpressions;

namespace PrdAgent.Api.Services;

/// <summary>
/// 知识库模板注册表 —— 把"报告该长什么样"的约束从技能下沉到知识库本身。
/// store.TemplateKey 命中模板后，写入条目会按模板校验必填 metadata / 正文 section。
/// 当前内置 acceptance-report-v2（验收报告），仿 ReprocessTemplateRegistry 写法。
/// 校验逻辑全为纯函数，可在单测直接断言，无需 DB。
/// </summary>
public static class AcceptanceTemplateRegistry
{
    /// <summary>验收报告模板 key（与前端 acceptanceVerdictRegistry、archive_report.py 约定一致）</summary>
    public const string AcceptanceReportV2 = "acceptance-report-v2";

    public static readonly IReadOnlyList<KbTemplate> Templates = new List<KbTemplate>
    {
        new(
            Key: AcceptanceReportV2,
            Label: "验收报告",
            Description: "标准化功能验收报告（MAP 验收标准 v2）：结论可视 + 证据可追溯",
            // 必填 metadata 键。verdict 取值受 VerdictValues 约束。
            RequiredMetadataKeys: new[] { "verdict", "tier", "target" },
            // 正文必须出现的 H2 section 标题（## 开头，忽略空白差异）。
            // 只校验标准 v2 唯一强制的语义 section「需求一一对应表」（standard-v2.md §6.4）——
            // 它是唯一固定的 H2（其余正文走 ZZ「## 步骤 N」风，无固定语义标题），
            // 且技能准入校验已保证其存在，故此处校验对机器归档零误伤、对外部写入者构成兜底约束。
            RequiredSections: new[] { "需求一一对应表" }
        ),
    };

    /// <summary>verdict 合法取值（与前端徽章注册表一致）</summary>
    public static readonly string[] VerdictValues = { "pass", "conditional", "fail" };

    public static KbTemplate? FindByKey(string? key)
    {
        if (string.IsNullOrEmpty(key)) return null;
        return Templates.FirstOrDefault(t => t.Key == key);
    }

    /// <summary>
    /// 校验某条记录的 metadata 是否满足模板必填字段。
    /// 返回缺失/非法项列表（空 = 通过）。纯函数，无副作用。
    /// </summary>
    public static IReadOnlyList<string> ValidateMetadata(KbTemplate template, IReadOnlyDictionary<string, string>? metadata)
    {
        var problems = new List<string>();
        metadata ??= new Dictionary<string, string>();

        foreach (var key in template.RequiredMetadataKeys)
        {
            if (!metadata.TryGetValue(key, out var v) || string.IsNullOrWhiteSpace(v))
                problems.Add($"缺少必填元数据：{key}");
        }

        if (metadata.TryGetValue("verdict", out var verdict) && !string.IsNullOrWhiteSpace(verdict)
            && !VerdictValues.Contains(verdict.Trim().ToLowerInvariant()))
        {
            problems.Add($"verdict 取值非法（应为 {string.Join(" / ", VerdictValues)}）：{verdict}");
        }

        return problems;
    }

    /// <summary>
    /// 校验正文是否包含模板要求的所有 H2 section。
    /// 返回缺失 section 列表（空 = 通过）。纯函数，无副作用。
    /// </summary>
    public static IReadOnlyList<string> ValidateContentSections(KbTemplate template, string? content)
    {
        var problems = new List<string>();
        var headings = ExtractH2Headings(content ?? string.Empty);

        foreach (var required in template.RequiredSections)
        {
            var needle = Normalize(required);
            if (!headings.Any(h => h.Contains(needle)))
                problems.Add($"缺少正文章节：## {required}");
        }

        return problems;
    }

    /// <summary>提取所有 H2（## 开头）标题文本，已归一化（去空白、转小写）</summary>
    private static List<string> ExtractH2Headings(string content)
    {
        var result = new List<string>();
        foreach (Match m in Regex.Matches(content, @"^\s{0,3}##\s+(.+?)\s*$", RegexOptions.Multiline))
        {
            result.Add(Normalize(m.Groups[1].Value));
        }
        return result;
    }

    /// <summary>归一化：去所有空白 + 小写，让"验收 结论"和"验收结论"等价匹配</summary>
    private static string Normalize(string s)
        => Regex.Replace(s, @"\s+", string.Empty).ToLowerInvariant();
}

public record KbTemplate(
    string Key,
    string Label,
    string Description,
    string[] RequiredMetadataKeys,
    string[] RequiredSections);
