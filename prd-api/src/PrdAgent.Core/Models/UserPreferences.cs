namespace PrdAgent.Core.Models;

/// <summary>
/// 用户偏好设置（每个用户一条记录，userId 作为主键）
/// </summary>
public class UserPreferences
{
    /// <summary>用户 ID（作为 MongoDB _id）</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// 导航项排序（存储导航项 key 的有序列表）。
    /// 仅存储用户自定义的顺序，不存在的导航项会追加到末尾。
    /// </summary>
    public List<string>? NavOrder { get; set; }

    /// <summary>更新时间</summary>
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
