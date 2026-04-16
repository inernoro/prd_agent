using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

public static class DocumentSyncSchedule
{
    private static readonly TimeZoneInfo SyncTimeZone = ResolveTimeZone();

    public static bool IsDue(DocumentEntry entry, DateTime utcNow)
    {
        if (entry.IsPaused)
            return false;

        if (entry.SyncStatus == DocumentSyncStatus.Syncing)
            return true;

        if (entry.LastSyncAt == null)
            return true;

        if (entry.SourceType == DocumentSourceType.GithubDirectory)
        {
            var lastLocalDate = TimeZoneInfo.ConvertTimeFromUtc(
                DateTime.SpecifyKind(entry.LastSyncAt.Value, DateTimeKind.Utc),
                SyncTimeZone).Date;
            var nowLocalDate = TimeZoneInfo.ConvertTimeFromUtc(
                DateTime.SpecifyKind(utcNow, DateTimeKind.Utc),
                SyncTimeZone).Date;
            return lastLocalDate < nowLocalDate;
        }

        return entry.SyncIntervalMinutes > 0 &&
               entry.LastSyncAt.Value.AddMinutes(entry.SyncIntervalMinutes.Value) <= utcNow;
    }

    public static DateTime? GetNextSyncAt(DocumentEntry entry)
    {
        if (entry.IsPaused)
            return null;

        if (entry.SourceType == DocumentSourceType.GithubDirectory)
        {
            if (!entry.LastSyncAt.HasValue)
                return entry.CreatedAt;

            var lastLocal = TimeZoneInfo.ConvertTimeFromUtc(
                DateTime.SpecifyKind(entry.LastSyncAt.Value, DateTimeKind.Utc),
                SyncTimeZone);
            var nextLocalMidnight = lastLocal.Date.AddDays(1);
            return TimeZoneInfo.ConvertTimeToUtc(nextLocalMidnight, SyncTimeZone);
        }

        if (entry.LastSyncAt.HasValue && entry.SyncIntervalMinutes is > 0)
            return entry.LastSyncAt.Value.AddMinutes(entry.SyncIntervalMinutes.Value);

        return null;
    }

    private static TimeZoneInfo ResolveTimeZone()
    {
        foreach (var id in new[] { "Asia/Shanghai", "China Standard Time" })
        {
            try
            {
                return TimeZoneInfo.FindSystemTimeZoneById(id);
            }
            catch (TimeZoneNotFoundException)
            {
            }
            catch (InvalidTimeZoneException)
            {
            }
        }

        return TimeZoneInfo.Utc;
    }
}
