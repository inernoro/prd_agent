namespace PrdAgent.Core.Models;

/// <summary>
/// 从工作流 Artifact 或个人数据源解析出的统计数据（v2.0）
/// </summary>
public class TeamCollectedStats
{
    /// <summary>按数据源类型分组的统计</summary>
    public List<SourceStats> Sources { get; set; } = new();

    /// <summary>获取指定来源的统计，不存在则返回空</summary>
    public SourceStats GetSource(string sourceType)
        => Sources.FirstOrDefault(s => s.SourceType == sourceType) ?? new SourceStats { SourceType = sourceType };
}

/// <summary>
/// 单个数据源的统计结果
/// </summary>
public class SourceStats
{
    /// <summary>数据源类型：github / tapd / yuque / gitlab / daily_log</summary>
    public string SourceType { get; set; } = string.Empty;

    /// <summary>采集时间</summary>
    public DateTime? CollectedAt { get; set; }

    /// <summary>汇总计数（如 commits=23, prs_merged=3）</summary>
    public Dictionary<string, int> Summary { get; set; } = new();

    /// <summary>明细条目</summary>
    public List<StatsDetail> Details { get; set; } = new();
}

/// <summary>
/// 统计明细条目（commit/任务/文章等）
/// </summary>
public class StatsDetail
{
    /// <summary>条目 ID（commit hash、TAPD ID 等）</summary>
    public string? Id { get; set; }

    /// <summary>标题/描述</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>类型（story/bug/task/commit/article 等）</summary>
    public string? Type { get; set; }

    /// <summary>状态</summary>
    public string? Status { get; set; }

    /// <summary>归属人标识（用于按成员拆分）</summary>
    public string? Assignee { get; set; }

    /// <summary>完成/创建时间</summary>
    public DateTime? Timestamp { get; set; }
}

/// <summary>
/// 单个成员的统计数据（按身份映射拆分后）
/// </summary>
public class MemberCollectedStats
{
    /// <summary>用户 ID（系统 UserId）</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>各数据源的统计</summary>
    public List<SourceStats> Sources { get; set; } = new();

    /// <summary>转为 StatsSnapshot 字典（供 WeeklyReport.StatsSnapshot 使用）</summary>
    public Dictionary<string, object> ToSnapshot()
    {
        var snapshot = new Dictionary<string, object>();
        foreach (var source in Sources)
        {
            snapshot[source.SourceType] = source.Summary;
        }
        return snapshot;
    }
}
