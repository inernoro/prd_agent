using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

public static class DocumentSyncSchedule
{
    private static readonly TimeZoneInfo SyncTimeZone = ResolveTimeZone();

    /// <summary>
    /// 该条目是不是 GitHub 目录同步产出的**子文件**（由父目录条目统一拉，不单独同步）。
    ///
    /// 子条目的 SourceUrl 是列目录时拿到的 download_url。公开仓那是个稳定公网地址，
    /// 单独再拉一次只是白费一趟；**私有仓的 download_url 带着几分钟就过期的临时 token**，
    /// 单独拉必然 401/404，于是每天给用户刷一批假的同步失败。
    /// 父目录条目每天按 SHA 比对增删改，已经覆盖了子文件的更新，这里直接判不到期。
    /// </summary>
    public static bool IsGithubChildEntry(DocumentEntry entry)
        => entry.SourceType == DocumentSourceType.Subscription
        && entry.Metadata.ContainsKey("github_parent_id");

    public static bool IsDue(DocumentEntry entry, DateTime utcNow)
    {
        if (entry.IsPaused)
            return false;

        if (IsGithubChildEntry(entry))
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

        // 子文件跟着父目录条目的节奏走，自己没有独立的下次同步时间
        if (IsGithubChildEntry(entry))
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
