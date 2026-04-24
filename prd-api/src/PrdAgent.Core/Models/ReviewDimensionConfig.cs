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

    /// <summary>
    /// 子检查项（清单类维度使用，普通维度为 null）。
    /// 每项采用「是否涉及 / 方案是否包含」二段判断，得分 = MaxScore × 通过项数 / 总项数。
    /// </summary>
    public List<DimensionCheckItem>? Items { get; set; }

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
    public string? UpdatedBy { get; set; }
}

/// <summary>
/// 清单类维度的子检查项（管理员定义模板，LLM 按项判断）
/// </summary>
public class DimensionCheckItem
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>分类（如"安全与权限类"），用于 UI 分组</summary>
    public string Category { get; set; } = string.Empty;

    /// <summary>检查项名称（如"风控接入（黑名单）"）</summary>
    public string Text { get; set; } = string.Empty;

    /// <summary>管理员备注（写入提示词帮助 LLM 判断，如"该能力未全局开放：需邮件申请"）</summary>
    public string? Note { get; set; }
}

/// <summary>
/// 系统默认评审维度（数据库无配置时使用）
/// 总分 100，首项「全局规则检查清单」权重 30%，其余 7 项按比例下调合计 70 分。
/// </summary>
public static class DefaultReviewDimensions
{
    public static readonly List<ReviewDimensionConfig> All = new()
    {
        new ReviewDimensionConfig
        {
            Key = "global_rules_checklist",
            Name = "全局规则检查清单",
            MaxScore = 30,
            Description = "检查方案是否考虑到米多平台的硬性业务/技术规则。对每个检查项做二段判断：① 方案是否涉及该规则？② 若涉及，方案是否已明确写出对应设计？只有「涉及=是 且 覆盖=否」才算未通过，涉及=否直接视为通过。得分 = 30 × 通过项数 / 总项数（向下取整）。",
            OrderIndex = 1,
            Items = new List<DimensionCheckItem>
            {
                // 1、安全与权限类
                new() { Id = "rule_risk_control", Category = "安全与权限类", Text = "风控接入（黑名单）" },
                new() { Id = "rule_permission_control", Category = "安全与权限类", Text = "权限控制" },
                new() { Id = "rule_app_permission_config", Category = "安全与权限类", Text = "应用权限配置规则（新增子系统/应用：不默认开放、支持单独订购）" },
                new() { Id = "rule_operation_log", Category = "安全与权限类", Text = "操作日志写入" },
                new() { Id = "rule_mobile_auth", Category = "安全与权限类", Text = "用户授权（移动端）" },
                new() { Id = "rule_phone_verify", Category = "安全与权限类", Text = "手机号验证组件" },
                new() { Id = "rule_3plus2_sso", Category = "安全与权限类", Text = "3+2账号单点登录" },
                new() { Id = "rule_user_deregister", Category = "安全与权限类", Text = "用户注销" },
                new() { Id = "rule_user_agreement", Category = "安全与权限类", Text = "用户协议" },

                // 2、组件与框架类
                new() { Id = "rule_new_ui_framework", Category = "组件与框架类", Text = "新增子系统/应用：新UI框架顶部导航规范校验" },
                new() { Id = "rule_mobile_footer", Category = "组件与框架类", Text = "移动端底部「米多技术支持」+「投诉」组件" },

                // 3、业务功能类
                new() { Id = "rule_sms_fee", Category = "业务功能类", Text = "短信费（扣平台/扣商户）" },
                new() { Id = "rule_sms_signature", Category = "业务功能类", Text = "短信签名" },
                new() { Id = "rule_message_notify", Category = "业务功能类", Text = "消息通知" },
                new()
                {
                    Id = "rule_store_multi_dealer",
                    Category = "业务功能类",
                    Text = "门店一对多个上级经销商（需确认是否已开通）",
                    Note = "该能力未全局开放：需邮件申请，经技术为品牌商配置开通",
                },
                new()
                {
                    Id = "rule_store_multi_account",
                    Category = "业务功能类",
                    Text = "门店账号（一个手机支持注册多个门店）",
                    Note = "该能力未全局开放：默认一个手机号只能注册一个门店；若需一个手机支持注册多个门店，需邮件申请由技术处理",
                },

                // 4、系统边界与集成类
                new()
                {
                    Id = "rule_cross_system",
                    Category = "系统边界与集成类",
                    Text = "跨子系统/应用母体（能力依赖/数据互通/入口挂载）",
                },

                // 5、数据与存量类
                new()
                {
                    Id = "rule_legacy_data",
                    Category = "数据与存量类",
                    Text = "旧数据处理（含历史存量、迁移、兼容、清洗、字段/结构变更对存量的影响等）",
                    Note = "若涉及旧数据，方案是否包含须为「是」，且须体现与技术对齐后的处理范围、方式及关键风险/回滚等要点",
                },
            },
        },
        new ReviewDimensionConfig
        {
            Key = "template_compliance",
            Name = "文档规范完整性",
            MaxScore = 14,
            Description = "检查方案是否包含所有必要章节：文档头（文档名称、产品线/模块、版本、迭代类型、作者、审批人）、项目目的（3个核心要点）、现状背景与问题陈述（现状、问题、需求）、用户范围（核心用户角色及诉求）、实现思路（结构归母+具体设计思路）。每缺少一个主要章节扣3分，子项缺失酌情扣分。",
            OrderIndex = 2,
        },
        new ReviewDimensionConfig
        {
            Key = "consistency",
            Name = "内在自洽性",
            MaxScore = 14,
            Description = "评估整篇方案的逻辑闭环：项目目的→现状问题→用户诉求→实现思路是否形成完整链条；各章节描述是否互相支撑，有无矛盾；问题陈述的\"问题\"是否与\"需求\"对应；实现思路是否能解决所提出的问题。",
            OrderIndex = 3,
        },
        new ReviewDimensionConfig
        {
            Key = "problem_quality",
            Name = "问题陈述质量",
            MaxScore = 11,
            Description = "评估现状背景与问题陈述章节的质量：现状描述是否具体清晰（非泛泛而谈）；问题陈述是否指向根因（非表面症状）；需求描述是否明确可执行（用户期望达到的效果是否可验证）。",
            OrderIndex = 4,
        },
        new ReviewDimensionConfig
        {
            Key = "user_value",
            Name = "用户价值清晰度",
            MaxScore = 10,
            Description = "评估用户价值的阐述质量：项目目的中3个核心要点是否完整涵盖商业目标与客户价值；用户范围章节中核心用户角色是否明确列举；每个角色的核心诉求是否简明扼要且真实反映用户需要。",
            OrderIndex = 5,
        },
        new ReviewDimensionConfig
        {
            Key = "feasibility",
            Name = "实现思路可行性",
            MaxScore = 10,
            Description = "评估实现思路章节的质量：是否明确了'结构归母'（功能归属的产品模块/系统）；整体设计思路是否合理，分要点阐述是否具体；是否有明显的技术或业务风险盲点；方案是否在系统现有能力范围内可实现。",
            OrderIndex = 6,
        },
        new ReviewDimensionConfig
        {
            Key = "testability",
            Name = "需求可测试性",
            MaxScore = 7,
            Description = "评估需求是否可被验证和测试：需求描述是否有明确的完成标准；是否可以从需求推导出验收测试用例；描述中是否有可量化的指标或清晰的成功/失败判断条件。",
            OrderIndex = 7,
        },
        new ReviewDimensionConfig
        {
            Key = "expression",
            Name = "表达规范性",
            MaxScore = 4,
            Description = "评估文档表达和格式规范：语言是否简明扼要（无冗余废话）；格式是否符合模版规范（使用了正确的章节结构）；术语使用是否一致（同一概念在全文保持统一叫法）。",
            OrderIndex = 8,
        },
    };
}
