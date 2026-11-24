using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services.ReportAgent;

/// <summary>
/// 访问者相对一份报告的身份。TeamRole 为 null 表示不是该团队成员。
/// </summary>
public readonly record struct ReportViewer(bool IsOwner, string? TeamRole, bool HasViewAll)
{
    public bool IsMember => TeamRole != null;
    public bool IsLeaderOrDeputy => TeamRole is ReportTeamRole.Leader or ReportTeamRole.Deputy;
}

/// <summary>
/// 周报 / 月报可见性的唯一判定源。所有查看、评论、点赞、浏览入口都调用这里，不在端点里各写一遍。
/// </summary>
public static class ReportAccessPolicy
{
    /// <summary>
    /// 周报互动（评论 / 点赞 / 浏览）：本人、有「查看全部」权限、或团队成员；
    /// 团队设为「仅负责人可查看」时，普通成员不能读写别人周报的互动。
    /// </summary>
    public static bool CanInteractWithWeekly(ReportViewer viewer, string? weeklyVisibility)
    {
        if (viewer.IsOwner || viewer.HasViewAll) return true;
        if (!viewer.IsMember) return false;
        return weeklyVisibility != ReportVisibilityMode.LeadersOnly || viewer.IsLeaderOrDeputy;
    }

    /// <summary>
    /// 月报查看（同时决定能否评论、点赞、记录浏览）：
    /// 草稿只有作者本人可见；提交后按团队「月报可见性」开关决定普通成员能否查看。
    /// </summary>
    public static bool CanViewMonthly(ReportViewer viewer, string? monthlyVisibility, string status)
    {
        if (viewer.IsOwner) return true;
        if (status == MonthlyReportStatus.Draft) return false;
        if (viewer.HasViewAll || viewer.IsLeaderOrDeputy) return true;
        return viewer.IsMember && monthlyVisibility != ReportVisibilityMode.LeadersOnly;
    }
}
