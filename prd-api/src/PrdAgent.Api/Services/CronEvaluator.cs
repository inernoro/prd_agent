namespace PrdAgent.Api.Services;

/// <summary>
/// 极简 5 字段 Cron 解析器：分 时 日 月 周（0=Sun ~ 6=Sat）。
/// 支持: '*' / 整数 / 'a,b,c' 列表 / '*\/n' 步长 / 'a-b' 范围。
/// 不支持: '?', 'L', 'W', 'JAN-DEC' / 'MON-SUN' 字符。
/// 仅用于工作流定时调度，足以覆盖 90% 的"每天 X 点 / 每周 X 几点 / 每月 X 号"场景。
/// </summary>
public static class CronEvaluator
{
    /// <summary>找到 from（含）之后下一个匹配的 UTC 时间。最多向前找 366 天。</summary>
    public static DateTime NextOccurrence(string cron, DateTime from)
    {
        var fields = cron.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (fields.Length != 5)
            throw new ArgumentException($"Cron 必须是 5 字段（分 时 日 月 周），实际收到 {fields.Length} 字段: {cron}");

        var minute = ParseField(fields[0], 0, 59);
        var hour = ParseField(fields[1], 0, 23);
        var dom = ParseField(fields[2], 1, 31);
        var month = ParseField(fields[3], 1, 12);
        var dow = ParseField(fields[4], 0, 6);

        // 从 from 的下一分钟开始扫描
        var t = new DateTime(from.Year, from.Month, from.Day, from.Hour, from.Minute, 0, DateTimeKind.Utc).AddMinutes(1);
        var deadline = t.AddDays(366);

        while (t < deadline)
        {
            if (!month.Contains(t.Month)) { t = t.AddMonths(1); t = new DateTime(t.Year, t.Month, 1, 0, 0, 0, DateTimeKind.Utc); continue; }
            if (!dom.Contains(t.Day) || !dow.Contains((int)t.DayOfWeek)) { t = t.AddDays(1); t = new DateTime(t.Year, t.Month, t.Day, 0, 0, 0, DateTimeKind.Utc); continue; }
            if (!hour.Contains(t.Hour)) { t = t.AddHours(1); t = new DateTime(t.Year, t.Month, t.Day, t.Hour, 0, 0, DateTimeKind.Utc); continue; }
            if (!minute.Contains(t.Minute)) { t = t.AddMinutes(1); continue; }
            return t;
        }

        throw new InvalidOperationException($"Cron 在 366 天内找不到下次执行时间: {cron}");
    }

    private static HashSet<int> ParseField(string field, int min, int max)
    {
        var result = new HashSet<int>();
        foreach (var part in field.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            var trimmed = part.Trim();
            int step = 1;
            string range = trimmed;

            // step: a/n 或 *\/n
            var slashIdx = trimmed.IndexOf('/');
            if (slashIdx >= 0)
            {
                step = int.Parse(trimmed[(slashIdx + 1)..]);
                if (step <= 0) throw new ArgumentException($"步长必须 > 0: {trimmed}");
                range = trimmed[..slashIdx];
            }

            int lo, hi;
            if (range == "*")
            {
                lo = min; hi = max;
            }
            else if (range.Contains('-'))
            {
                var dashIdx = range.IndexOf('-');
                lo = int.Parse(range[..dashIdx]);
                hi = int.Parse(range[(dashIdx + 1)..]);
            }
            else
            {
                lo = hi = int.Parse(range);
            }

            if (lo < min || hi > max || lo > hi)
                throw new ArgumentException($"字段越界 [{lo},{hi}] 不在 [{min},{max}] 内: {trimmed}");

            for (int i = lo; i <= hi; i += step)
                result.Add(i);
        }
        return result;
    }
}
