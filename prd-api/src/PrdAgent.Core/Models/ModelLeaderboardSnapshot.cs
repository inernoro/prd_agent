using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 一份模型排行榜快照（一个榜单 = 一条文档，每次同步覆盖写）。
///
/// 为什么存快照而不是实时代理：
/// 数据来自 arena.ai 的公开榜单页，它没有开放 API（实测 /api/leaderboard 返回 403
/// "Route not allowed"），只能解析页面 HTML。页面每次请求 1.8MB 左右，且随时可能改版。
/// 所以由后台任务每天抓一次落库，页面永远读库——外站抖动不会打到用户，改版也只是
/// 让快照变旧而不是让页面开天窗（配合 <see cref="FetchedAt"/> 如实显示数据日期）。
/// </summary>
[BsonIgnoreExtraElements]
public class ModelLeaderboardSnapshot
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>榜单标识，对应 arena.ai 的分榜路径。目前只有 agent（原因见 ModelLeaderboardSyncWorker.Boards）</summary>
    public string Board { get; set; } = string.Empty;

    /// <summary>抓取成功的时刻（UTC）。页面上「数据截至」显示的就是它，不许拿当前时间冒充</summary>
    public DateTime FetchedAt { get; set; }

    /// <summary>抓取的源地址，原样记录便于复核与追责</summary>
    public string SourceUrl { get; set; } = string.Empty;

    /// <summary>抓取它的容器标签（host@sha·branch），排查「谁写的」用</summary>
    public string? SourceLabel { get; set; }

    /// <summary>
    /// 榜单口径下的会话总数（页面头部那个「1,587,202 sessions」）。
    /// 抓不到时为 null——页面上就不显示这一格，不填 0 冒充。
    /// </summary>
    public long? TotalSessions { get; set; }

    /// <summary>榜单条目，已按名次升序</summary>
    public List<ModelLeaderboardEntry> Entries { get; set; } = new();
}

/// <summary>
/// 榜单里的一个指标：值 + 置信区间半宽。
///
/// 值自带正负号（页面上的 ▲/▼ 已经解析进符号里），所以 -0.91 就是「掉了 0.91%」，
/// 前端不需要再去看一个单独的方向字段。
/// </summary>
[BsonIgnoreExtraElements]
public class ModelLeaderboardMetric
{
    /// <summary>指标值，百分比数字（13.85 表示 +13.85%，-0.91 表示 −0.91%）</summary>
    public double Value { get; set; }

    /// <summary>95% 置信区间半宽（±后面那个数）。榜单没给时为 null</summary>
    public double? Margin { get; set; }
}

/// <summary>榜单里的一行</summary>
[BsonIgnoreExtraElements]
public class ModelLeaderboardEntry
{
    /// <summary>名次，从 1 开始。取自条目在页面中的顺序（页面已排好序），不解析名次单元格</summary>
    public int Rank { get; set; }

    /// <summary>
    /// 名次的置信区间下界 / 上界（页面上名次下方那个「1 ↔ 4」）。
    ///
    /// 为什么要存：两个模型的区间重叠时，它们的名次差别本来就不作数。只给一个精确名次
    /// 是在假装确定性，页面上把区间一起显示出来才诚实。抓不到时为 null，前端不显示。
    /// </summary>
    public int? RankLow { get; set; }

    /// <summary>见 <see cref="RankLow"/></summary>
    public int? RankHigh { get; set; }

    /// <summary>模型展示名，如 "Claude Opus 5 (High)"</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>厂商，如 "Anthropic"</summary>
    public string? Organization { get; set; }

    /// <summary>授权，如 "Proprietary" / "MIT"。用于「仅开源」筛选</summary>
    public string? License { get; set; }

    /// <summary>净改进：主排序指标，也是榜单的默认排序依据</summary>
    public ModelLeaderboardMetric? NetImprovement { get; set; }

    /// <summary>任务完成（Confirmed Success）</summary>
    public ModelLeaderboardMetric? ConfirmedSuccess { get; set; }

    /// <summary>好评比（Praise vs Complaint）</summary>
    public ModelLeaderboardMetric? PraiseVsComplaint { get; set; }

    /// <summary>可操控性（Steerability）</summary>
    public ModelLeaderboardMetric? Steerability { get; set; }

    /// <summary>命令恢复（Bash Recovery）</summary>
    public ModelLeaderboardMetric? BashRecovery { get; set; }

    /// <summary>工具幻觉（Tool Hallucination）——这项越低越好</summary>
    public ModelLeaderboardMetric? ToolHallucination { get; set; }

    /// <summary>该模型的会话样本数（页面上的 Sessions 列，原样保留千分位前的数值）</summary>
    public long? Sessions { get; set; }

    /// <summary>单任务成本中位数，美元（Cost/Task P50）</summary>
    public double? CostPerTask { get; set; }

    /// <summary>单任务输出 token 中位数，原样保留页面写法（如 "55.2K"）</summary>
    public string? OutputTokens { get; set; }

    /// <summary>输入单价，美元/百万 token</summary>
    public double? PriceInput { get; set; }

    /// <summary>输出单价，美元/百万 token</summary>
    public double? PriceOutput { get; set; }

    /// <summary>
    /// 上一份快照里的名次，由同步任务比对后填。
    ///
    /// 首次同步时没有上一份快照，这里为 null，前端据此**不显示**升降箭头——
    /// 而不是默认成「无变化」。没有的数据就是没有，不拿 0 冒充。
    /// </summary>
    public int? PreviousRank { get; set; }
}
