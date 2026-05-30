namespace PrdAgent.Core.Models;

/// <summary>
/// 项目奖金配置（PMO 细则）— 单例文档（Id 固定 "default"）。
///
/// 奖金总额 = 奖金基数 × 项目价值系数 × (干系人满意度得分 / 100)；满意度 &lt; 60 直接归零。
/// 定向整改 / 专项督办项目无奖金。
/// </summary>
public class PmRewardConfig
{
    public string Id { get; set; } = "default";

    /// <summary>普通项目奖金基数（元，默认 0）</summary>
    public decimal GeneralBase { get; set; } = 0;

    /// <summary>战略级项目奖金基数（元）</summary>
    public decimal StrategicBase { get; set; } = 100000;

    /// <summary>创新级项目奖金基数（元）</summary>
    public decimal InnovationBase { get; set; } = 50000;

    /// <summary>常规运营级项目奖金基数（元）</summary>
    public decimal OperationRoutineBase { get; set; } = 30000;

    /// <summary>
    /// M.O.R.E 组织自评（0-100），仅作治理参考，不参与 NPSS 计算。
    /// M=清晰愿景 / O=结果导向治理 / R=快速迭代 / E=赋能团队。
    /// </summary>
    public int MoreVision { get; set; }
    public int MoreOutcome { get; set; }
    public int MoreRapid { get; set; }
    public int MoreEmpowered { get; set; }

    /// <summary>财年起始月份（1-12，默认 1 = 自然年）。用于财年维度 NPSS 盘点。</summary>
    public int FiscalYearStartMonth { get; set; } = 1;

    /// <summary>优秀项目奖金基数（元），叠加在常规项目奖金之上</summary>
    public decimal ExcellenceBonusBase { get; set; } = 0;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
