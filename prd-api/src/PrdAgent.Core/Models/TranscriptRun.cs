using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;
using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

[AppOwnership(AppNames.TranscriptAgent, AppNames.TranscriptAgentDisplay)]
public class TranscriptRun
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = null!;

    public string ItemId { get; set; } = null!;

    public string WorkspaceId { get; set; } = null!;

    public string OwnerUserId { get; set; } = null!;

    /// <summary>任务类型: asr / copywrite</summary>
    public string Type { get; set; } = null!;

    /// <summary>状态: queued / processing / completed / failed</summary>
    public string Status { get; set; } = "queued";

    /// <summary>copywrite 类型时使用的模板 ID</summary>
    public string? TemplateId { get; set; }

    /// <summary>copywrite 生成的文案结果</summary>
    public string? Result { get; set; }

    public string? Error { get; set; }

    public int Progress { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
