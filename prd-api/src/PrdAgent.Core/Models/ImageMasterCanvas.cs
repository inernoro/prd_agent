using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models;

/// <summary>
/// ImageMaster 画布状态（用于"高级视觉创作"可持续编辑）。
/// - 仅保存可编辑结构化状态（坐标/尺寸/元素属性/扩展字段等），不保存大内容（图片内容走资产存储）。
/// - 通过 (ownerUserId, sessionId) 唯一索引保证 1 个会话对应 1 份画布。
/// </summary>
[AppOwnership(AppNames.VisualAgent, AppNames.VisualAgentDisplay, IsPrimary = true)]
public class ImageMasterCanvas
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string OwnerUserId { get; set; } = string.Empty; // ADMIN userId

    public string SessionId { get; set; } = string.Empty;

    public string WorkspaceId { get; set; } = string.Empty;

    public int SchemaVersion { get; set; } = 1;

    /// <summary>
    /// 画布 JSON（避免引入 Mongo 原生类型字段，保持兼容性与演进灵活）。
    /// </summary>
    public string PayloadJson { get; set; } = string.Empty;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}


