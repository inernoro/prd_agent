using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 会话实体
/// </summary>
public class Session
{
    /// <summary>会话唯一标识</summary>
    [BsonId]
    [BsonRepresentation(BsonType.String)]
    public string SessionId { get; set; } = Guid.NewGuid().ToString();
    
    /// <summary>关联的群组ID（可为空表示个人会话）</summary>
    public string? GroupId { get; set; }
    
    /// <summary>关联的文档ID</summary>
    public string DocumentId { get; set; } = string.Empty;
    
    /// <summary>当前角色视角</summary>
    public UserRole CurrentRole { get; set; } = UserRole.PM;
    
    /// <summary>交互模式</summary>
    public InteractionMode Mode { get; set; } = InteractionMode.QA;
    
    /// <summary>引导模式当前步骤</summary>
    public int? GuideStep { get; set; }
    
    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    
    /// <summary>最后活跃时间</summary>
    public DateTime LastActiveAt { get; set; } = DateTime.UtcNow;
}



