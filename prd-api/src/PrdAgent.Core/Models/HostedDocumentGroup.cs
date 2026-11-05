using MongoDB.Bson.Serialization.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>阅读导航关系，不授予任何成员文档的访问权限。</summary>
[BsonIgnoreExtraElements]
public class HostedDocumentGroup
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string OwnerUserId { get; set; } = string.Empty;
    public List<string> SiteIds { get; set; } = new();
    public string MainSiteId { get; set; } = string.Empty;
    public long Version { get; set; } = 1;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
