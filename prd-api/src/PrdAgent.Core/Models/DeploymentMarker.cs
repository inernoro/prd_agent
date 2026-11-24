namespace PrdAgent.Core.Models;

/// <summary>
/// 「这个库上已经做过某件一次性的事」的标记。
///
/// 为什么不挂在 AppSettings 上：那一行是可导出的（跨实例同步会带走它），而这里记的
/// 恰恰是**本站自己的运行状态**。同步过来一份别处的标记，轻则把本站已消费的一次性
/// 动作重新武装起来，重则反过来——那正是这类标记最不能出的事。放一个不导出的集合里，
/// 从物理上断掉这条路，比在脱敏清单里多加一行更可靠。
/// </summary>
public class DeploymentMarker
{
    /// <summary>标记名，如 admin-force-reset。</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>已消费的值。语义由写入方定义，这里不做解释。</summary>
    public string Value { get; set; } = string.Empty;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
