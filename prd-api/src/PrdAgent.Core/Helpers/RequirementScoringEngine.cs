using PrdAgent.Core.Models;

namespace PrdAgent.Core.Helpers;

/// <summary>
/// 需求评估计分引擎（纯函数）。
/// 职责边界：LLM 只产出「因子锚点分 + 证据 + 合理性判定」；加权总分、证据兜底、强制置顶、
/// 不合理降档、全局排序、分档全部由本引擎派生，保证结果可复算、可审计（compute-then-send 纪律）。
/// </summary>
public static class RequirementScoringEngine
{
    /// <summary>
    /// 规范化单条需求的因子分并计算总分：
    /// 1) 缺失因子补齐（按保守锚点）；2) 锚点越界钳制到 [0,10]；
    /// 3) 证据闸：HasEvidence=true 但证据文本为空 → 视为无证据；
    /// 4) 无证据因子锚点强制为保守值并记录调整日志；
    /// 5) 加权得分 = 锚点 x 权重 / 10；总分 = Σ；证据齐全度 = 有证据因子占比；
    /// 6) 合理性闸：评论判定「不合理」但无评论原文依据 → 判定作废；
    /// 7) 签约强制置顶：签约紧迫度 ≥9 且有证据，且未被评论判定不合理。
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
            if (fs.Anchor < RequirementFactorCatalog.AnchorMin || fs.Anchor > RequirementFactorCatalog.AnchorMax)
            {
                var clamped = Math.Clamp(fs.Anchor, RequirementFactorCatalog.AnchorMin, RequirementFactorCatalog.AnchorMax);
                item.AdjustmentLog.Add($"[{def.Name}] 锚点分 {fs.Anchor} 越界，钳制为 {clamped}");
                fs.OriginalAnchor = fs.Anchor;
                fs.Anchor = clamped;
            }

            // 证据闸：声称有证据但证据文本为空 → 视为无证据
            if (fs.HasEvidence && string.IsNullOrWhiteSpace(fs.Evidence))
            {
                fs.HasEvidence = false;
                item.AdjustmentLog.Add($"[{def.Name}] 声称有证据但未给出原文引用，按无证据处理");
            }

            // 无证据 → 保守锚点（不采信 LLM 凭空判断）
            if (!fs.HasEvidence && fs.Anchor != RequirementFactorCatalog.ConservativeAnchor)
            {
                fs.OriginalAnchor ??= fs.Anchor;
                item.AdjustmentLog.Add($"[{def.Name}] 无证据，锚点 {fs.Anchor} 调整为保守值 {RequirementFactorCatalog.ConservativeAnchor}，建议补充该维度信息");
                fs.Anchor = RequirementFactorCatalog.ConservativeAnchor;
            }

            if (!fs.HasEvidence && !item.MissingInfo.Contains(def.Name))
                item.MissingInfo.Add(def.Name);

            fs.WeightedScore = Math.Round(fs.Anchor * fs.Weight / 10.0, 1);
            normalized.Add(fs);
        }

        item.FactorScores = normalized;
        item.TotalScore = Math.Round(normalized.Sum(f => f.WeightedScore), 1);

        var withEvidence = normalized.Count(f => f.HasEvidence);
        item.ConfidencePercent = (int)Math.Round(withEvidence * 100.0 / normalized.Count);

        // 合理性闸：判定「不合理」必须有评论原文依据，否则判定作废（不采信凭空否决）
        if (item.ReasonablenessVerdict == RequirementReasonableness.Unreasonable
            && string.IsNullOrWhiteSpace(item.ReasonablenessEvidence))
        {
            item.ReasonablenessVerdict = null;
            item.ReasonablenessEvidence = null;
            item.AdjustmentLog.Add("[合理性] 判定「不合理」但未给出评论原文依据，判定作废");
        }

        if (IsUnreasonable(item))
            item.AdjustmentLog.Add("[合理性] 评论判定该需求不合理：强制分档 P3 并排序置于所有合理需求之后");

        // 强制置顶判定：签约紧迫度 ≥9（已签约且 ≤30 天）且有真实证据；评论判定不合理的不参与置顶
        var contract = normalized.First(f => f.Key == RequirementFactorCatalog.ContractUrgency);
        item.IsContractualOverride = contract.Anchor >= RequirementFactorCatalog.ContractOverrideAnchorMin
            && contract.HasEvidence
            && !IsUnreasonable(item);
    }

    /// <summary>评论是否判定该需求不合理</summary>
    public static bool IsUnreasonable(RequirementAssessmentItem item)
        => item.ReasonablenessVerdict == RequirementReasonableness.Unreasonable;

    /// <summary>
    /// 全局排序并写回 Priority / Tier：
    /// 1) 评论判定「不合理」的需求整组置底（组内仍按总分排）；
    /// 2) 签约强制置顶组排在所有普通需求之前（组内仍按总分排）；
    /// 3) 同分决胜链：签约紧迫 → 客户反馈量 → 主线契合 → 成交助力 → 通用性 → 原始行号；
    /// 4) 分档：不合理强制 P3；置顶或 ≥80 = P0；≥65 = P1；≥50 = P2；其余 P3。
    /// </summary>
    public static void RankAndTier(List<RequirementAssessmentItem> items)
    {
        var sorted = items.OrderBy(IsUnreasonable)
            .ThenByDescending(x => x.IsContractualOverride)
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
        if (IsUnreasonable(item)) return "P3";
        if (item.IsContractualOverride || item.TotalScore >= RequirementFactorCatalog.TierP0Threshold) return "P0";
        if (item.TotalScore >= RequirementFactorCatalog.TierP1Threshold) return "P1";
        if (item.TotalScore >= RequirementFactorCatalog.TierP2Threshold) return "P2";
        return "P3";
    }
}
