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

    /// <summary>榜单标识，对应 arena.ai 的分榜路径。取值见 ModelLeaderboardCatalog.Boards</summary>
    public string Board { get; set; } = string.Empty;

    /// <summary>
    /// 表格形状（BoardKind：agent / score），由解析器按页面表头判定后写入。
    ///
    /// 存进快照而不是让前端按 board 名硬猜：形状是**这份数据实际长什么样**的属性，
    /// 对方哪天把某个榜换了结构，快照里的 kind 会跟着变，页面自然换一套列。
    /// 存量文档没有这个字段时读作 agent（那时候库里只有 agent 榜）。
    /// </summary>
    public string Kind { get; set; } = "agent";

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

    /// <summary>
    /// 榜单口径下的总投票数（分数榜页面头部那个「8,146,274 votes」）。
    /// 与 <see cref="TotalSessions"/> 是两件事：agent 榜统计的是会话，分数榜统计的是人类投票，
    /// 所以分开两个字段，不合并成一个「总数」让前端去猜单位。
    /// </summary>
    public long? TotalVotes { get; set; }

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

    // ── 以下是分数榜（BoardKind.Score）的字段，agent 榜上全为 null ──

    /// <summary>
    /// 人类盲测对战分（Elo 风格，如 1506）。分数榜的主排序指标。
    ///
    /// 它是相对分，跨榜之间不可比——文生图的 1421 和文本对话的 1506 不是一回事，
    /// 页面上永远和榜名一起出现，不单独拎出来做「模型总分」。
    /// </summary>
    public double? Score { get; set; }

    /// <summary>
    /// 分数置信区间的上/下半宽。
    ///
    /// 页面上多数榜写「±13」（两边一样），code 榜写「+16/-16」这种非对称形式。
    /// 存成两个数而不是一个半宽，是为了不把非对称的区间压成对称的——真遇到 +20/-5
    /// 时，压扁会让误差须画错方向。两边相等时前端自己会渲染成「±13」。
    /// </summary>
    public double? ScoreMarginUp { get; set; }

    /// <summary>见 <see cref="ScoreMarginUp"/></summary>
    public double? ScoreMarginDown { get; set; }

    /// <summary>人类投票数（这个模型参与了多少次盲测对战）</summary>
    public long? Votes { get; set; }

    /// <summary>上下文窗口，原样保留页面写法（如 "1M" / "200K"）。图像视频榜没有这一列</summary>
    public string? ContextWindow { get; set; }

    /// <summary>
    /// 页面给这一行打了「Preliminary」标（样本还不够，分数会继续变）。
    /// 页面上要标出来——一个 3149 票的初步分和一个 23 万票的稳定分摆在一起，
    /// 不加标注就是在误导读者。
    /// </summary>
    public bool Preliminary { get; set; }

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
