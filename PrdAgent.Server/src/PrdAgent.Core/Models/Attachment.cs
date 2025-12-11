using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 附件实体
/// </summary>
public class Attachment
{
    /// <summary>附件唯一标识</summary>
    [BsonId]
    [BsonRepresentation(BsonType.String)]
    public string AttachmentId { get; set; } = Guid.NewGuid().ToString();
    
    /// <summary>关联的消息ID</summary>
    public string? MessageId { get; set; }
    
    /// <summary>上传者用户ID</summary>
    public string UploaderId { get; set; } = string.Empty;
    
    /// <summary>原始文件名</summary>
    public string FileName { get; set; } = string.Empty;
    
    /// <summary>MIME类型</summary>
    public string MimeType { get; set; } = string.Empty;
    
    /// <summary>文件大小（字节）</summary>
    public long Size { get; set; }
    
    /// <summary>文件访问URL</summary>
    public string Url { get; set; } = string.Empty;
    
    /// <summary>缩略图URL（仅图片）</summary>
    public string? ThumbnailUrl { get; set; }
    
    /// <summary>附件类型</summary>
    public AttachmentType Type { get; set; } = AttachmentType.Image;
    
    /// <summary>上传时间</summary>
    public DateTime UploadedAt { get; set; } = DateTime.UtcNow;
}



