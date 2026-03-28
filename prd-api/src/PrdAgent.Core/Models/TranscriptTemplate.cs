using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;
using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

[AppOwnership(AppNames.TranscriptAgent, AppNames.TranscriptAgentDisplay)]
public class TranscriptTemplate
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = null!;

    public string Name { get; set; } = null!;

    /// <summary>模板描述</summary>
    public string? Description { get; set; }

    /// <summary>AI 转写文案时使用的 Prompt</summary>
    public string Prompt { get; set; } = null!;

    /// <summary>是否为系统内置模板</summary>
    public bool IsSystem { get; set; }

    /// <summary>创建者（系统模板为 null）</summary>
    public string? OwnerUserId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
