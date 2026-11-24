namespace PrdAgent.Core.Helpers;

/// <summary>
/// 作品广场热度排序公式（带时间衰减）。
///
/// 原排序是「点赞数 desc → 创建时间 desc」，老爆款永远霸榜，新作品永远沉底，
/// 且分页缺稳定 tiebreaker 导致翻页重复。改为热度分 + 时间衰减后，新作品自然冒泡，
/// 旧作品随时间退场。MongoDB 聚合管道里用等价表达式实现，本类是该公式的
/// 唯一权威定义 + 单元测试锚点（SubmissionsController 的管道必须与此一致）。
///
/// 公式（新鲜度与互动热度分开衰减）：
///   freshness = ExposureBaseline / pow(ageHours / FreshnessScaleHours + 2, Gravity)
///   engagement = (likeCount * LikeWeight + viewCount) / pow(ageHours + 2, Gravity)
///   hot = freshness + engagement
/// </summary>
public static class GalleryRanking
{
    /// <summary>
    /// 新作品的基础曝光分。没有这 1 分时，零互动作品的热度永远是 0，
    /// 会被任何有过一次浏览的旧作品永久压住，形成无法获得首轮曝光的死循环。
    /// </summary>
    public const double ExposureBaseline = 1.0;

    /// <summary>
    /// 新鲜度的时间刻度。按 7 天为一个刻度衰减，让低流量阶段的新作有足够长的发现期；
    /// 发布 7 天后仍保留约 54% 的初始新鲜度，30 天后约保留 18%。
    /// </summary>
    public const double FreshnessScaleHours = 24.0 * 7.0;

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
        var freshness = ExposureBaseline
            / Math.Pow(ageHours / FreshnessScaleHours + 2.0, Gravity);
        var engagement = (likeCount * LikeWeight + viewCount)
            / Math.Pow(ageHours + 2.0, Gravity);
        return freshness + engagement;
    }

    /// <summary>
    /// 计算热度分（按创建时间与当前时间推导 ageHours）。
    /// </summary>
    public static double HotScore(int likeCount, int viewCount, DateTime createdAtUtc, DateTime nowUtc)
        => HotScore(likeCount, viewCount, (nowUtc - createdAtUtc).TotalHours);

    /// <summary>
    /// 解析排序使用的有效更新时间。单张视觉作品创建后内容不变，按投稿时间计算；
    /// 文学作品会在原 workspace 上持续产生新版本，因此取投稿、公开状态和源 workspace
    /// 三者中的最新时间，让真实内容更新能够重新参与首页排序。
    /// </summary>
    public static DateTime ResolveActivityAt(
        DateTime createdAtUtc,
        DateTime submissionUpdatedAtUtc,
        DateTime? sourceUpdatedAtUtc,
        bool tracksSourceUpdates)
    {
        if (!tracksSourceUpdates) return createdAtUtc;

        var activityAt = submissionUpdatedAtUtc > createdAtUtc
            ? submissionUpdatedAtUtc
            : createdAtUtc;
        if (sourceUpdatedAtUtc.HasValue && sourceUpdatedAtUtc.Value > activityAt)
            activityAt = sourceUpdatedAtUtc.Value;
        return activityAt;
    }
}
