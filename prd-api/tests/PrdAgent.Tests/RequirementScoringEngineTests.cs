using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Tests;

/// <summary>
/// 需求评估计分引擎守卫测试：权重合计、加权计分（0-10 锚点制）、证据兜底、
/// 签约强制置顶、合理性判定（不合理降档置底）、同分决胜链、分档阈值。
/// 删除引擎中任一规则本套测试必红。
/// </summary>
public class RequirementScoringEngineTests
{
    private static RequirementAssessmentItem BuildItem(int rowIndex, int anchorForAll, bool hasEvidence = true)
    {
        var item = new RequirementAssessmentItem { RowIndex = rowIndex, Name = $"需求{rowIndex}" };
        foreach (var def in RequirementFactorCatalog.All)
        {
            item.FactorScores.Add(new RequirementFactorScore
            {
                Key = def.Key,
                Anchor = anchorForAll,
                HasEvidence = hasEvidence,
                Evidence = hasEvidence ? $"字段=\"样例证据 {def.Name}\"" : string.Empty,
            });
        }
        return item;
    }

    private static void SetAnchor(RequirementAssessmentItem item, string key, int anchor, bool hasEvidence = true)
    {
        var fs = item.FactorScores.First(f => f.Key == key);
        fs.Anchor = anchor;
        fs.HasEvidence = hasEvidence;
        fs.Evidence = hasEvidence ? "字段=\"证据\"" : string.Empty;
    }

    [Fact]
    public void Catalog_weights_sum_to_100_and_match_approved_values()
    {
        Assert.Equal(100, RequirementFactorCatalog.All.Sum(f => f.Weight));
        Assert.Equal(8, RequirementFactorCatalog.All.Count);

        // 2026-08-04 用户核定权重：成交助力/签约紧迫度 15，客户重要度 10，其余 12
        Assert.Equal(15, RequirementFactorCatalog.Find(RequirementFactorCatalog.DealLeverage)!.Weight);
        Assert.Equal(15, RequirementFactorCatalog.Find(RequirementFactorCatalog.ContractUrgency)!.Weight);
        Assert.Equal(10, RequirementFactorCatalog.Find(RequirementFactorCatalog.CustomerTier)!.Weight);
        Assert.Equal(12, RequirementFactorCatalog.Find(RequirementFactorCatalog.Universality)!.Weight);
        Assert.Equal(12, RequirementFactorCatalog.Find(RequirementFactorCatalog.RoadmapFit)!.Weight);
    }

    [Fact]
    public void Comment_driven_factors_are_the_first_five()
    {
        // 2026-08-06 用户核定：前五因子以评论为最高优先级证据，后三因子以需求详情为准
        Assert.Equal(
            new[]
            {
                RequirementFactorCatalog.Universality,
                RequirementFactorCatalog.Frequency,
                RequirementFactorCatalog.ImpactScope,
                RequirementFactorCatalog.CustomerVoice,
                RequirementFactorCatalog.RoadmapFit,
            },
            RequirementFactorCatalog.CommentDrivenFactorKeys);
        Assert.False(RequirementFactorCatalog.IsCommentDriven(RequirementFactorCatalog.CustomerTier));
        Assert.False(RequirementFactorCatalog.IsCommentDriven(RequirementFactorCatalog.DealLeverage));
        Assert.False(RequirementFactorCatalog.IsCommentDriven(RequirementFactorCatalog.ContractUrgency));
    }

    [Fact]
    public void Full_marks_with_evidence_scores_100()
    {
        var item = BuildItem(1, anchorForAll: 10);
        RequirementScoringEngine.NormalizeAndScore(item);

        Assert.Equal(100, item.TotalScore);
        Assert.Equal(100, item.ConfidencePercent);
        Assert.Empty(item.AdjustmentLog);
        Assert.True(item.IsContractualOverride); // 签约紧迫度 10 ≥ 置顶下限 9 + 有证据
    }

    [Fact]
    public void Weighted_score_uses_anchor_times_weight_over_ten()
    {
        var item = BuildItem(1, anchorForAll: 6);
        RequirementScoringEngine.NormalizeAndScore(item);

        // 锚点 6：总分 = Σ(6 x weight / 10) = 6/10 x 100 = 60
        Assert.Equal(60, item.TotalScore);
        var deal = item.FactorScores.First(f => f.Key == RequirementFactorCatalog.DealLeverage);
        Assert.Equal(9, deal.WeightedScore); // 6 x 15 / 10
    }

    [Fact]
    public void Missing_evidence_forces_conservative_anchor_and_logs()
    {
        var item = BuildItem(1, anchorForAll: 10);
        SetAnchor(item, RequirementFactorCatalog.CustomerVoice, 10, hasEvidence: false);
        RequirementScoringEngine.NormalizeAndScore(item);

        var voice = item.FactorScores.First(f => f.Key == RequirementFactorCatalog.CustomerVoice);
        Assert.Equal(RequirementFactorCatalog.ConservativeAnchor, voice.Anchor);
        Assert.Equal(10, voice.OriginalAnchor);
        Assert.Contains(item.AdjustmentLog, log => log.Contains("客户反馈量"));
        Assert.Contains("客户反馈量", item.MissingInfo);
        Assert.Equal((int)Math.Round(7 * 100.0 / 8), item.ConfidencePercent);
    }

    [Fact]
    public void Claimed_evidence_with_blank_text_is_rejected()
    {
        var item = BuildItem(1, anchorForAll: 8);
        var fs = item.FactorScores.First(f => f.Key == RequirementFactorCatalog.Universality);
        fs.HasEvidence = true;
        fs.Evidence = "   "; // 声称有证据但给不出引用

        RequirementScoringEngine.NormalizeAndScore(item);

        var normalized = item.FactorScores.First(f => f.Key == RequirementFactorCatalog.Universality);
        Assert.False(normalized.HasEvidence);
        Assert.Equal(RequirementFactorCatalog.ConservativeAnchor, normalized.Anchor);
    }

    [Fact]
    public void Out_of_range_anchor_is_clamped()
    {
        var item = BuildItem(1, anchorForAll: 6);
        var fs = item.FactorScores.First(f => f.Key == RequirementFactorCatalog.Frequency);
        fs.Anchor = 15;

        RequirementScoringEngine.NormalizeAndScore(item);

        Assert.Equal(10, item.FactorScores.First(f => f.Key == RequirementFactorCatalog.Frequency).Anchor);
        Assert.Contains(item.AdjustmentLog, log => log.Contains("越界"));
    }

    [Fact]
    public void Zero_anchor_is_a_legal_score()
    {
        var item = BuildItem(1, anchorForAll: 6);
        SetAnchor(item, RequirementFactorCatalog.Universality, 0);
        RequirementScoringEngine.NormalizeAndScore(item);

        var uni = item.FactorScores.First(f => f.Key == RequirementFactorCatalog.Universality);
        Assert.Equal(0, uni.Anchor);
        Assert.Equal(0, uni.WeightedScore);
        Assert.DoesNotContain(item.AdjustmentLog, log => log.Contains("通用性"));
    }

    [Fact]
    public void Missing_factor_is_backfilled_conservatively()
    {
        var item = BuildItem(1, anchorForAll: 8);
        item.FactorScores.RemoveAll(f => f.Key == RequirementFactorCatalog.RoadmapFit);

        RequirementScoringEngine.NormalizeAndScore(item);

        Assert.Equal(8, item.FactorScores.Count);
        var roadmap = item.FactorScores.First(f => f.Key == RequirementFactorCatalog.RoadmapFit);
        Assert.Equal(RequirementFactorCatalog.ConservativeAnchor, roadmap.Anchor);
        Assert.False(roadmap.HasEvidence);
    }

    [Fact]
    public void Contractual_override_requires_evidence_and_threshold()
    {
        var noEvidence = BuildItem(1, anchorForAll: 10);
        SetAnchor(noEvidence, RequirementFactorCatalog.ContractUrgency, 10, hasEvidence: false);
        RequirementScoringEngine.NormalizeAndScore(noEvidence);
        Assert.False(noEvidence.IsContractualOverride); // 无证据不置顶（会被保守化）

        var belowThreshold = BuildItem(2, anchorForAll: 6);
        SetAnchor(belowThreshold, RequirementFactorCatalog.ContractUrgency, 8); // 8 < 置顶下限 9
        RequirementScoringEngine.NormalizeAndScore(belowThreshold);
        Assert.False(belowThreshold.IsContractualOverride);

        var withEvidence = BuildItem(3, anchorForAll: 6);
        SetAnchor(withEvidence, RequirementFactorCatalog.ContractUrgency, 9);
        RequirementScoringEngine.NormalizeAndScore(withEvidence);
        Assert.True(withEvidence.IsContractualOverride);
    }

    [Fact]
    public void Contractual_override_ranks_before_higher_score()
    {
        // 低分但签约临期的需求必须排在高分普通需求之前
        var high = BuildItem(1, anchorForAll: 10);
        SetAnchor(high, RequirementFactorCatalog.ContractUrgency, 2); // 无签约 → 不置顶
        var lowButContract = BuildItem(2, anchorForAll: 4);
        SetAnchor(lowButContract, RequirementFactorCatalog.ContractUrgency, 10); // 签约临期 → 置顶

        RequirementScoringEngine.NormalizeAndScore(high);
        RequirementScoringEngine.NormalizeAndScore(lowButContract);
        Assert.True(high.TotalScore > lowButContract.TotalScore);

        var items = new List<RequirementAssessmentItem> { high, lowButContract };
        RequirementScoringEngine.RankAndTier(items);

        Assert.Equal(1, lowButContract.Priority);
        Assert.Equal(2, high.Priority);
        Assert.Equal("P0", lowButContract.Tier); // 置顶必为 P0
    }

    [Fact]
    public void Unreasonable_verdict_forces_p3_and_ranks_last()
    {
        var unreasonableHigh = BuildItem(1, anchorForAll: 10);
        unreasonableHigh.ReasonablenessVerdict = RequirementReasonableness.Unreasonable;
        unreasonableHigh.ReasonablenessEvidence = "评论=\"伪需求，不建议做\"";

        var reasonableLow = BuildItem(2, anchorForAll: 2);
        reasonableLow.ReasonablenessVerdict = RequirementReasonableness.Reasonable;
        reasonableLow.ReasonablenessEvidence = "评论=\"合理\"";

        RequirementScoringEngine.NormalizeAndScore(unreasonableHigh);
        RequirementScoringEngine.NormalizeAndScore(reasonableLow);
        Assert.True(unreasonableHigh.TotalScore > reasonableLow.TotalScore);
        Assert.Contains(unreasonableHigh.AdjustmentLog, log => log.Contains("不合理"));

        var items = new List<RequirementAssessmentItem> { unreasonableHigh, reasonableLow };
        RequirementScoringEngine.RankAndTier(items);

        // 高分但不合理的需求必须排在低分合理需求之后，且强制 P3
        Assert.Equal(1, reasonableLow.Priority);
        Assert.Equal(2, unreasonableHigh.Priority);
        Assert.Equal("P3", unreasonableHigh.Tier);
    }

    [Fact]
    public void Unreasonable_verdict_blocks_contractual_override()
    {
        var item = BuildItem(1, anchorForAll: 10);
        item.ReasonablenessVerdict = RequirementReasonableness.Unreasonable;
        item.ReasonablenessEvidence = "评论=\"不合理\"";

        RequirementScoringEngine.NormalizeAndScore(item);

        Assert.False(item.IsContractualOverride); // 签约紧迫度 10 也不置顶
    }

    [Fact]
    public void Unreasonable_verdict_without_evidence_is_discarded()
    {
        var item = BuildItem(1, anchorForAll: 8);
        item.ReasonablenessVerdict = RequirementReasonableness.Unreasonable;
        item.ReasonablenessEvidence = "  ";

        RequirementScoringEngine.NormalizeAndScore(item);

        Assert.Null(item.ReasonablenessVerdict);
        Assert.Null(item.ReasonablenessEvidence);
        Assert.Contains(item.AdjustmentLog, log => log.Contains("作废"));

        RequirementScoringEngine.RankAndTier(new List<RequirementAssessmentItem> { item });
        Assert.Equal("P0", item.Tier); // 判定作废后按正常分数分档（全 8 分 = 80）
    }

    [Fact]
    public void Tie_break_chain_prefers_contract_then_customer_voice()
    {
        // 两条总分相同：签约紧迫度高者在前
        var a = BuildItem(1, anchorForAll: 6);
        SetAnchor(a, RequirementFactorCatalog.ContractUrgency, 8);
        SetAnchor(a, RequirementFactorCatalog.DealLeverage, 4); // 抵消保持同分

        var b = BuildItem(2, anchorForAll: 6);
        SetAnchor(b, RequirementFactorCatalog.ContractUrgency, 4);
        SetAnchor(b, RequirementFactorCatalog.DealLeverage, 8);

        RequirementScoringEngine.NormalizeAndScore(a);
        RequirementScoringEngine.NormalizeAndScore(b);
        Assert.Equal(a.TotalScore, b.TotalScore);

        var items = new List<RequirementAssessmentItem> { b, a };
        RequirementScoringEngine.RankAndTier(items);

        Assert.Equal(1, a.Priority);
        Assert.Equal(2, b.Priority);
    }

    [Fact]
    public void Tie_break_falls_back_to_row_index_for_identical_items()
    {
        var a = BuildItem(5, anchorForAll: 6);
        var b = BuildItem(2, anchorForAll: 6);

        RequirementScoringEngine.NormalizeAndScore(a);
        RequirementScoringEngine.NormalizeAndScore(b);

        var items = new List<RequirementAssessmentItem> { a, b };
        RequirementScoringEngine.RankAndTier(items);

        Assert.Equal(1, b.Priority); // 行号小者在前
        Assert.Equal(2, a.Priority);
    }

    [Theory]
    [InlineData(8, "P0")] // 全 8 分 = 80，踩 P0 下限（签约紧迫度 8 不触发置顶，验证纯分数档）
    [InlineData(6, "P2")] // 全 6 分 = 60
    [InlineData(2, "P3")] // 全 2 分 = 20
    public void Tier_thresholds_by_uniform_anchor(int anchor, string expectedTier)
    {
        var item = BuildItem(1, anchorForAll: anchor);
        RequirementScoringEngine.NormalizeAndScore(item);
        RequirementScoringEngine.RankAndTier(new List<RequirementAssessmentItem> { item });

        Assert.False(item.IsContractualOverride);
        Assert.Equal(expectedTier, item.Tier);
    }

    [Fact]
    public void Tier_p1_between_65_and_80()
    {
        // 全 8 分（80）把通用性降到 2：80 - 9.6 + 2.4 = 72.8 → P1
        var item = BuildItem(1, anchorForAll: 8);
        SetAnchor(item, RequirementFactorCatalog.Universality, 2);
        RequirementScoringEngine.NormalizeAndScore(item);
        RequirementScoringEngine.RankAndTier(new List<RequirementAssessmentItem> { item });

        Assert.Equal(72.8, item.TotalScore);
        Assert.Equal("P1", item.Tier);
    }
}
