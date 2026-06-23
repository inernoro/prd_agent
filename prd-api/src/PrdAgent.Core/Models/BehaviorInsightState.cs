namespace PrdAgent.Core.Models;

/// <summary>
/// 行为洞察处理状态（洞察生命周期）。洞察本身是聚合计算的瞬时产物，
/// 状态按指纹（kind|target）持久化：确认 / 已修复 / 忽略，可关联转出的缺陷。
/// </summary>
public class BehaviorInsightState
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>洞察指纹：{kind}|{target}</summary>
    public string Fingerprint { get; set; } = string.Empty;

    public string Kind { get; set; } = string.Empty;

    public string Target { get; set; } = string.Empty;

    /// <summary>处理状态：confirmed（确认待改）/ resolved（已修复）/ ignored（忽略不再提醒）</summary>
    public string Status { get; set; } = string.Empty;

    /// <summary>转为缺陷时记录缺陷 Id（一键转缺陷）</summary>
    public string? DefectId { get; set; }

    /// <summary>缺陷标题快照（列表展示用，避免跨集合查询）</summary>
    public string? DefectTitle { get; set; }

    /// <summary>转为产品需求时记录的需求 Id（VOC 痛点流转产品需求池）</summary>
    public string? RequirementId { get; set; }

    /// <summary>需求编号快照（列表展示「需求 #No」chip，避免跨集合查询）</summary>
    public string? RequirementNo { get; set; }

    /// <summary>标记为 resolved 那一刻的坏请求（报错 + 慢请求）数快照，作为复测回落对比基线</summary>
    public int? ResolvedBadCount { get; set; }

    /// <summary>标记为 resolved 的时间（复测回落对比起点）</summary>
    public DateTime? ResolvedAt { get; set; }

    public string UpdatedBy { get; set; } = string.Empty;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}
