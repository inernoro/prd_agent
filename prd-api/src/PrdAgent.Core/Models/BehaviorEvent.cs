namespace PrdAgent.Core.Models;

/// <summary>
/// 用户行为信号事件（行为洞察面板的采集层）。
/// 由前端 behaviorTracker 批量上报，只记录「路由级」信号（停留时长 / 路由跳转），
/// 不记录输入内容与业务数据；分析时只输出聚合结果，不展示个体明细。
/// </summary>
public class BehaviorEvent
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>上报用户 UserId（JWT sub）</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>事件类型：route-dwell（页面可见停留） / route-transition（路由跳转）</summary>
    public string Type { get; set; } = string.Empty;

    /// <summary>归一化路由（参数段已替换为 :id，如 /visual-agent/:id）</summary>
    public string Route { get; set; } = string.Empty;

    /// <summary>来源路由（route-transition 用）</summary>
    public string? FromRoute { get; set; }

    /// <summary>页面可见停留毫秒数（route-dwell 用；标签页隐藏时间不计入）</summary>
    public long? DwellMs { get; set; }

    /// <summary>事件在客户端发生的时间</summary>
    public DateTime OccurredAt { get; set; }

    /// <summary>服务端落库时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
