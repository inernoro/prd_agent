using System.Globalization;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Services.ReportAgent;

/// <summary>月报校验错误：Chapter 为章节序号（-1 表示整份月报），前端据此滚动到对应章节。</summary>
public sealed record MonthlyReportValidationError(int Chapter, string Message);

/// <summary>
/// 月报纯规则（不访问数据库，便于单测）：周归属、可选月份、字段校验、可关联周报判定。
/// </summary>
public static class MonthlyReportRules
{
    public const int MaxPartners = 3;
    public const int MaxPartnerNameLength = 30;
    public const int MaxPartnerReasonLength = 500;
    public const int MaxChapterTextLength = 20000;
    public const int MaxWeeklyLinks = 10;

    private static readonly TimeZoneInfo ChinaTimeZone = TimeZoneInfo.FindSystemTimeZoneById("Asia/Shanghai");

    /// <summary>
    /// 一周归属哪个月：按该周周四所在的自然月（ISO 8601 惯例）。
    /// 每周恰好属于一个月，跨月周不会被两份月报重复计入，也不会两边都漏。
    /// </summary>
    public static (int Year, int Month) GetAttributedMonth(int weekYear, int weekNumber)
    {
        var thursday = ISOWeek.ToDateTime(weekYear, weekNumber, DayOfWeek.Thursday);
        return (thursday.Year, thursday.Month);
    }

    public static bool IsAttributedTo(int weekYear, int weekNumber, int year, int month)
    {
        var (y, m) = GetAttributedMonth(weekYear, weekNumber);
        return y == year && m == month;
    }

    /// <summary>当月及以前的月份可写；不能提前写未来月份。</summary>
    public static bool IsMonthAllowed(int year, int month, DateTime utcNow)
    {
        if (month < 1 || month > 12 || year < 2000 || year > 2100) return false;
        var now = TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utcNow, DateTimeKind.Utc), ChinaTimeZone);
        return year < now.Year || (year == now.Year && month <= now.Month);
    }

    /// <summary>可关联的周报：本人、同团队、已提交过（草稿 / 未开始不能被引用，避免负责人点进去看到半成品）。</summary>
    public static bool IsLinkableWeekly(WeeklyReport weekly, string authorUserId, string teamId)
    {
        if (weekly.UserId != authorUserId || weekly.TeamId != teamId) return false;
        return weekly.Status is not (WeeklyReportStatus.Draft or WeeklyReportStatus.NotStarted);
    }

    /// <summary>保存时的结构校验（草稿允许不完整，但不允许结构上不成立的内容）。</summary>
    public static List<MonthlyReportValidationError> ValidateForSave(MonthlyReport report)
    {
        var errors = new List<MonthlyReportValidationError>();

        if (report.WeeklyLinks.Count > MaxWeeklyLinks)
            errors.Add(new(MonthlyReportChapters.Achievements, $"最多关联 {MaxWeeklyLinks} 份周报"));
        if (report.WeeklyLinks.Select(l => l.WeeklyReportId).Distinct().Count() != report.WeeklyLinks.Count)
            errors.Add(new(MonthlyReportChapters.Achievements, "同一份周报不能重复关联"));

        CheckLength(errors, MonthlyReportChapters.Achievements, report.AchievementsText);
        CheckLength(errors, MonthlyReportChapters.Problems, report.ProblemsText);
        CheckLength(errors, MonthlyReportChapters.Suggestions, report.SuggestionsText);

        // 第三章选填：最多 3 位；写了理由就必须写名字
        var partners = report.Partners;
        if (partners.Count > MaxPartners)
            errors.Add(new(MonthlyReportChapters.Partners, $"最多写 {MaxPartners} 位伙伴"));
        if (partners.Any(p => string.IsNullOrWhiteSpace(p.DisplayName)))
            errors.Add(new(MonthlyReportChapters.Partners, "请填写伙伴的名字"));
        if (partners.Any(p => p.DisplayName.Length > MaxPartnerNameLength))
            errors.Add(new(MonthlyReportChapters.Partners, $"伙伴名字不能超过 {MaxPartnerNameLength} 字"));
        if (partners.Any(p => (p.Reason ?? string.Empty).Length > MaxPartnerReasonLength))
            errors.Add(new(MonthlyReportChapters.Partners, $"每位伙伴的理由不能超过 {MaxPartnerReasonLength} 字"));

        return errors;
    }

    /// <summary>提交时的完整校验：结构校验 + 必填项（只有第一章必填）。</summary>
    public static List<MonthlyReportValidationError> ValidateForSubmit(MonthlyReport report)
    {
        var errors = ValidateForSave(report);

        if (report.WeeklyLinks.Count == 0 && string.IsNullOrWhiteSpace(report.AchievementsText))
            errors.Add(new(MonthlyReportChapters.Achievements, "请至少关联一份周报，或写下本月工作成果"));

        return errors;
    }

    private static void CheckLength(List<MonthlyReportValidationError> errors, int chapter, string? text)
    {
        if ((text ?? string.Empty).Length > MaxChapterTextLength)
            errors.Add(new(chapter, $"「{MonthlyReportChapters.TitleOf(chapter)}」不能超过 {MaxChapterTextLength} 字"));
    }
}
