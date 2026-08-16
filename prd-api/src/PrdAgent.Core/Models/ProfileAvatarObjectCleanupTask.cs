using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 用户替换头像后的对象存储清理任务。记录存在即表示仍需重试，删除成功或旧头像重新启用后移除。
/// </summary>
[BsonIgnoreExtraElements]
public sealed class ProfileAvatarObjectCleanupTask
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = string.Empty;
    public string PreviousFileName { get; set; } = string.Empty;
    public string ObjectKey { get; set; } = string.Empty;
    public int AttemptCount { get; set; }
    public DateTime NextAttemptAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastAttemptAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
