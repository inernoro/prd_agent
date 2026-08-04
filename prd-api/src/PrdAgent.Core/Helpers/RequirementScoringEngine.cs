using PrdAgent.Core.Models;

namespace PrdAgent.Core.Helpers;

/// <summary>
/// 需求评估计分引擎（纯函数）。
/// 职责边界：LLM 只产出「因子锚点分 + 证据」；加权总分、证据兜底、强制置顶、
/// 全局排序、分档全部由本引擎派生，保证结果可复算、可审计（compute-then-send 纪律）。
/// </summary>
public static class RequirementScoringEngine
{
    /// <summary>
    /// 规范化单条需求的因子分并计算总分：
    /// 1) 缺失因子补齐（按保守锚点）；2) 锚点越界钳制到 [1,5]；
    /// 3) 证据闸：HasEvidence=true 但证据文本为空 → 视为无证据；
    /// 4) 无证据因子锚点强制为保守值 2 并记录调整日志；
    /// 5) 加权得分 = 锚点 x 权重 / 5；总分 = Σ；证据齐全度 = 有证据因子占比。
    /// </summary>
    public static void NormalizeAndScore(RequirementAssessmentItem item)
    {
        var normalized = new List<RequirementFactorScore>();

        foreach (var def in RequirementFactorCatalog.All)
        {
            var fs = item.FactorScores.FirstOrDefault(f => string.Equals(f.Key, def.Key, StringComparison.Ordinal));
            if (fs == null)
            {
                fs = new RequirementFactorScore
                {
                    Key = def.Key,
                    Anchor = RequirementFactorCatalog.ConservativeAnchor,
                    HasEvidence = false,
                    Evidence = string.Empty,
                };
                item.AdjustmentLog.Add($"[{def.Name}] LLM 未返回该因子评分，按保守锚点 {RequirementFactorCatalog.ConservativeAnchor} 分计");
            }

            fs.Name = def.Name;
            fs.Weight = def.Weight;

            // 锚点越界钳制
            if (fs.Anchor < 1 || fs.Anchor > 5)
            {
                var clamped = Math.Clamp(fs.Anchor, 1, 5);
                item.AdjustmentLog.Add($"[{def.Name}] 锚点分 {fs.Anchor} 越界，钳制为 {clamped}");
                fs.OriginalAnchor = fs.Anchor;
                fs.Anchor = clamped;
            }

            // 证据闸：声称有证据但证据文本为空 → 视为无证据
            if (fs.HasEvidence && string.IsNullOrWhiteSpace(fs.Evidence))
            {
                fs.HasEvidence = false;
                item.AdjustmentLog.Add($"[{def.Name}] 声称有证据但未给出表格原文引用，按无证据处理");
            }

            // 无证据 → 保守锚点（不采信 LLM 凭空判断）
            if (!fs.HasEvidence && fs.Anchor != RequirementFactorCatalog.ConservativeAnchor)
            {
                fs.OriginalAnchor ??= fs.Anchor;
                item.AdjustmentLog.Add($"[{def.Name}] 表格中无证据，锚点 {fs.Anchor} 调整为保守值 {RequirementFactorCatalog.ConservativeAnchor}，建议补充该维度信息");
                fs.Anchor = RequirementFactorCatalog.ConservativeAnchor;
            }

            if (!fs.HasEvidence && !item.MissingInfo.Contains(def.Name))
                item.MissingInfo.Add(def.Name);

            fs.WeightedScore = Math.Round(fs.Anchor * fs.Weight / 5.0, 1);
            normalized.Add(fs);
        }

        item.FactorScores = normalized;
        item.TotalScore = Math.Round(normalized.Sum(f => f.WeightedScore), 1);

        var withEvidence = normalized.Count(f => f.HasEvidence);
        item.ConfidencePercent = (int)Math.Round(withEvidence * 100.0 / normalized.Count);

        // 强制置顶判定：签约紧迫度锚点 5（已签约且 ≤30 天）且有真实证据
        var contract = normalized.First(f => f.Key == RequirementFactorCatalog.ContractUrgency);
        item.IsContractualOverride = contract.Anchor == 5 && contract.HasEvidence;
    }

    /// <summary>
    /// 全局排序并写回 Priority / Tier：
    /// 1) 签约强制置顶组排在所有普通需求之前（组内仍按总分排）；
    /// 2) 同分决胜链：签约紧迫 → 客户反馈量 → 主线契合 → 成交助力 → 通用性 → 原始行号；
    /// 3) 分档：置顶或 ≥80 = P0；≥65 = P1；≥50 = P2；其余 P3。
    /// </summary>
    public static void RankAndTier(List<RequirementAssessmentItem> items)
    {
        var sorted = items.OrderByDescending(x => x.IsContractualOverride)
            .ThenByDescending(x => x.TotalScore)
            .ThenByDescending(x => AnchorOf(x, RequirementFactorCatalog.ContractUrgency))
            .ThenByDescending(x => AnchorOf(x, RequirementFactorCatalog.CustomerVoice))
            .ThenByDescending(x => AnchorOf(x, RequirementFactorCatalog.RoadmapFit))
            .ThenByDescending(x => AnchorOf(x, RequirementFactorCatalog.DealLeverage))
            .ThenByDescending(x => AnchorOf(x, RequirementFactorCatalog.Universality))
            .ThenBy(x => x.RowIndex)
            .ToList();

        for (int i = 0; i < sorted.Count; i++)
        {
            sorted[i].Priority = i + 1;
            sorted[i].Tier = TierOf(sorted[i]);
        }
    }

    private static int AnchorOf(RequirementAssessmentItem item, string factorKey)
        => item.FactorScores.FirstOrDefault(f => f.Key == factorKey)?.Anchor ?? 0;

    private static string TierOf(RequirementAssessmentItem item)
    {
        if (item.IsContractualOverride || item.TotalScore >= RequirementFactorCatalog.TierP0Threshold) return "P0";
        if (item.TotalScore >= RequirementFactorCatalog.TierP1Threshold) return "P1";
        if (item.TotalScore >= RequirementFactorCatalog.TierP2Threshold) return "P2";
        return "P3";
    }
}
