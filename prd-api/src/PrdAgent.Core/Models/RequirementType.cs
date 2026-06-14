namespace PrdAgent.Core.Models;

/// <summary>
/// 产品管理智能体 — 需求类型（可增删改查，供新建需求选择与 AI 分类识别）。
/// 值写入 Requirement.FormData["需求类型"]，存类型名称（Name）。
/// </summary>
public class RequirementType
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>类型名称（如「新增功能」），表单与 AI 输出均使用该文案</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>类型定义（供 AI 识别时参考的判断说明）</summary>
    public string Definition { get; set; } = string.Empty;

    public int SortOrder { get; set; }

    public bool IsBuiltin { get; set; }

    public bool IsDeleted { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public const string FormDataKey = "需求类型";

    public static readonly RequirementType[] BuiltinSeeds =
    {
        new()
        {
            Id = "reqtype_new_feature",
            Name = "新增功能",
            Definition = "此前产品不具备的全新能力或模块，需要从零规划与开发；文本强调「新增」「新功能」「从无到有」。",
            SortOrder = 0,
            IsBuiltin = true,
        },
        new()
        {
            Id = "reqtype_feature_opt",
            Name = "功能优化",
            Definition = "在已有功能上增强、改逻辑、补规则或扩展边界；非全新模块，强调「优化」「改进」「增强」「调整规则」。",
            SortOrder = 1,
            IsBuiltin = true,
        },
        new()
        {
            Id = "reqtype_perf_opt",
            Name = "性能优化",
            Definition = "主要目标是提升响应速度、吞吐量、资源占用或稳定性；功能外观可能不变，强调「慢」「卡顿」「超时」「并发」「性能」。",
            SortOrder = 2,
            IsBuiltin = true,
        },
        new()
        {
            Id = "reqtype_ux_opt",
            Name = "交互优化",
            Definition = "主要调整界面布局、操作流程、文案提示或易用性；业务规则基本不变，强调「体验」「交互」「UI」「操作步骤」「不好用」。",
            SortOrder = 3,
            IsBuiltin = true,
        },
        new()
        {
            Id = "reqtype_other",
            Name = "其他",
            Definition = "无法明确归入以上四类，或信息不足以判断时的兜底选项；混合型需求可选此项。",
            SortOrder = 4,
            IsBuiltin = true,
        },
    };
}
