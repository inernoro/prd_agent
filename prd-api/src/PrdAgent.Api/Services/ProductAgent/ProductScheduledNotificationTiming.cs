using System.Globalization;

namespace PrdAgent.Api.Services.ProductAgent;

public static class ProductScheduledNotificationTiming
{
    public const string ProtectionPurpose = "product-agent.scheduled-notification.webhook.v1";
    public const string MaskedWebhook = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=********";
    private static readonly TimeSpan BeijingOffset = TimeSpan.FromHours(8);

    public static bool TryGetNext(string? frequency, string? time, string? date, int? day, DateTime now, out DateTime? next)
    {
        next = null;
        if (!TimeOnly.TryParseExact(time, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out var clock))
            return false;
        if (frequency == "once")
        {
            if (!DateOnly.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var localDate)
                || localDate.Year is < 2000 or > 9998) return false;
            var utc = new DateTimeOffset(localDate.ToDateTime(clock), BeijingOffset).UtcDateTime;
            next = utc > now ? utc : null;
            return true;
        }
        var hour = clock.Hour;
        var minute = clock.Minute;
        var cron = frequency switch
        {
            "daily" => FormattableString.Invariant($"{minute} {hour} * * *"),
            "weekly" when day is >= 0 and <= 6 => FormattableString.Invariant($"{minute} {hour} * * {day}"),
            "monthly" when day is >= 1 and <= 31 => FormattableString.Invariant($"{minute} {hour} {day} * *"),
            _ => null,
        };
        if (cron == null) return false;
        // Beijing has a fixed UTC+08:00 offset for future schedules.
        next = CronEvaluator.NextOccurrence(cron, now.Add(BeijingOffset)).Subtract(BeijingOffset);
        return true;
    }
}
