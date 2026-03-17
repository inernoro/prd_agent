namespace PrdAgent.Core.Models;

/// <summary>
/// 缺陷分享访问日志（用于监控 token 被谁、何时访问）
/// </summary>
public class DefectShareAccessLog
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Token { get; set; } = string.Empty;
    public string? DefectId { get; set; }
    public string? DefectNo { get; set; }

    /// <summary>ok | token-not-found | token-revoked | token-expired | defect-not-found</summary>
    public string Result { get; set; } = "ok";

    public string? Ip { get; set; }
    public string? UserAgent { get; set; }

    public DateTime AccessedAt { get; set; } = DateTime.UtcNow;
}
