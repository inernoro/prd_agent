using PrdAgent.Core.Models;
using System.Text.RegularExpressions;

namespace PrdAgent.Api.Services.ProductAgent;

/// <summary>产品版本工作流沿用旧企微通知格式；历史登记数据不被改写。</summary>
internal static class ProductVersionCopyTemplate
{
    public static string Build(ProductInitiation item) => WithOwner(VersionRegistrationCopyTemplate.Build(new VersionRegistration
    {
        Kind = VersionRegistrationKind.Internal,
        Code = item.TCode ?? string.Empty,
        ProjectType = item.ProjectType,
        VersionType = item.VersionType,
        NeedUiDesign = item.NeedUiDesign,
        IsAiPoc = item.IsAiPoc,
        DemandSource = item.DemandSource,
        PlanName = WithInternalCode(item.PlanName, item.TCode),
        PlannedProjectAt = item.PlannedProjectAt,
    }), item.OwnerName);

    public static string Build(ProductRelease item) => WithOwner(VersionRegistrationCopyTemplate.Build(new VersionRegistration
    {
        Kind = VersionRegistrationKind.Formal,
        Code = item.VCode,
        ProjectType = item.ProjectType,
        VersionType = item.VersionType,
        IsGlobalOpen = item.IsGlobalOpen,
        DemandSource = item.DemandSource,
        PlanName = item.PlanName,
        PlanUrl = item.PlanUrl,
        ProjectMemberNames = item.ProjectMemberNames,
        PlannedReleaseAt = item.PlannedReleaseAt,
        PlannedTrainingMinutes = item.PlannedTrainingMinutes,
    }), item.OwnerName);

    private static string WithInternalCode(string? name, string? code)
    {
        var title = name?.Trim() ?? string.Empty;
        if (title.Length == 0 || string.IsNullOrWhiteSpace(code)) return title;
        var bracket = title.IndexOfAny(new[] { '（', '(' });
        var prefix = bracket < 0 ? title : title[..bracket];
        // 仅替换名称前缀末尾的版本号，括号内的业务描述保持原样。
        prefix = Regex.Replace(prefix.TrimEnd(), @"T\d+(?:\.\d+)+$", string.Empty, RegexOptions.IgnoreCase).TrimEnd();
        return prefix + code.Trim() + (bracket < 0 ? string.Empty : title[bracket..]);
    }

    private static string WithOwner(string text, string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return text;
        var codeLine = text.LastIndexOf('\n');
        return text.Insert(codeLine + 1, $"产品负责人：{name.Trim()}\n");
    }
}
