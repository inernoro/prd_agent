using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 网页托管删除的持久化清理账本。删除意图和对象清单先落库，随后才删除站点记录；
/// 对象存储临时失败时由后台继续幂等重试，绝不把未完成清理报告为完整成功。
/// </summary>
[BsonIgnoreExtraElements]
public sealed class HostedSiteDeletionTask
{
    /// <summary>与站点 ID 相同，保证同一站点只有一份删除账本。</summary>
    public string Id { get; set; } = string.Empty;

    public string SiteId { get; set; } = string.Empty;
    public string SiteOwnerUserId { get; set; } = string.Empty;
    public string RequestedByUserId { get; set; } = string.Empty;
    public string SiteTitle { get; set; } = string.Empty;
    public List<string> SharedTeamIds { get; set; } = new();

    /// <summary>删除开始前固化的精确对象键；后台只能逐键删除，禁止按前缀删除。</summary>
    public List<string> ObjectKeys { get; set; } = new();

    public DateTime RequestedAt { get; set; } = DateTime.UtcNow;
    public DateTime? SiteRecordDeletedAt { get; set; }
    public DateTime? LastAttemptAt { get; set; }
    public DateTime NextAttemptAt { get; set; } = DateTime.UtcNow;
    public int AttemptCount { get; set; }

    /// <summary>只保存稳定错误分类，不保存上游响应、凭据或原始异常正文。</summary>
    public string? LastErrorCode { get; set; }

    public string? LeaseOwnerId { get; set; }
    public DateTime? LeaseExpiresAt { get; set; }
}

/// <summary>删除已进入持久清理队列，但对象尚未全部清理。</summary>
public sealed class HostedSiteDeletionPendingException : Exception
{
    public HostedSiteDeletionPendingException(
        string siteId,
        int attemptCount,
        int completedCount = 0,
        int pendingCount = 1)
        : base("站点删除已受理，但文件清理尚未完成，系统会自动重试")
    {
        SiteId = siteId;
        AttemptCount = attemptCount;
        CompletedCount = completedCount;
        PendingCount = pendingCount;
    }

    public string SiteId { get; }
    public int AttemptCount { get; }
    public int CompletedCount { get; }
    public int PendingCount { get; }
}
