using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// 作品投稿记录（用户公开展示的作品）
/// - 视觉创作：投稿单张图片（引用 ImageAsset）
/// - 文学创作：投稿文章配图作品（引用 Workspace）
/// </summary>
[AppOwnership(AppNames.VisualAgent, AppNames.VisualAgentDisplay)]
[AppOwnership(AppNames.LiteraryAgent, AppNames.LiteraryAgentDisplay)]
public class Submission
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>作品标题</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>作品类型：visual / literary</summary>
    public string ContentType { get; set; } = string.Empty;

    /// <summary>封面图 URL（用于展示卡片）</summary>
    public string CoverUrl { get; set; } = string.Empty;

    /// <summary>封面图宽度（用于瀑布流布局计算）</summary>
    public int CoverWidth { get; set; }

    /// <summary>封面图高度（用于瀑布流布局计算）</summary>
    public int CoverHeight { get; set; }

    /// <summary>来源 Workspace ID</summary>
    public string? WorkspaceId { get; set; }

    /// <summary>来源 ImageAsset ID（视觉创作场景）</summary>
    public string? ImageAssetId { get; set; }

    /// <summary>生成提示词（可选展示）</summary>
    public string? Prompt { get; set; }

    /// <summary>作者用户 ID</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>作者显示名快照</summary>
    public string OwnerUserName { get; set; } = string.Empty;

    /// <summary>作者头像文件名快照</summary>
    public string? OwnerAvatarFileName { get; set; }

    /// <summary>点赞数（冗余计数，避免每次聚合查询）</summary>
    public int LikeCount { get; set; }

    /// <summary>是否公开（用户可随时关闭）</summary>
    public bool IsPublic { get; set; } = true;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 作品点赞记录（一个用户对同一作品最多一条）
/// </summary>
[AppOwnership(AppNames.System, AppNames.SystemDisplay)]
public class SubmissionLike
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>关联的投稿作品 ID</summary>
    public string SubmissionId { get; set; } = string.Empty;

    /// <summary>点赞用户 ID</summary>
    public string UserId { get; set; } = string.Empty;

    /// <summary>点赞用户显示名快照</summary>
    public string UserName { get; set; } = string.Empty;

    /// <summary>点赞用户头像文件名快照</summary>
    public string? AvatarFileName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
