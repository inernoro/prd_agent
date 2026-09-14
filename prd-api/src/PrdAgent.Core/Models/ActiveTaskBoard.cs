namespace PrdAgent.Core.Models;

/// <summary>
/// 活动任务面板的结论生成 —— 纯函数，便于单测。
///
/// 为什么是规则生成而不是 LLM 生成：面板要秒开、要可复现、出错要能定位到具体分支。
/// LLM 更适合长文本汇报（周报），不适合仪表盘头条（见 .claude/rules/conclusion-before-numbers.md）。
/// </summary>
public static class ActiveTaskConclusion
{
    /// <summary>
    /// 团队头条：一句挂着数字的判断句，不是一排让人自己算的指标。
    /// 全员都正常时不说「整体表现良好」这种放到任何团队都成立的空话，而是点明没有需要介入的事。
    /// </summary>
    public static string BuildTeamHeadline(int onDuty, int blocked, int lowFuel, int overrun)
    {
        if (onDuty <= 0) return "今天还没有人汇报在做什么。";

        var problems = new List<string>();
        if (blocked > 0) problems.Add($"{blocked} 人卡住");
        if (lowFuel > 0) problems.Add($"{lowFuel} 人备用见底");
        if (overrun > 0) problems.Add($"{overrun} 人超期");

        if (problems.Count == 0)
            return $"{onDuty} 人在岗，都在推进中，没有需要你介入的事。";

        var normal = onDuty - blocked - lowFuel - overrun;
        var tail = normal > 0 ? $"；其余 {normal} 人节奏正常。" : "。";
        return $"{onDuty} 人在岗，其中 {string.Join("、", problems)}{tail}";
    }

    /// <summary>
    /// 备用任务的粮草结论。备用不是无限长的 backlog，是余量 —— 见底要报警，
    /// 因为「这个人做完手上这件就没活了」是老板现在就该知道的事。
    /// </summary>
    public static string BuildFuelLabel(int standbyCount, int totalEstimateMinutes, int lowThreshold)
    {
        if (standbyCount <= 0) return "备用见底 · 做完就没活了";

        var days = totalEstimateMinutes > 0
            ? Math.Round(totalEstimateMinutes / 60.0 / 8.0, 1)
            : 0;
        var span = days > 0 ? $" · 约 {FormatDays(days)}" : "";
        return standbyCount <= lowThreshold
            ? $"粮草 {standbyCount} 件 · 偏少{span}"
            : $"粮草 {standbyCount} 件{span}";
    }

    /// <summary>粮草档位：empty / low / ok，前端据此上色，不在前端重算一遍阈值。</summary>
    public static string FuelLevel(int standbyCount, int lowThreshold)
        => standbyCount <= 0 ? "empty" : standbyCount <= lowThreshold ? "low" : "ok";

    /// <summary>把 0.5 / 1 / 6 天写成人话，避免出现「0 天」这种在极端值下退化成噪音的量纲。</summary>
    public static string FormatDays(double days)
    {
        if (days < 0.2) return "不到半天";
        if (days < 1) return "半天多";
        return $"{days:0.#} 天";
    }

    /// <summary>
    /// 把秒写成人话。不足一小时给分钟 —— 写成「0 小时」是极端值下的量纲退化。
    /// </summary>
    public static string FormatDuration(int seconds)
    {
        if (seconds < 60) return $"{Math.Max(seconds, 0)} 秒";
        var m = seconds / 60;
        if (m < 60) return $"{m} 分";
        var h = m / 60;
        var rest = m % 60;
        return rest > 0 ? $"{h} 小时 {rest} 分" : $"{h} 小时";
    }

    /// <summary>
    /// 员工的自述句 —— 也就是「老板此刻看到的你」。
    /// 这句话由操作自动生成，员工能看见自己汇报出去长什么样，才有动力把状态维护准。
    /// </summary>
    public static string BuildSelfMirror(
        string displayName,
        ActiveTaskEntry? active,
        int standbyCount,
        DateTime now)
    {
        if (active == null)
        {
            return standbyCount > 0
                ? $"{displayName} 还没开始今天的第一件事，备用队列里有 {standbyCount} 件。"
                : $"{displayName} 还没说在做什么，备用队列也是空的。";
        }

        var spent = FormatDuration(active.ElapsedSecondsAt(now));
        if (active.Blocked)
        {
            var waited = FormatDuration(active.BlockedSecondsAt(now));
            var on = string.IsNullOrWhiteSpace(active.BlockedOn) ? "外部依赖" : active.BlockedOn;
            return $"{displayName} 卡住了 —— 正在做「{active.Title}」，已投入 {spent}，等 {on} 等了 {waited}。备用还有 {standbyCount} 件。";
        }

        var overrun = active.IsOverrun(now) ? "，已超出预估一倍以上" : "";
        return $"{displayName} 正在做「{active.Title}」，已投入 {spent}{overrun}。备用还有 {standbyCount} 件。";
    }
}
