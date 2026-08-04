namespace PrdAgent.Core.Models;

/// <summary>
/// 需求评估八因子定义（价值评估规则模型 SSOT）。
/// 权重来源：产品研发管理规范 8 条影响因素 + 行业实践（WSJF / RICE / MoSCoW），
/// 2026-08-04 用户核定：成交助力 / 签约紧迫度 各 15，通用性 / 主线契合 各 12。
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

    /// <summary>打分锚点说明（1-5 分制，写进 LLM 提示词与报告）</summary>
    public string AnchorGuide { get; set; } = string.Empty;

    /// <summary>列映射建议关键词（表头包含任一关键词则建议映射到本因子）</summary>
    public string[] HeaderKeywords { get; set; } = Array.Empty<string>();
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

    /// <summary>证据缺失时的保守锚点分</summary>
    public const int ConservativeAnchor = 2;

    /// <summary>分档阈值</summary>
    public const double TierP0Threshold = 80;
    public const double TierP1Threshold = 65;
    public const double TierP2Threshold = 50;

    public static readonly List<RequirementFactorDefinition> All = new()
    {
        new RequirementFactorDefinition
        {
            Key = Universality, Name = "通用性", Weight = 12, RuleRef = 1,
            AnchorGuide = "5=全行业/全产品线通用；4=多数客户群通用；3=某类客户群通用；2=少数客户适用；1=单客户定制",
            HeaderKeywords = new[] { "通用", "适用范围", "行业" },
        },
        new RequirementFactorDefinition
        {
            Key = Frequency, Name = "使用频次", Weight = 12, RuleRef = 2,
            AnchorGuide = "5=核心日常操作（每日多次）；4=每日；3=每周；2=每月；1=极低频/一次性",
            HeaderKeywords = new[] { "频次", "频率", "使用次数" },
        },
        new RequirementFactorDefinition
        {
            Key = ImpactScope, Name = "影响范围", Weight = 12, RuleRef = 3,
            AnchorGuide = "5=影响全部用户/核心流程；4=影响多数用户；3=影响某模块用户；2=影响少数用户；1=边缘功能",
            HeaderKeywords = new[] { "影响范围", "影响面", "模块" },
        },
        new RequirementFactorDefinition
        {
            Key = CustomerVoice, Name = "客户反馈量", Weight = 12, RuleRef = 4,
            AnchorGuide = "按反馈客户数量与次数（客次）：5=≥10 客次；4=6-9 客次；3=3-5 客次；2=2 客次；1=1 客次",
            HeaderKeywords = new[] { "反馈", "客户数", "客次", "提出次数" },
        },
        new RequirementFactorDefinition
        {
            Key = RoadmapFit, Name = "产品主线契合度", Weight = 12, RuleRef = 5,
            AnchorGuide = "5=在当期产品主线规划上；4=在规划上但非当期；3=方向一致未入规划；2=关联较弱；1=偏离主线",
            HeaderKeywords = new[] { "规划", "主线", "路线", "roadmap" },
        },
        new RequirementFactorDefinition
        {
            Key = CustomerTier, Name = "提出客户重要度", Weight = 10, RuleRef = 6,
            AnchorGuide = "5=KA/战略客户；4=大型付费客户；3=中型付费客户；2=小型付费客户；1=普通/免费客户",
            HeaderKeywords = new[] { "客户名称", "客户等级", "KA", "客户类型", "提出客户" },
        },
        new RequirementFactorDefinition
        {
            Key = DealLeverage, Name = "成交助力", Weight = 15, RuleRef = 7,
            AnchorGuide = "5=明确阻塞在谈订单（不做丢单）；4=对在谈订单有直接助推；3=对成交有一般助推；2=间接相关；1=与成交无关",
            HeaderKeywords = new[] { "成交", "订单", "商机", "签单" },
        },
        new RequirementFactorDefinition
        {
            Key = ContractUrgency, Name = "签约紧迫度", Weight = 15, RuleRef = 8,
            AnchorGuide = "5=已签约且承诺期限 ≤30 天；4=已签约且 ≤90 天；3=已签约无明确期限；2=签约意向中；1=无签约",
            HeaderKeywords = new[] { "签约", "协议", "合同", "交付时间", "承诺" },
        },
    };

    /// <summary>按 key 取因子定义，不存在返回 null</summary>
    public static RequirementFactorDefinition? Find(string key)
        => All.FirstOrDefault(f => string.Equals(f.Key, key, StringComparison.Ordinal));

    /// <summary>生成权重快照（存入 Run，保证历史报告可复算）</summary>
    public static List<RequirementFactorWeightSnapshot> BuildWeightsSnapshot()
        => All.Select(f => new RequirementFactorWeightSnapshot { Key = f.Key, Name = f.Name, Weight = f.Weight }).ToList();
}
