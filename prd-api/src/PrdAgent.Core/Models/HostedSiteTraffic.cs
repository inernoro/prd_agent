namespace PrdAgent.Core.Models;

/// <summary>只读访问摘要；两种范围共用记录来源和三十分钟时段去重规则，不入库。</summary>
public class HostedSiteTraffic
{
    public long ActiveShareLinks { get; set; }
    public HostedSiteTrafficScope All { get; set; } = new();
    public HostedSiteTrafficScope External { get; set; } = new();
}

public class HostedSiteTrafficScope
{
    public long Visits { get; set; }
    public long Visitors { get; set; }
    public DateTime? LastViewedAt { get; set; }
}

/// <summary>合并站内和分享访问，排除作者以站点归属为准，而非当前查看统计的人。</summary>
public sealed class HostedSiteTrafficAccumulator(string ownerUserId)
{
    public const long WindowMilliseconds = 30 * 60 * 1000;
    private readonly HashSet<(string Visitor, long Window)> _windows = new();
    private readonly HashSet<string> _visitors = new(StringComparer.Ordinal);
    private readonly HashSet<string> _externalVisitors = new(StringComparer.Ordinal);
    public HostedSiteTraffic Value { get; } = new();

    // 旧累计数证明曾经有人访问，但日志已缺失时，不把无法还原的统计伪装成零。
    public HostedSiteTraffic? Build(long legacyViewCount) =>
        legacyViewCount > 0 && Value.All.Visits == 0 ? null : Value;

    public void Add(string? viewerUserId, string? ipAddress, DateTime viewedAt)
    {
        var visitor = !string.IsNullOrWhiteSpace(viewerUserId) ? "user:" + viewerUserId
            : !string.IsNullOrWhiteSpace(ipAddress) ? "ip:" + ipAddress : "anonymous";
        var window = new DateTimeOffset(DateTime.SpecifyKind(viewedAt, DateTimeKind.Utc)).ToUnixTimeMilliseconds() / WindowMilliseconds;
        var external = string.IsNullOrWhiteSpace(viewerUserId) || viewerUserId != ownerUserId;
        if (_windows.Add((visitor, window)))
        {
            Value.All.Visits++;
            if (external) Value.External.Visits++;
        }
        _visitors.Add(visitor);
        Value.All.Visitors = _visitors.Count;
        Value.All.LastViewedAt = Latest(Value.All.LastViewedAt, viewedAt);
        if (external)
        {
            _externalVisitors.Add(visitor);
            Value.External.Visitors = _externalVisitors.Count;
            Value.External.LastViewedAt = Latest(Value.External.LastViewedAt, viewedAt);
        }
    }

    private static DateTime Latest(DateTime? current, DateTime value) => current == null || value > current.Value ? value : current.Value;
}
