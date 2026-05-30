namespace PrdAgent.Core.Models;

/// <summary>
/// 项目管理操作审计日志 — 留痕所有写操作（合规/追溯）。
/// 由 MVC ActionFilter 在写操作成功后自动写入，无需逐端点埋点。
/// 仅存 ActorId（显示名在读取时批量解析，避免每次写入多查一次库）。
/// </summary>
public class PmAuditLog
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联项目（写操作路由带 projectId 时填充，否则为空）</summary>
    public string? ProjectId { get; set; }

    /// <summary>操作人 UserId</summary>
    public string ActorId { get; set; } = string.Empty;

    /// <summary>动作标识（Controller Action 名，如 CreateGoal）</summary>
    public string Action { get; set; } = string.Empty;

    /// <summary>动作中文标签（如「新增目标」）</summary>
    public string ActionLabel { get; set; } = string.Empty;

    /// <summary>HTTP 方法</summary>
    public string Method { get; set; } = string.Empty;

    /// <summary>请求路径</summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>操作对象 ID（路由里最具体的子实体 id，如 taskId/goalId）</summary>
    public string? TargetId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
