namespace PrdAgent.Core.Models;

/// <summary>
/// 更新中心快照（终身存储）。
///
/// 设计意图（2026-06-04）：更新中心数据像一个「永不空白的橱窗」——
/// 每个视图（待发布 / 历史发布 / GitHub 日志）的最新结果以 JSON 形式终身存于此集合，
/// 服务重启也不丢。页面/接口加载时**只读存量**立即返回，绝不在请求里同步等 GitHub 拉取；
/// 真正的拉取由后台 <c>ChangelogRefreshWorker</c> 固定周期（默认 4 小时）执行，
/// 内容有变化才写库 + 通过 SSE 推送给正在看的页面。
///
/// 集合名：<c>changelog_snapshots</c>，按 <see cref="Key"/> upsert（单视图单条记录）。
/// </summary>
public class ChangelogSnapshot
{
    /// <summary>主键（Guid）。真正的业务唯一键是 <see cref="Key"/>。</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>视图键：current-week / releases:20 / github-logs:1000</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>序列化后的视图 DTO（camelCase JSON），加载时直接反序列化返回。</summary>
    public string PayloadJson { get; set; } = string.Empty;

    /// <summary>数据来源标识："local" / "github" / "none"</summary>
    public string Source { get; set; } = "none";

    /// <summary>
    /// 内容指纹（SHA256，已剔除 fetchedAt 等时间戳字段）。
    /// 仅当指纹变化时才视为「有更新」，触发写库 + 推送，避免每次刷新都误报变化。
    /// </summary>
    public string ContentHash { get; set; } = string.Empty;

    /// <summary>数据快照对应的拉取时间（UTC）。</summary>
    public DateTime FetchedAt { get; set; }

    /// <summary>本条记录最近写库时间（UTC）。</summary>
    public DateTime UpdatedAt { get; set; }
}
