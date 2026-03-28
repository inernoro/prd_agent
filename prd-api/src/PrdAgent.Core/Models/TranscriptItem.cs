using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;
using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

[AppOwnership(AppNames.TranscriptAgent, AppNames.TranscriptAgentDisplay)]
public class TranscriptItem
{
    [BsonId]
    [BsonRepresentation(BsonType.ObjectId)]
    public string Id { get; set; } = null!;

    public string WorkspaceId { get; set; } = null!;

    public string OwnerUserId { get; set; } = null!;

    public string FileName { get; set; } = null!;

    public string MimeType { get; set; } = null!;

    public long FileSize { get; set; }

    public string FileUrl { get; set; } = null!;

    /// <summary>音频时长（秒），上传后由后端解析填入</summary>
    public double? Duration { get; set; }

    /// <summary>ASR 转写结果，带时间轴的分段列表</summary>
    public List<TranscriptSegment>? Segments { get; set; }

    /// <summary>转写状态: pending / processing / completed / failed</summary>
    public string TranscribeStatus { get; set; } = "pending";

    public string? TranscribeError { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public class TranscriptSegment
{
    /// <summary>开始时间（秒）</summary>
    public double Start { get; set; }

    /// <summary>结束时间（秒）</summary>
    public double End { get; set; }

    /// <summary>转写文本</summary>
    public string Text { get; set; } = null!;
}
