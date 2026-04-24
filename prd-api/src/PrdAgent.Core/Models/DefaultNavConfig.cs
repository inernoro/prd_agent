using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 全局默认导航配置。用户未设置个人导航时回退到此配置。
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
public class DefaultNavConfig
{
    /// <summary>固定单例 ID。</summary>
    public string Id { get; set; } = "singleton";

    /// <summary>默认导航顺序；为空表示使用系统内置顺序。</summary>
    public List<string>? NavOrder { get; set; }

    /// <summary>默认隐藏项；为空表示不额外隐藏。</summary>
    public List<string>? NavHidden { get; set; }

    /// <summary>更新时间。</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
