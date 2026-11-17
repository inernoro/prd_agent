using System.Globalization;

namespace PrdAgent.Core.Models;

/// <summary>周报通知的结构化动作入口；旧记录只识别现有生产者的稳定业务键。</summary>
public static class ReportNotificationNavigation
{
    public static string OwnReport(string reportId) =>
        $"/report-agent?tab=report&report={Uri.EscapeDataString(reportId)}";

    public static string Report(string reportId) =>
        $"/report-agent/report/{Uri.EscapeDataString(reportId)}";

    public static string PersonalWeek(int year, int week) =>
        $"/report-agent?tab=report&weekYear={year}&weekNumber={week}";

    public static string TeamWeek(int year, int week, string? teamId = null, string? memberId = null) =>
        $"/report-agent?tab=team&weekYear={year}&weekNumber={week}"
        + (string.IsNullOrWhiteSpace(teamId) ? "" : $"&teamId={Uri.EscapeDataString(teamId)}")
        + (string.IsNullOrWhiteSpace(memberId) ? "" : $"&memberUserId={Uri.EscapeDataString(memberId)}");

    public static string? Resolve(AdminNotification notification)
    {
        if (notification.Source != "report-agent" || notification.ActionUrl != "/report-agent")
            return notification.ActionUrl;

        var parts = (notification.Key ?? "").Split(':');
        if (parts.Length == 3 && parts[0] == "report-agent" && parts[2].Length > 0)
        {
            if (parts[1] is "draft" or "returned") return OwnReport(parts[2]);
            if (parts[1] is "submitted" or "reviewed") return Report(parts[2]);
        }

        string? period = null;
        if (parts.Length == 3 && parts[0] == "report-auto-gen" && parts[1] == notification.TargetUserId)
            period = parts[2].Replace("-W", "-", StringComparison.Ordinal);
        else if (parts.Length == 4 && parts[0] == "report-agent"
                 && (parts[1] is "deadline" or "overdue") && parts[2] == notification.TargetUserId)
            period = parts[3];

        var weekParts = period?.Split('-');
        if (weekParts is { Length: 2 }
            && int.TryParse(weekParts[0], out var year) && year is >= 1 and <= 9999
            && int.TryParse(weekParts[1], out var week) && week >= 1 && week <= ISOWeek.GetWeeksInYear(year))
            return PersonalWeek(year, week);

        // 缺少可靠身份时不从标题、正文或发生时间猜测报告。
        return notification.ActionUrl;
    }
}
