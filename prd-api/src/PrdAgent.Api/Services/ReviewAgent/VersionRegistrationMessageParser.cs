using System.Globalization;
using System.Text.RegularExpressions;

namespace PrdAgent.Api.Services.ReviewAgent;

/// <summary>
/// 将企微中按“字段：内容”发送的版本登记消息识别为可回填字段。
/// 未识别到的字段保持为空，调用方不能据此推断或补造数据。
/// </summary>
public static partial class VersionRegistrationMessageParser
{
    public static VersionRegistrationMessageParseResult Parse(string? rawText, string? kind)
    {
        var text = rawText?.Trim() ?? string.Empty;
        var isInternal = string.Equals(kind, "internal", StringComparison.OrdinalIgnoreCase);
        var result = new VersionRegistrationMessageParseResult();

        SetProjectType(result, GetFieldValue(text, "项目类别", "项目类型"));
        SetVersionType(result, GetFieldValue(text, "版本类别", "版本类型"));
        SetText(result, "demandSource", value => result.DemandSource = value, GetFieldValue(text, "需求来源"));
        SetText(result, "planName", value => result.PlanName = value,
            isInternal
                ? GetFieldValue(text, "产品立项方案名称", "立项方案名称", "产品方案名称", "方案名称")
                : GetFieldValue(text, "产品方案名称", "上线方案名称", "方案名称", "产品立项方案名称"));
        SetText(result, "planUrl", value => result.PlanUrl = value, GetFieldValue(text, "方案地址", "产品方案地址"));
        SetMembers(result, GetFieldValue(text, "项目组成员", "项目成员"));

        if (isInternal)
        {
            SetBoolean(result, "needUiDesign", value => result.NeedUiDesign = value,
                GetFieldValue(text, "是否需要 UI 设计", "是否需要UI设计"));
            SetBoolean(result, "isAiPoc", value => result.IsAiPoc = value,
                GetFieldValue(text, "是否属于 AI POC 项目", "是否属于AI POC项目", "是否为 AI POC 项目", "是否为AI POC项目"));
            SetDate(result, "plannedProjectAt", value => result.PlannedProjectAt = value,
                GetFieldValue(text, "计划立项时间", "立项时间"));
        }
        else
        {
            SetBoolean(result, "isGlobalOpen", value => result.IsGlobalOpen = value,
                GetFieldValue(text, "是否全域开放", "全域开放"));
            SetDate(result, "plannedReleaseAt", value => result.PlannedReleaseAt = value,
                GetFieldValue(text, "计划上线时间", "上线时间"));
            var tCode = VersionCodeRegex().Match(text);
            if (tCode.Success)
            {
                result.TCode = $"T{tCode.Groups["major"].Value}.{tCode.Groups["medium"].Value}.{tCode.Groups["minor"].Value}";
                result.MatchedFields.Add("tCode");
            }
        }

        return result;
    }

    private static void SetProjectType(VersionRegistrationMessageParseResult result, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        if (value.Contains("非定制", StringComparison.Ordinal) || value.Contains("标准", StringComparison.OrdinalIgnoreCase))
            result.ProjectType = "standard";
        else if (value.Contains("定制", StringComparison.Ordinal))
            result.ProjectType = "custom";
        else
            return;
        result.MatchedFields.Add("projectType");
    }

    private static void SetVersionType(VersionRegistrationMessageParseResult result, string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        if (value.Contains("大", StringComparison.Ordinal) || value.Contains("major", StringComparison.OrdinalIgnoreCase))
            result.VersionType = "major";
        else if (value.Contains("中", StringComparison.Ordinal) || value.Contains("medium", StringComparison.OrdinalIgnoreCase))
            result.VersionType = "medium";
        else if (value.Contains("小", StringComparison.Ordinal) || value.Contains("minor", StringComparison.OrdinalIgnoreCase))
            result.VersionType = "minor";
        else
            return;
        result.MatchedFields.Add("versionType");
    }

    private static void SetText(VersionRegistrationMessageParseResult result, string field, Action<string> assign, string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || string.Equals(value, "无", StringComparison.Ordinal)) return;
        assign(value);
        result.MatchedFields.Add(field);
    }

    private static void SetMembers(VersionRegistrationMessageParseResult result, string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || string.Equals(value, "无", StringComparison.Ordinal)) return;
        var members = value.Split(new[] { '、', ',', '，', ';', '；' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(item => item.Trim())
            .Where(item => item.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToList();
        if (members.Count == 0) return;
        result.ProjectMemberNames = members;
        result.MatchedFields.Add("projectMemberNames");
    }

    private static void SetBoolean(VersionRegistrationMessageParseResult result, string field, Action<bool> assign, string? value)
    {
        var parsed = ParseBoolean(value);
        if (!parsed.HasValue) return;
        assign(parsed.Value);
        result.MatchedFields.Add(field);
    }

    private static void SetDate(VersionRegistrationMessageParseResult result, string field, Action<DateTime> assign, string? value)
    {
        var parsed = ParseDate(value);
        if (!parsed.HasValue) return;
        assign(parsed.Value);
        result.MatchedFields.Add(field);
    }

    private static string? GetFieldValue(string text, params string[] labels)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        foreach (var line in text.Split('\n'))
        {
            var candidate = line.Trim();
            foreach (var label in labels)
            {
                var match = Regex.Match(candidate, $@"^(?:[-*]\s*)?{Regex.Escape(label)}\s*[：:]\s*(?<value>.+?)\s*$", RegexOptions.IgnoreCase);
                if (match.Success)
                    return match.Groups["value"].Value.Trim();
            }
        }
        return null;
    }

    private static bool? ParseBoolean(string? value)
    {
        var normalized = value?.Trim().ToLowerInvariant();
        return normalized switch
        {
            "是" or "需要" or "yes" or "true" or "1" => true,
            "否" or "不需要" or "no" or "false" or "0" => false,
            _ => null,
        };
    }

    private static DateTime? ParseDate(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var match = DateRegex().Match(value);
        if (match.Success
            && int.TryParse(match.Groups["year"].Value, out var year)
            && int.TryParse(match.Groups["month"].Value, out var month)
            && int.TryParse(match.Groups["day"].Value, out var day))
        {
            try { return new DateTime(year, month, day); }
            catch (ArgumentOutOfRangeException) { return null; }
        }
        return DateTime.TryParse(value, CultureInfo.GetCultureInfo("zh-CN"), DateTimeStyles.AllowWhiteSpaces, out var parsed)
            ? parsed.Date
            : null;
    }

    [GeneratedRegex(@"(?<![A-Z0-9])T\s*(?<major>\d+)\.(?<medium>\d+)\.(?<minor>\d+)(?![A-Z0-9])", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex VersionCodeRegex();

    [GeneratedRegex(@"(?<year>20\d{2})[./-](?<month>\d{1,2})[./-](?<day>\d{1,2})", RegexOptions.CultureInvariant)]
    private static partial Regex DateRegex();
}

public sealed class VersionRegistrationMessageParseResult
{
    public string? ProjectType { get; set; }
    public string? VersionType { get; set; }
    public bool? NeedUiDesign { get; set; }
    public bool? IsAiPoc { get; set; }
    public bool? IsGlobalOpen { get; set; }
    public string? DemandSource { get; set; }
    public string? PlanName { get; set; }
    public string? PlanUrl { get; set; }
    public List<string> ProjectMemberNames { get; set; } = new();
    public DateTime? PlannedProjectAt { get; set; }
    public DateTime? PlannedReleaseAt { get; set; }
    public string? TCode { get; set; }
    public List<string> MatchedFields { get; } = new();
}
