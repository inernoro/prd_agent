using PrdAgent.Core.Models;

namespace PrdAgent.Core.Security;

/// <summary>
/// 网页托管「分组级」权限的纯策略解析（无 DB、无 IO，CI 单测全覆盖）。
///
/// 与 WebHostingPermission 的分工：
/// - WebHostingPermission：空间级 —— 我在团队空间整体是 owner/editor/viewer
/// - 本类：分组级 —— 受限分组（专题/分类）按授权规则把可见/可操作裁剪到更细的人群
///
/// 解析铁律：
/// 1. visibility=inherit（默认）→ 完全跟随空间角色，存量数据零行为变化
/// 2. visibility=restricted → 空间 owner 恒为 owner（管理者必须能看到全部）；
///    其余成员按 AccessRules 命中（user 按 UserId、label 按角色标签交集）取最宽松档；
///    无命中 = null（分组与组内站点对其完全不可见）
/// 3. 规则档位允许「升格」：空间 viewer 可被授予某个分组的 editor（这正是分组级权限的意义）
/// </summary>
public static class WebPageGroupAccess
{
    /// <summary>分组是否受限</summary>
    public static bool IsRestricted(WebPageGroup? group) =>
        group != null && group.Visibility == WebPageGroupVisibility.Restricted;

    /// <summary>
    /// 解析用户对单个分组的有效角色（null = 分组对其不可见）。
    /// spaceRole 为该用户在分组所属团队的空间级网页托管角色（null = 非成员）。
    /// </summary>
    public static string? ResolveGroupRole(
        string? spaceRole, WebPageGroup group, string userId, IReadOnlyCollection<string>? myLabels)
    {
        if (spaceRole == null) return null; // 非团队成员，分组无从谈起
        if (!IsRestricted(group)) return spaceRole; // inherit：跟随空间

        if (spaceRole == WebHostingRoles.Owner) return WebHostingRoles.Owner; // 空间 owner 恒可管理

        string? best = null;
        foreach (var rule in group.AccessRules ?? new List<WebPageGroupAccessRule>())
        {
            if (string.IsNullOrWhiteSpace(rule.SubjectId)) continue;
            var hit = rule.SubjectType switch
            {
                WebPageGroupSubjectType.User => rule.SubjectId == userId,
                WebPageGroupSubjectType.Label => myLabels != null && myLabels.Contains(rule.SubjectId),
                _ => false,
            };
            if (!hit) continue;
            // 分组级只发 viewer/editor 两档，脏数据里的其他值按 viewer 兜底
            var granted = rule.Role == WebHostingRoles.Editor ? WebHostingRoles.Editor : WebHostingRoles.Viewer;
            best = WebHostingPermission.Max(best, granted);
        }
        return best;
    }

    /// <summary>
    /// 解析用户对「挂在某分组下的站点」的有效角色。
    /// 站点可能同时共享给多个团队，而分组只属于其中一个团队（group.TeamId）：
    /// - 分组所属团队那一路的角色被分组规则裁剪/升格
    /// - 其他共享团队的角色不受该分组影响（别的团队的成员资格不应被 A 团队的内部分组剥夺）
    /// - 站点创建者恒为 owner
    /// 取各路最宽松档为最终角色；null = 完全不可访问。
    /// </summary>
    public static string? ResolveSiteRoleWithGroup(
        bool isSiteOwner,
        IEnumerable<string>? sharedTeamIds,
        IReadOnlyDictionary<string, string> myTeamRoles,
        WebPageGroup? group,
        string userId,
        IReadOnlyCollection<string>? myLabelsInGroupTeam)
    {
        if (isSiteOwner) return WebHostingRoles.Owner;
        if (group == null || !IsRestricted(group))
            return WebHostingPermission.ResolveSiteRole(isSiteOwner, sharedTeamIds, myTeamRoles);

        string? best = null;
        foreach (var tid in sharedTeamIds ?? Array.Empty<string>())
        {
            if (tid == null || !myTeamRoles.TryGetValue(tid, out var spaceRole)) continue;
            var effective = tid == group.TeamId
                ? ResolveGroupRole(spaceRole, group, userId, myLabelsInGroupTeam)
                : spaceRole;
            best = WebHostingPermission.Max(best, effective);
        }
        return best;
    }
}
