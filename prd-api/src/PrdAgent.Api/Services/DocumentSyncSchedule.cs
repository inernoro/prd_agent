using MongoDB.Driver;
using PrdAgent.Core.Models;

namespace PrdAgent.Api.Services;

public static class DocumentSyncSchedule
{
    private static readonly TimeZoneInfo SyncTimeZone = ResolveTimeZone();

    /// <summary>普通订阅条目一轮最多取回多少条候选（取回后还要过 <see cref="IsDue"/>）。</summary>
    public const int RegularCandidateLimit = 50;

    /// <summary>
    /// 普通订阅条目的**认领查询**过滤器（唯一口径，Worker 只许用这一个）。
    ///
    /// 关键在最后那条排除：GitHub 子文件同样是 Subscription + 有 SourceUrl + 有同步周期，
    /// <see cref="IsDue"/> 会把它们判成不到期——但那是**取回之后**才生效的过滤。
    /// 查询里不排除的话，一个目录订阅产出的几十上百个子文件先把 Limit 窗口占满，
    /// 取回 50 条、全被判不到期，真正到期的普通订阅一条都轮不上，本轮什么都不同步。
    /// （判据与接线纪律形状 1：判据比它该管的范围窄。）
    /// </summary>
    public static FilterDefinition<DocumentEntry> BuildRegularCandidateFilter(DateTime utcNow)
        => Builders<DocumentEntry>.Filter.And(
            Builders<DocumentEntry>.Filter.Ne(e => e.SourceType, DocumentSourceType.GithubDirectory),
            Builders<DocumentEntry>.Filter.Ne(e => e.SourceUrl, null),
            Builders<DocumentEntry>.Filter.Gt(e => e.SyncIntervalMinutes, 0),
            Builders<DocumentEntry>.Filter.Ne(e => e.IsPaused, true),
            Builders<DocumentEntry>.Filter.Not(
                Builders<DocumentEntry>.Filter.Where(e => e.Metadata.ContainsKey(GithubParentIdKey))),
            Builders<DocumentEntry>.Filter.Or(
                Builders<DocumentEntry>.Filter.Eq(e => e.SyncStatus, DocumentSyncStatus.Syncing),
                Builders<DocumentEntry>.Filter.Eq(e => e.LastSyncAt, null),
                Builders<DocumentEntry>.Filter.Lt(e => e.LastSyncAt, utcNow.AddHours(-24))));

    /// <summary>子文件回指父目录条目的 metadata 键（查询与判据共用同一个字面量）。</summary>
    public const string GithubParentIdKey = "github_parent_id";

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
        && entry.Metadata.ContainsKey(GithubParentIdKey);

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
