namespace PrdAgent.Core.Models;

/// <summary>
/// 涌现节点 — 涌现树上的每一个探索点。
///
/// 反向自洽原则：
/// - 每个节点必须有"根"（GroundingContent），没有根的节点是幻觉
/// - 一维节点：根 = 系统内已有能力的代码/文档证据
/// - 二维节点：根 = 多个已知节点 + 可控假设条件（BridgeAssumptions）
/// - 三维节点：根 = 多个已知节点 + 幻想桥梁 + 标注的未知数
/// - 任何节点都要能顺着 ParentIds → GroundingContent 回溯到文档来源
/// </summary>
public class EmergenceNode
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>所属涌现树</summary>
    public string TreeId { get; set; } = string.Empty;

    /// <summary>直接父节点（探索时单父节点）</summary>
    public string? ParentId { get; set; }

    /// <summary>涌现时可有多个父节点（组合来源）</summary>
    public List<string> ParentIds { get; set; } = new();

    // ── 节点内容 ──

    public string Title { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;

    /// <summary>AI 生成的技术方案/实现思路</summary>
    public string? TechPlan { get; set; }

    // ── 反向自洽锚定 ──

    /// <summary>节点的现实锚点 — 支撑此节点存在的文档/代码/能力证据</summary>
    public string GroundingContent { get; set; } = string.Empty;

    /// <summary>锚点来源类型：code / document / api / capability / user_input</summary>
    public string GroundingType { get; set; } = EmergenceGroundingType.Capability;

    /// <summary>锚点来源引用（文件路径/文档 ID/API 路由）</summary>
    public string? GroundingRef { get; set; }

    /// <summary>
    /// 桥梁假设条件 — 二维/三维节点的可控未知数。
    /// 例如："假设已有 embedding 服务"、"假设用户量 > 1000"。
    /// 一维节点此字段为空（无需假设，直接基于现实）。
    /// </summary>
    public List<string> BridgeAssumptions { get; set; } = new();

    /// <summary>
    /// 缺失能力清单 — 实现此功能需要但系统目前不具备的能力。
    /// 每条包含缺什么 + 建议的借用方式。
    /// 空列表 = 完全基于已有能力可实现。
    /// </summary>
    public List<string> MissingCapabilities { get; set; } = new();

    // ── 维度与类型 ──

    /// <summary>维度：1=系统内（蓝）, 2=跨系统（紫）, 3=幻想（金）</summary>
    public int Dimension { get; set; } = 1;

    /// <summary>节点类型：seed / capability / combination / fantasy</summary>
    public string NodeType { get; set; } = EmergenceNodeType.Capability;

    // ── 评估与状态 ──

    /// <summary>价值评分 1-5</summary>
    public int ValueScore { get; set; }

    /// <summary>难度评分 1-5</summary>
    public int DifficultyScore { get; set; }

    /// <summary>状态：idea / planned / building / done</summary>
    public string Status { get; set; } = EmergenceNodeStatus.Idea;

    // ── 可视化 ──

    public double PositionX { get; set; }
    public double PositionY { get; set; }

    public List<string> Tags { get; set; } = new();
    public Dictionary<string, string> Metadata { get; set; } = new();

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>节点类型常量</summary>
public static class EmergenceNodeType
{
    public const string Seed = "seed";
    public const string Capability = "capability";
    public const string Combination = "combination";
    public const string Fantasy = "fantasy";
}

/// <summary>节点状态常量</summary>
public static class EmergenceNodeStatus
{
    public const string Idea = "idea";
    public const string Planned = "planned";
    public const string Building = "building";
    public const string Done = "done";
}

/// <summary>锚点来源类型常量</summary>
public static class EmergenceGroundingType
{
    public const string Code = "code";
    public const string Document = "document";
    public const string Api = "api";
    public const string Capability = "capability";
    public const string UserInput = "user_input";
}
