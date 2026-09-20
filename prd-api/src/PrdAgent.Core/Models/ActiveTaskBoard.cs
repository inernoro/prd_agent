namespace PrdAgent.Core.Models;

/// <summary>
/// 活动任务面板的文案工具。
///
/// 这里曾经有一整套结论生成（粮草档位、估准度、损耗归因、自述句），全删了 ——
/// 那些在衡量人，不在帮人沟通。剩下的只有一个把秒写成人话的函数。
/// </summary>
public static class ActiveTaskConclusion
{
    /// <summary>
    /// 把「什么时候要」写成人话，照提醒事项那套：今天 / 明天 / 周几 / 日期，过期说「昨天要的」。
    ///
    /// 标签由后端算，前端不再算一遍 —— 同一个判断分成两份，迟早在跨月、跨年那几天对不上。
    /// 返回 null 表示这条没设时间（大多数任务都不该有时间）。
    /// </summary>
    public static string? FormatDue(DateTime? dueUtc, DateTime nowUtc)
    {
        if (!dueUtc.HasValue) return null;

        // 按团队日历天算差，不按 24 小时算 —— 「明天早上 9 点」在今晚 10 点看必须还是「明天」
        var due = TeamDate(dueUtc.Value);
        var today = TeamDate(nowUtc);
        var days = (due - today).Days;

        if (days == 0) return "今天";
        if (days == 1) return "明天";
        if (days == -1) return "昨天要的";
        if (days < -1) return $"{-days} 天前要的";
        if (days <= 6) return WeekdayName(due);
        return due.ToString("M月d日");
    }

    /// <summary>这条时间是不是已经过了。过期只是淡淡标一下，不报警、不算准时率。</summary>
    public static bool IsOverdue(DateTime? dueUtc, DateTime nowUtc)
        => dueUtc.HasValue && TeamDate(dueUtc.Value) < TeamDate(nowUtc);

    /// <summary>
    /// 团队日历相对 UTC 的偏移。「今天是哪天」这件事必须全系统只有一个答案 ——
    /// 之前标签这边用 <c>ToLocalTime()</c>（跟着容器时区走），AI 导入那边写死东八区，
    /// 于是在 UTC 容器上，每天 08:00 到 16:00（北京时间）之间，导入时判为「今天」的那条
    /// 会被标成「明天」。同一个判断两处各算各的，就是必然漂移的两份账。
    /// </summary>
    public static readonly TimeSpan TeamUtcOffset = TimeSpan.FromHours(8);

    /// <summary>把一个 UTC 时刻折算成团队日历上的那一天。</summary>
    public static DateTime TeamDate(DateTime utc) => (utc + TeamUtcOffset).Date;

    private static string WeekdayName(DateTime d) => d.DayOfWeek switch
    {
        DayOfWeek.Monday => "周一",
        DayOfWeek.Tuesday => "周二",
        DayOfWeek.Wednesday => "周三",
        DayOfWeek.Thursday => "周四",
        DayOfWeek.Friday => "周五",
        DayOfWeek.Saturday => "周六",
        _ => "周日",
    };

    /// <summary>
    /// 把秒写成人话。刻意不给秒 —— 精确到秒的计时是监工，不是汇报：
    /// 「做了 3 小时」够回答「做多久了」，「03:12:40」只会让人盯着它跳。
    /// </summary>
    public static string FormatDuration(int seconds)
    {
        var s = Math.Max(seconds, 0);
        if (s < 60) return "刚开始";
        var m = s / 60;
        if (m < 60) return $"{m} 分钟";
        var h = m / 60;
        if (h < 24) return $"{h} 小时";
        return $"{h / 24} 天";
    }
}
