using System.Globalization;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services.ReviewAgent;

/// <summary>按历史企微登记格式生成可直接复制发送的版本通知。</summary>
internal static class VersionRegistrationCopyTemplate
{
    public static string Build(VersionRegistration record) =>
        string.Equals(record.Kind, VersionRegistrationKind.Internal, StringComparison.Ordinal)
            ? BuildInternal(record)
            : BuildFormal(record);

    private static string BuildInternal(VersionRegistration record) => string.Join("\n", new[]
    {
        "【版本立项】",
        $"项目类别：{ProjectTypeLabel(record.ProjectType)}",
        $"版本类别：{VersionTypeLabel(record.VersionType)}",
        $"是否需要UI设计：{BooleanLabel(record.NeedUiDesign)}",
        $"是否属于AI POC项目：{BooleanLabel(record.IsAiPoc)}",
        $"需求来源：{Text(record.DemandSource)}",
        $"产品立项方案名称：{Text(record.PlanName)}",
        $"计划立项时间：{DateLabel(record.PlannedProjectAt)}",
        record.Code,
    });

    private static string BuildFormal(VersionRegistration record) => string.Join("\n", new[]
    {
        "【版本上线】",
        $"项目类别：{ProjectTypeLabel(record.ProjectType)}",
        $"版本类别：{VersionTypeLabel(record.VersionType)}",
        $"是否全域开放：{BooleanLabel(record.IsGlobalOpen)}",
        $"需求来源：{Text(record.DemandSource)}",
        $"产品方案名称：{Text(record.PlanName)}",
        $"方案地址：{Text(record.PlanUrl)}",
        $"项目组成员：{string.Join("、", record.ProjectMemberNames)}",
        $"计划上线时间：{DateLabel(record.PlannedReleaseAt)}",
        $"预计培训时间：{TrainingTimeLabel(record.PlannedTrainingAt)}",
        record.Code,
    });

    private static string ProjectTypeLabel(string? value) => value switch
    {
        "standard" => "非定制",
        "custom" => "定制",
        _ => string.Empty,
    };

    private static string VersionTypeLabel(string? value) => value switch
    {
        "major" => "大版本",
        "medium" => "中版本",
        "minor" => "小版本",
        _ => string.Empty,
    };

    private static string BooleanLabel(bool? value) => value switch
    {
        true => "是",
        false => "否",
        null => string.Empty,
    };

    private static string DateLabel(DateTime? value)
    {
        if (!value.HasValue) return string.Empty;
        var date = value.Value.Kind switch
        {
            DateTimeKind.Utc => value.Value.AddHours(8),
            DateTimeKind.Local => value.Value.ToUniversalTime().AddHours(8),
            _ => value.Value,
        };
        return date.ToString("yyyy.M.d", CultureInfo.InvariantCulture);
    }

    private static string TrainingTimeLabel(DateTime? value) =>
        value.HasValue
            ? DateTime.SpecifyKind(value.Value, DateTimeKind.Utc).AddHours(8)
                .ToString("yyyy.M.d HH:mm", CultureInfo.InvariantCulture)
            : string.Empty;

    private static string Text(string? value) => value?.Trim() ?? string.Empty;
}
