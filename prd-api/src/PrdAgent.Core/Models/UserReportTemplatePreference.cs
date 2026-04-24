using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 用户周报模板偏好（每用户自己的默认模板选择，替代 ReportTemplate.IsDefault 的全局语义）
/// </summary>
[AppOwnership(AppNames.ReportAgent, AppNames.ReportAgentDisplay)]
public class UserReportTemplatePreference
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>用户 ID（唯一索引）</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>用户选择的默认模板 ID</summary>
    public string DefaultTemplateId { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
