namespace PrdAgent.Core.Models;

/// <summary>
/// 通道身份映射（将外部通道标识映射到系统用户）
/// </summary>
public class ChannelIdentityMapping
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>
    /// 通道类型：email, sms, siri, webhook
    /// </summary>
    public string ChannelType { get; set; } = ChannelTypes.Email;

    /// <summary>
    /// 通道内唯一标识（邮箱地址、手机号、设备ID等）
    /// </summary>
    public string ChannelIdentifier { get; set; } = string.Empty;

    /// <summary>
    /// 映射到的系统用户ID
    /// </summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>
    /// 用户显示名称（冗余，便于展示）
    /// </summary>
    public string? UserName { get; set; }

    /// <summary>
    /// 是否已验证
    /// </summary>
    public bool IsVerified { get; set; } = false;

    /// <summary>
    /// 验证时间
    /// </summary>
    public DateTime? VerifiedAt { get; set; }

    /// <summary>
    /// 验证码（用于邮件/短信验证）
    /// </summary>
    public string? VerificationCode { get; set; }

    /// <summary>
    /// 验证码过期时间
    /// </summary>
    public DateTime? VerificationCodeExpiresAt { get; set; }

    /// <summary>
    /// 创建人 AdminId（管理员创建时填写）
    /// </summary>
    public string? CreatedBy { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
