using PrdAgent.Core.Models;

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
        PlanName = item.PlanName,
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

    private static string WithOwner(string text, string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return text;
        var codeLine = text.LastIndexOf('\n');
        return text.Insert(codeLine + 1, $"产品负责人：{name.Trim()}\n");
    }
}
