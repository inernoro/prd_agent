namespace PrdAgent.Core.Models;

/// <summary>独立的托管文档阅读目录。成员关系不改变文档权限，同一文档可在多个合集中。</summary>
public class HostedDocumentCollection
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string OwnerUserId { get; set; } = "";
    public string OwnerName { get; set; } = "";
    public string Name { get; set; } = "";
    public string Description { get; set; } = "";
    public List<string> SiteIds { get; set; } = new();
    public string MainSiteId { get; set; } = "";
    public List<HostedCollectionSection> Sections { get; set; } = new();
    public Dictionary<string, HostedCollectionMemberMetadata> MemberMetadata { get; set; } = new();
    public long Version { get; set; } = 1;
    public int ShareGeneration { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? DissolvedAt { get; set; }
}

public class HostedCollectionMemberMetadata
{
    public string Title { get; set; } = "";
    public string Author { get; set; } = "";
    public string Type { get; set; } = "文档";
    public DateTime UpdatedAt { get; set; }
}

public class HostedCollectionSection
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = "";
    public List<string> SiteIds { get; set; } = new();
}

public class HostedCollectionSnapshot
{
    public List<string> AccessUserIds { get; set; } = new();
    public string CollectionId { get; set; } = "";
    public int ShareGeneration { get; set; }
    public long Version { get; set; }
    public string Name { get; set; } = "";
    public string OwnerName { get; set; } = "";
    public string Description { get; set; } = "";
    public string MainSiteId { get; set; } = "";
    public List<string> SiteIds { get; set; } = new();
    public List<HostedCollectionSection> Sections { get; set; } = new();
    public Dictionary<string, HostedCollectionMemberMetadata> MemberMetadata { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public static class HostedCollectionPolicy
{
    public static bool AudienceAllows(HostedCollectionSnapshot snapshot, string? userId, string creatorId)
        => snapshot.AccessUserIds.Count == 0 || userId != null && (userId == creatorId || snapshot.AccessUserIds.Contains(userId));
    public static void Validate(HostedDocumentCollection collection)
    {
        if (string.IsNullOrWhiteSpace(collection.Name)) throw new InvalidOperationException("请填写合集名称");
        if (collection.SiteIds.Count is < 1 or > 90) throw new InvalidOperationException("请选择1–90份文档");
        if (collection.SiteIds.Distinct().Count() != collection.SiteIds.Count) throw new InvalidOperationException("成员不能重复");
        if (!collection.SiteIds.Contains(collection.MainSiteId)) throw new InvalidOperationException("请选择成员中的一份作为主文档");
        if (collection.Sections.Any(s => string.IsNullOrWhiteSpace(s.Id) || string.IsNullOrWhiteSpace(s.Title))
            || collection.Sections.Select(s => s.Id).Distinct().Count() != collection.Sections.Count)
            throw new InvalidOperationException("章节名称必填，章节标识必须唯一");
        var sectionIds = collection.Sections.SelectMany(s => s.SiteIds).ToList();
        if (sectionIds.Any(id => !collection.SiteIds.Contains(id) || id == collection.MainSiteId)
            || sectionIds.Distinct().Count() != sectionIds.Count)
            throw new InvalidOperationException("章节成员不能重复，主文档始终独立置顶");
        collection.SiteIds = new[] { collection.MainSiteId }.Concat(collection.SiteIds.Where(id => id != collection.MainSiteId)).ToList();
        foreach (var section in collection.Sections)
            section.SiteIds = collection.SiteIds.Where(section.SiteIds.Contains).ToList();
    }

    public static void RestrictVisibleMembers(HostedDocumentCollection collection, IReadOnlySet<string> visibleIds)
    {
        collection.SiteIds = collection.SiteIds.Where(visibleIds.Contains).ToList();
        collection.MemberMetadata = collection.MemberMetadata.Where(pair => visibleIds.Contains(pair.Key)).ToDictionary(pair => pair.Key, pair => pair.Value);
        collection.Sections = collection.Sections.Select(s => new HostedCollectionSection { Id = s.Id, Title = s.Title,
            SiteIds = s.SiteIds.Where(visibleIds.Contains).ToList() }).Where(s => s.SiteIds.Count > 0).ToList();
    }

    public static HostedCollectionSnapshot Snapshot(HostedDocumentCollection collection, List<string> selected)
    {
        if (selected.Count == 0 || selected.Distinct().Count() != selected.Count || selected.Any(id => !collection.SiteIds.Contains(id)))
            throw new InvalidOperationException("分享范围必须来自当前合集成员");
        var ids = collection.SiteIds.Where(selected.Contains).ToList();
        return new() { CollectionId = collection.Id, Version = collection.Version, ShareGeneration = collection.ShareGeneration, Name = collection.Name, OwnerName = collection.OwnerName,
            Description = collection.Description, MainSiteId = ids.Contains(collection.MainSiteId) ? collection.MainSiteId : ids[0],
            SiteIds = ids, MemberMetadata = collection.MemberMetadata.Where(pair => ids.Contains(pair.Key)).ToDictionary(pair => pair.Key, pair => new HostedCollectionMemberMetadata {
                Title = pair.Value.Title, Author = pair.Value.Author, Type = pair.Value.Type, UpdatedAt = pair.Value.UpdatedAt
            }), Sections = collection.Sections.Select(s => new HostedCollectionSection {
                Id = s.Id, Title = s.Title, SiteIds = s.SiteIds.Where(id => ids.Contains(id) && id != (ids.Contains(collection.MainSiteId) ? collection.MainSiteId : ids[0])).ToList()
            }).Where(s => s.SiteIds.Count > 0).ToList() };
    }
}
