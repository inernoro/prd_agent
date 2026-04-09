namespace PrdAgent.Core.Models;

/// <summary>
/// 知识库点赞记录（一个用户对同一个知识库最多一条）
/// </summary>
public class DocumentStoreLike
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的知识库 ID</summary>
    public string StoreId { get; set; } = string.Empty;

    /// <summary>点赞用户 UserId</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>点赞用户显示名快照</summary>
    public string UserName { get; set; } = string.Empty;

    /// <summary>点赞用户头像文件名快照</summary>
    public string? AvatarFileName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 知识库收藏记录（一个用户对同一个知识库最多一条）
/// </summary>
public class DocumentStoreFavorite
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string StoreId { get; set; } = string.Empty;
    public string UserId { get; set; } = string.Empty;
    public string UserName { get; set; } = string.Empty;
    public string? AvatarFileName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
