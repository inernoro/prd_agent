using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 文档附件解除数据库引用后的对象存储清理任务。记录存在即表示仍需重试。
/// </summary>
[BsonIgnoreExtraElements]
public sealed class DocumentAssetCleanupTask
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string StorageKey { get; set; } = string.Empty;
    public string Purpose { get; set; } = string.Empty;
    public int AttemptCount { get; set; }
    public DateTime NextAttemptAt { get; set; } = DateTime.UtcNow;
    public DateTime? LastAttemptAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
