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
