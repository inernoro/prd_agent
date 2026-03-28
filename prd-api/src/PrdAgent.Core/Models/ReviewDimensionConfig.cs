namespace PrdAgent.Core.Models;

/// <summary>
/// 产品评审员 — 评审维度配置（管理员可自定义）
/// </summary>
public class ReviewDimensionConfig
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>维度唯一标识（如 completeness / consistency 等）</summary>
    public string Key { get; set; } = string.Empty;

    /// <summary>维度展示名称</summary>
    public string Name { get; set; } = string.Empty;

    /// <summary>满分值</summary>
    public int MaxScore { get; set; }

    /// <summary>评分要点说明（提示词中使用）</summary>
    public string Description { get; set; } = string.Empty;

    /// <summary>排列顺序</summary>
    public int OrderIndex { get; set; }

    /// <summary>是否启用</summary>
    public bool IsActive { get; set; } = true;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string? UpdatedBy { get; set; }
}

/// <summary>
/// 系统默认评审维度（数据库无配置时使用）
/// </summary>
public static class DefaultReviewDimensions
{
    public static readonly List<ReviewDimensionConfig> All = new()
    {
        new ReviewDimensionConfig
        {
            Key = "template_compliance",
            Name = "文档规范完整性",
            MaxScore = 20,
            Description = "检查方案是否包含所有必要章节：文档头（文档名称、产品线/模块、版本、迭代类型、作者、审批人）、项目目的（3个核心要点）、现状背景与问题陈述（现状、问题、需求）、用户范围（核心用户角色及诉求）、实现思路（结构归母+具体设计思路）。每缺少一个主要章节扣4分，子项缺失酌情扣分。",
            OrderIndex = 1,
        },
        new ReviewDimensionConfig
        {
            Key = "consistency",
            Name = "内在自洽性",
            MaxScore = 20,
            Description = "评估整篇方案的逻辑闭环：项目目的→现状问题→用户诉求→实现思路是否形成完整链条；各章节描述是否互相支撑，有无矛盾；问题陈述的"问题"是否与"需求"对应；实现思路是否能解决所提出的问题。",
            OrderIndex = 2,
        },
        new ReviewDimensionConfig
        {
            Key = "problem_quality",
            Name = "问题陈述质量",
            MaxScore = 15,
            Description = "评估现状背景与问题陈述章节的质量：现状描述是否具体清晰（非泛泛而谈）；问题陈述是否指向根因（非表面症状）；需求描述是否明确可执行（用户期望达到的效果是否可验证）。",
            OrderIndex = 3,
        },
        new ReviewDimensionConfig
        {
            Key = "user_value",
            Name = "用户价值清晰度",
            MaxScore = 15,
            Description = "评估用户价值的阐述质量：项目目的中3个核心要点是否完整涵盖商业目标与客户价值；用户范围章节中核心用户角色是否明确列举；每个角色的核心诉求是否简明扼要且真实反映用户需要。",
            OrderIndex = 4,
        },
        new ReviewDimensionConfig
        {
            Key = "feasibility",
            Name = "实现思路可行性",
            MaxScore = 15,
            Description = "评估实现思路章节的质量：是否明确了'结构归母'（功能归属的产品模块/系统）；整体设计思路是否合理，分要点阐述是否具体；是否有明显的技术或业务风险盲点；方案是否在系统现有能力范围内可实现。",
            OrderIndex = 5,
        },
        new ReviewDimensionConfig
        {
            Key = "testability",
            Name = "需求可测试性",
            MaxScore = 10,
            Description = "评估需求是否可被验证和测试：需求描述是否有明确的完成标准；是否可以从需求推导出验收测试用例；描述中是否有可量化的指标或清晰的成功/失败判断条件。",
            OrderIndex = 6,
        },
        new ReviewDimensionConfig
        {
            Key = "expression",
            Name = "表达规范性",
            MaxScore = 5,
            Description = "评估文档表达和格式规范：语言是否简明扼要（无冗余废话）；格式是否符合模版规范（使用了正确的章节结构）；术语使用是否一致（同一概念在全文保持统一叫法）。",
            OrderIndex = 7,
        },
    };
}
