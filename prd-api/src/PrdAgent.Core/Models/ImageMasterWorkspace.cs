namespace PrdAgent.Core.Models;

/// <summary>
/// 视觉创作 Workspace（用于“视觉创作 Agent”项目列表）。
/// - workspaceId 是该业务域稳定主键，用于替代易漂移的 sessionId。
/// - 支持最小共享：owner 或 member 可访问。
/// </summary>
public class ImageMasterWorkspace
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>创建者（OWNER，ADMIN userId）</summary>
    public string OwnerUserId { get; set; } = string.Empty;

    public string Title { get; set; } = "未命名";

    /// <summary>共享成员（ADMIN userId 列表）</summary>
    public List<string> MemberUserIds { get; set; } = new();

    /// <summary>列表封面（可选）：引用 ImageAsset.Id</summary>
    public string? CoverAssetId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime? LastOpenedAt { get; set; }
}


