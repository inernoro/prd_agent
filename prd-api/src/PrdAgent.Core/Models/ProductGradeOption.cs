namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 通用等级目录（可增删改查），承载 需求/功能/缺陷 的「优先级」与「严重程度」配置项。
/// 维度 Dimension：priority（优先级）/ severity（严重程度）；对象 EntityType：requirement / feature / defect。
/// 内置项可改名/改色/改定义但不可删除（与 RequirementType 内置项规则一致）。
/// </summary>
public class ProductGradeOption
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>维度：priority（优先级）/ severity（严重程度）</summary>
    public string Dimension { get; set; } = string.Empty;

    /// <summary>对象类型：requirement / feature / defect</summary>
    public string EntityType { get; set; } = string.Empty;

    /// <summary>等级名称（如「P0 紧急」「致命」）</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>展示色值（hex）</summary>
    public string Color { get; set; } = "#60A5FA";

    /// <summary>等级定义（供 AI 识别 / 说明参考，可空）</summary>
    public string Definition { get; set; } = string.Empty;

    public int SortOrder { get; set; }

    public bool IsBuiltin { get; set; }

    public string? OwnerId { get; set; }

    public bool IsDeleted { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public const string DimensionPriority = "priority";
    public const string DimensionSeverity = "severity";

    public static readonly string[] Dimensions = { DimensionPriority, DimensionSeverity };
    public static readonly string[] EntityTypes = { "requirement", "feature", "defect" };

    /// <summary>
    /// 内置默认项：priority 维度（P0-P3）与 severity 维度（致命/严重/一般/轻微），
    /// 三类 entityType（requirement / feature / defect）各一套。Id 形如 grade_priority_requirement_p0。
    /// </summary>
    public static IEnumerable<ProductGradeOption> BuildBuiltinSeeds(string dimension, string entityType)
    {
        var sets = dimension == DimensionSeverity
            ? new[]
            {
                ("致命", "#EF4444", "导致系统崩溃、数据丢失或核心流程完全不可用，必须立即处理。"),
                ("严重", "#F97316", "主要功能受阻或大范围影响，无合理绕行方案，需尽快处理。"),
                ("一般", "#EAB308", "局部功能异常或体验受损，有绕行方案，可正常排期。"),
                ("轻微", "#22C55E", "细节瑕疵、文案或边缘场景问题，影响极小。"),
            }
            : new[]
            {
                ("P0 紧急", "#EF4444", "最高优先级，需立即投入资源处理，阻塞其他工作。"),
                ("P1 高", "#F97316", "高优先级，应在当前迭代内优先安排。"),
                ("P2 中", "#EAB308", "中等优先级，按常规排期推进。"),
                ("P3 低", "#22C55E", "低优先级，资源富余或后续迭代再处理。"),
            };

        var order = 0;
        var prefix = dimension == DimensionSeverity
            ? new[] { "fatal", "serious", "normal", "minor" }
            : new[] { "p0", "p1", "p2", "p3" };
        foreach (var (name, color, definition) in sets)
        {
            yield return new ProductGradeOption
            {
                Id = $"grade_{dimension}_{entityType}_{prefix[order]}",
                Dimension = dimension,
                EntityType = entityType,
                Name = name,
                Color = color,
                Definition = definition,
                SortOrder = order,
                IsBuiltin = true,
            };
            order++;
        }
    }
}
