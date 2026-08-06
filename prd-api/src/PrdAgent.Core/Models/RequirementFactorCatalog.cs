namespace PrdAgent.Core.Models;

/// <summary>
/// 需求评估八因子定义（价值评估规则模型 SSOT）。
/// 权重来源：产品研发管理规范 8 条影响因素 + 行业实践（WSJF / RICE / MoSCoW），
/// 2026-08-04 用户核定：成交助力 / 签约紧迫度 各 15，通用性 / 主线契合 各 12。
/// 2026-08-06 用户核定：锚点改 0-10 分制；前五因子（通用性/频次/影响范围/客户反馈量/主线契合）
/// 以产品经理评论为最高优先级证据，后三因子（客户重要度/成交助力/签约紧迫度）以需求详情为准。
/// 修改权重必须同步 RequirementScoringEngine 相关测试与本注释。
/// </summary>
public class RequirementFactorDefinition
{
    public string Key { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    /// <summary>权重（全部因子合计必须 = 100）</summary>
    public int Weight { get; set; }

    /// <summary>对应产品研发管理规范的条款序号（1-8）</summary>
    public int RuleRef { get; set; }

    /// <summary>打分锚点说明（0-10 分制，写进 LLM 提示词与报告）</summary>
    public string AnchorGuide { get; set; } = string.Empty;

    /// <summary>列映射建议关键词（表头包含任一关键词则建议映射到本因子）</summary>
    public string[] HeaderKeywords { get; set; } = Array.Empty<string>();
}

/// <summary>合理性判定（评论驱动的独立判定，不占评分权重）</summary>
public static class RequirementReasonableness
{
    public const string Reasonable = "合理";
    public const string Unreasonable = "不合理";
}

public static class RequirementFactorCatalog
{
    public const string Universality = "universality";
    public const string Frequency = "frequency";
    public const string ImpactScope = "impactScope";
    public const string CustomerVoice = "customerVoice";
    public const string RoadmapFit = "roadmapFit";
    public const string CustomerTier = "customerTier";
    public const string DealLeverage = "dealLeverage";
    public const string ContractUrgency = "contractUrgency";

    /// <summary>锚点分制区间（0-10）</summary>
    public const int AnchorMin = 0;
    public const int AnchorMax = 10;

    /// <summary>证据缺失时的保守锚点分</summary>
    public const int ConservativeAnchor = 4;

    /// <summary>签约强制置顶的锚点下限（已签约且承诺期限 ≤30 天）</summary>
    public const int ContractOverrideAnchorMin = 9;

    /// <summary>分档阈值</summary>
    public const double TierP0Threshold = 80;
    public const double TierP1Threshold = 65;
    public const double TierP2Threshold = 50;

    /// <summary>前五因子：产品经理评论为最高优先级证据（后三因子以需求详情为准）</summary>
    public static readonly string[] CommentDrivenFactorKeys =
        { Universality, Frequency, ImpactScope, CustomerVoice, RoadmapFit };

    public static readonly List<RequirementFactorDefinition> All = new()
    {
        new RequirementFactorDefinition
        {
            Key = Universality, Name = "通用性", Weight = 12, RuleRef = 1,
            AnchorGuide = "9-10=全行业/全产品线通用；7-8=多数客户群通用；5-6=某类客户群通用；3-4=少数客户适用；0-2=单客户定制",
            HeaderKeywords = new[] { "通用", "适用范围", "行业" },
        },
        new RequirementFactorDefinition
        {
            Key = Frequency, Name = "使用频次", Weight = 12, RuleRef = 2,
            AnchorGuide = "9-10=核心日常操作（每日多次）；7-8=每日；5-6=每周；3-4=每月；0-2=极低频/一次性",
            HeaderKeywords = new[] { "频次", "频率", "使用次数" },
        },
        new RequirementFactorDefinition
        {
            Key = ImpactScope, Name = "影响范围", Weight = 12, RuleRef = 3,
            AnchorGuide = "9-10=影响全部用户/核心流程；7-8=影响多数用户；5-6=影响某模块用户；3-4=影响少数用户；0-2=边缘功能",
            HeaderKeywords = new[] { "影响范围", "影响面", "模块" },
        },
        new RequirementFactorDefinition
        {
            Key = CustomerVoice, Name = "客户反馈量", Weight = 12, RuleRef = 4,
            AnchorGuide = "按反馈客户数量与次数（客次）：9-10=≥10 客次；7-8=6-9 客次；5-6=3-5 客次；3-4=2 客次；0-2=1 客次",
            HeaderKeywords = new[] { "反馈", "客户数", "客次", "提出次数" },
        },
        new RequirementFactorDefinition
        {
            Key = RoadmapFit, Name = "产品主线契合度", Weight = 12, RuleRef = 5,
            AnchorGuide = "9-10=在当期产品主线规划上；7-8=在规划上但非当期；5-6=方向一致未入规划；3-4=关联较弱；0-2=偏离主线",
            HeaderKeywords = new[] { "规划", "主线", "路线", "roadmap" },
        },
        new RequirementFactorDefinition
        {
            Key = CustomerTier, Name = "提出客户重要度", Weight = 10, RuleRef = 6,
            AnchorGuide = "9-10=KA/战略客户；7-8=大型付费客户；5-6=中型付费客户；3-4=小型付费客户；0-2=普通/免费客户",
            HeaderKeywords = new[] { "客户名称", "客户等级", "KA", "客户类型", "提出客户" },
        },
        new RequirementFactorDefinition
        {
            Key = DealLeverage, Name = "成交助力", Weight = 15, RuleRef = 7,
            AnchorGuide = "9-10=明确阻塞在谈订单（不做丢单）；7-8=对在谈订单有直接助推；5-6=对成交有一般助推；3-4=间接相关；0-2=与成交无关",
            HeaderKeywords = new[] { "成交", "订单", "商机", "签单" },
        },
        new RequirementFactorDefinition
        {
            Key = ContractUrgency, Name = "签约紧迫度", Weight = 15, RuleRef = 8,
            AnchorGuide = "9-10=已签约且承诺期限 ≤30 天；7-8=已签约且 ≤90 天；5-6=已签约无明确期限；3-4=签约意向中；0-2=无签约",
            HeaderKeywords = new[] { "签约", "协议", "合同", "交付时间", "承诺" },
        },
    };

    /// <summary>按 key 取因子定义，不存在返回 null</summary>
    public static RequirementFactorDefinition? Find(string key)
        => All.FirstOrDefault(f => string.Equals(f.Key, key, StringComparison.Ordinal));

    /// <summary>该因子是否以产品经理评论为最高优先级证据（前五因子）</summary>
    public static bool IsCommentDriven(string key)
        => CommentDrivenFactorKeys.Contains(key, StringComparer.Ordinal);

    /// <summary>生成权重快照（存入 Run，保证历史报告可复算）</summary>
    public static List<RequirementFactorWeightSnapshot> BuildWeightsSnapshot()
        => All.Select(f => new RequirementFactorWeightSnapshot { Key = f.Key, Name = f.Name, Weight = f.Weight }).ToList();
}
