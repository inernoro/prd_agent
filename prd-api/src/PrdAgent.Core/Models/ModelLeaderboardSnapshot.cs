using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 一份模型排行榜快照（一个榜单 = 一条文档，每次同步覆盖写）。
///
/// 为什么存快照而不是实时代理：
/// 数据来自 arena.ai 的公开榜单页，它没有开放 API（实测 /api/leaderboard 返回 403
/// "Route not allowed"），只能解析页面 HTML。页面每次请求 5MB 左右，且随时可能改版。
/// 所以由后台任务每天抓一次落库，页面永远读库——外站抖动不会打到用户，改版也只是
/// 让快照变旧而不是让页面开天窗（配合 <see cref="FetchedAt"/> 如实显示数据日期）。
/// </summary>
[BsonIgnoreExtraElements]
public class ModelLeaderboardSnapshot
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>榜单标识，对应 arena.ai 的分榜路径：agent / code / document / vision / text-to-image 等</summary>
    public string Board { get; set; } = string.Empty;

    /// <summary>抓取成功的时刻（UTC）。页面上「数据截至」显示的就是它，不许拿当前时间冒充</summary>
    public DateTime FetchedAt { get; set; }

    /// <summary>抓取的源地址，原样记录便于复核与追责</summary>
    public string SourceUrl { get; set; } = string.Empty;

    /// <summary>抓取它的容器标签（host@sha·branch），排查「谁写的」用</summary>
    public string? SourceLabel { get; set; }

    /// <summary>榜单条目，已按名次升序</summary>
    public List<ModelLeaderboardEntry> Entries { get; set; } = new();
}

/// <summary>榜单里的一行</summary>
[BsonIgnoreExtraElements]
public class ModelLeaderboardEntry
{
    /// <summary>名次，从 1 开始。取自条目在页面中的顺序（页面已排好序），不解析名次单元格</summary>
    public int Rank { get; set; }

    /// <summary>模型展示名，如 "Claude Opus 5 (High)"</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>厂商，如 "Anthropic"</summary>
    public string? Organization { get; set; }

    /// <summary>授权，如 "Proprietary" / "MIT"。用于「仅开源」筛选</summary>
    public string? License { get; set; }

    /// <summary>该榜的主分数。agent 榜是净改进百分比（13.85 表示 +13.85%）</summary>
    public double Score { get; set; }

    /// <summary>分数的 ± 误差范围，榜单原始值带这个，缺失时为 null</summary>
    public double? Margin { get; set; }

    /// <summary>
    /// 上一份快照里的名次，由同步任务比对后填。
    ///
    /// 首次同步时没有上一份快照，这里为 null，前端据此**不显示**升降箭头——
    /// 而不是默认成「无变化」。没有的数据就是没有，不拿 0 冒充。
    /// </summary>
    public int? PreviousRank { get; set; }
}
