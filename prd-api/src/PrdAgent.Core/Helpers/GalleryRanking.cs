namespace PrdAgent.Core.Helpers;

/// <summary>
/// 作品广场热度排序公式（带时间衰减）。
///
/// 原排序是「点赞数 desc → 创建时间 desc」，老爆款永远霸榜，新作品永远沉底，
/// 且分页缺稳定 tiebreaker 导致翻页重复。改为热度分 + 时间衰减后，新作品自然冒泡，
/// 旧作品随时间退场。MongoDB 聚合管道里用等价表达式实现，本类是该公式的
/// 唯一权威定义 + 单元测试锚点（SubmissionsController 的管道必须与此一致）。
///
/// 公式（HN/Reddit 风格柔和衰减）：
///   hot = (likeCount * LikeWeight + viewCount) / pow(ageHours + 2, Gravity)
/// </summary>
public static class GalleryRanking
{
    /// <summary>点赞相对浏览的权重（1 个赞 ≈ 3 次浏览）</summary>
    public const double LikeWeight = 3.0;

    /// <summary>时间衰减指数，越大旧作品掉得越快</summary>
    public const double Gravity = 1.5;

    /// <summary>
    /// 计算热度分。ageHours 为作品已发布的小时数（负数按 0 处理，防止未来时间刷分）。
    /// </summary>
    public static double HotScore(int likeCount, int viewCount, double ageHours)
    {
        if (ageHours < 0) ageHours = 0;
        var engagement = likeCount * LikeWeight + viewCount;
        return engagement / Math.Pow(ageHours + 2.0, Gravity);
    }

    /// <summary>
    /// 计算热度分（按创建时间与当前时间推导 ageHours）。
    /// </summary>
    public static double HotScore(int likeCount, int viewCount, DateTime createdAtUtc, DateTime nowUtc)
        => HotScore(likeCount, viewCount, (nowUtc - createdAtUtc).TotalHours);
}
