namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 产品实体（关系网的根）。
///
/// 产品 = 持续演进的交付物（区别于 pm-agent 的"临时性项目"）。
/// 一个产品挂一个"整体知识库"(KnowledgeStoreId)，下分多个版本(ProductVersion)，
/// 版本关联需求 / 功能，需求连客户、被缺陷追溯，所有关系可串成知识图谱。
/// </summary>
public class Product
{
    /// <summary>主键（Guid）</summary>
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>产品编号（层级前缀 + 全局序号，如 SYS-1007157；调层级只改前缀）</summary>
    public string ProductNo { get; set; } = string.Empty;

    /// <summary>产品名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>产品标识（短码，便于引用，可选）</summary>
    public string? Code { get; set; }

    /// <summary>产品描述 / 定位</summary>
    public string? Description { get; set; }

    /// <summary>产品分级，见 ProductGrade（核心 / 重要 / 普通 / 实验）</summary>
    public string Grade { get; set; } = ProductGrade.Normal;

    /// <summary>当前状态 Key（对应绑定 WorkflowDefinition 的某个 State）</summary>
    public string? CurrentState { get; set; }

    /// <summary>绑定的表单模板 ID（决定 FormData 的字段集合）</summary>
    public string? TemplateId { get; set; }

    /// <summary>绑定的流程定义 ID（决定状态流转）</summary>
    public string? WorkflowDefId { get; set; }

    /// <summary>自定义表单填写值（key = ProductFormField.Key）</summary>
    public Dictionary<string, string> FormData { get; set; } = new();

    /// <summary>产品整体知识库绑定的 DocumentStore ID（首次进入知识库 tab 时 find-or-create）</summary>
    public string? KnowledgeStoreId { get; set; }

    /// <summary>产品负责人 UserId 列表（可为空，待认领；运行时 SSOT）</summary>
    public List<string> OwnerIds { get; set; } = new();

    /// <summary>首位负责人 UserId（与 OwnerIds 同步，兼容旧逻辑）</summary>
    public string OwnerId { get; set; } = string.Empty;

    /// <summary>负责人展示名（多人时用「、」拼接，与 OwnerIds 同步）</summary>
    public string? OwnerName { get; set; }

    /// <summary>是否为该产品负责人（含 OwnerIds 与遗留 OwnerId）。</summary>
    public bool IsProductOwner(string userId)
    {
        if (string.IsNullOrWhiteSpace(userId)) return false;
        if (OwnerIds.Contains(userId)) return true;
        return !string.IsNullOrWhiteSpace(OwnerId) && OwnerId == userId;
    }

    /// <summary>有效负责人 Id 列表（OwnerIds 优先，否则回退 OwnerId）。</summary>
    public IEnumerable<string> EnumerateOwnerIds()
    {
        var fromList = OwnerIds.Where(x => !string.IsNullOrWhiteSpace(x)).Distinct().ToList();
        if (fromList.Count > 0) return fromList;
        if (!string.IsNullOrWhiteSpace(OwnerId)) return new[] { OwnerId };
        return Array.Empty<string>();
    }

    /// <summary>产品成员 UserId 列表</summary>
    public List<string> MemberIds { get; set; } = new();

    /// <summary>产品管理员 UserId 列表（产品级分权：可增删本产品成员）。不变量：AdminIds ⊆ MemberIds。</summary>
    public List<string> AdminIds { get; set; } = new();

    // ── 反规范化计数（列表卡片展示用，写操作时维护）──
    public int VersionCount { get; set; }
    public int RequirementCount { get; set; }
    public int FeatureCount { get; set; }
    public int DefectCount { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>软删除标记</summary>
    public bool IsDeleted { get; set; }
}

/// <summary>产品分级常量</summary>
public static class ProductGrade
{
    /// <summary>核心产品</summary>
    public const string Core = "core";
    /// <summary>重要产品</summary>
    public const string Important = "important";
    /// <summary>普通产品（默认）</summary>
    public const string Normal = "normal";
    /// <summary>实验性产品</summary>
    public const string Experimental = "experimental";

    public static readonly string[] All = { Core, Important, Normal, Experimental };
}
