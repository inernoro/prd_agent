namespace PrdAgent.Api.Controllers.Api.MarketplaceSkills;

/// <summary>
/// 把数据库技能与虚拟官方技能放进同一条排序管道。
/// 两类数据如果各排各的再拼接，开放接口的第一条会长期停在旧官方条目，
/// 与 sort=new 的契约相反，也会误导订阅游标。
/// </summary>
public static class MarketplaceSkillListSorter
{
    public sealed record Candidate(
        object Dto,
        DateTimeOffset CreatedAt,
        DateTimeOffset UpdatedAt,
        long DownloadCount);

    public static List<object> SortAndTake(
        IEnumerable<Candidate> candidates,
        string? sort,
        int limit)
    {
        var safeLimit = Math.Max(limit, 0);
        var ordered = sort == "new"
            ? candidates
                .OrderByDescending(item => item.UpdatedAt)
                .ThenByDescending(item => item.CreatedAt)
            : candidates
                .OrderByDescending(item => item.DownloadCount)
                .ThenByDescending(item => item.UpdatedAt)
                .ThenByDescending(item => item.CreatedAt);

        return ordered
            .Take(safeLimit)
            .Select(item => item.Dto)
            .ToList();
    }

    public static DateTimeOffset AsUtc(DateTime value)
    {
        var utc = value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc),
        };
        return new DateTimeOffset(utc);
    }
}
