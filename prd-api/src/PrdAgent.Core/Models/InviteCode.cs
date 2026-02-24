using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 邀请码实体
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay, IsPrimary = true)]
public class InviteCode
{
    /// <summary>
    /// MongoDB 主键（_id）。统一使用 string(Guid)；业务侧请使用 <see cref="Code"/>。
    /// </summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string Code { get; set; } = string.Empty;
    public string CreatorId { get; set; } = string.Empty;
    public bool IsUsed { get; set; }
    public string? UsedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? UsedAt { get; set; }
    public DateTime? ExpiresAt { get; set; }
}
