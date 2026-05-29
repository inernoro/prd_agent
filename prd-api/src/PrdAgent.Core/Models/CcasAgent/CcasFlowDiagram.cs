using PrdAgent.Core.Attributes;

namespace PrdAgent.Core.Models.CcasAgent;

/// <summary>
/// 赋码采集关联系统智能体 — 流程示意图持久化记录。
/// 节点 + 边的结构化 JSON，配合前端 ReactFlow 渲染。
/// </summary>
[AppOwnership(AppNames.CcasAgent, AppNames.CcasAgentDisplay, IsPrimary = true)]
public class CcasFlowDiagram
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>方案标题（如"瓶箱垛采集关联整体流程"）</summary>
    public string Title { get; set; } = string.Empty;

    /// <summary>用户原始输入：流程描述 + 设备列表 + 关联模式</summary>
    public string OriginalInput { get; set; } = string.Empty;

    /// <summary>关联模式（瓶箱垛 / 瓶盒箱垛 / 箱垛 / 自定义）</summary>
    public string? AssociationMode { get; set; }

    /// <summary>节点列表（JSON 字符串：[{ id, label, equipmentType, assetUrl, x, y, width, height }]）</summary>
    public string NodesJson { get; set; } = "[]";

    /// <summary>边列表（JSON 字符串：[{ id, source, target, label }]）</summary>
    public string EdgesJson { get; set; } = "[]";

    /// <summary>区段/分组列表（JSON：[{ id, label, x, y, width, height, color }]，用于绘制墙体/车间分区）</summary>
    public string GroupsJson { get; set; } = "[]";

    /// <summary>LLM 解析使用的模型（AI 模型可见性）</summary>
    public string? Model { get; set; }
    public string? PlatformName { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
