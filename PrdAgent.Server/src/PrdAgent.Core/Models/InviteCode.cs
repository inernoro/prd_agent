namespace PrdAgent.Core.Models;

/// <summary>
/// 邀请码实体
/// </summary>
public class InviteCode
{
    public string Code { get; set; } = string.Empty;
    public string CreatorId { get; set; } = string.Empty;
    public bool IsUsed { get; set; }
    public string? UsedBy { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? UsedAt { get; set; }
    public DateTime? ExpiresAt { get; set; }
}

