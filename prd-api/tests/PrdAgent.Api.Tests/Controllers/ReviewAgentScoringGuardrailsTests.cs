using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 三层兜底（Guardrails）单元测试：抵御 LLM 把非清单维度全填满凑高分 + summary 自相矛盾的钻空子路径。
/// </summary>
public class ReviewAgentScoringGuardrailsTests
{
    /// <summary>构造一个简化的"7 个非清单维度 + 1 个清单维度"配置，权重与最新默认对齐。</summary>
    private static List<ReviewDimensionConfig> BuildDims()
    {
        return new List<ReviewDimensionConfig>
        {
            new() { Key = "global_rules_checklist", Name = "全局规则检查清单", MaxScore = 20,
                    Items = new List<DimensionCheckItem> { new() { Id = "x", Text = "x" } } },
            new() { Key = "template_compliance", Name = "文档规范完整性", MaxScore = 8 },
            new() { Key = "consistency", Name = "内在自洽性", MaxScore = 16 },
            new() { Key = "problem_quality", Name = "问题陈述质量", MaxScore = 13 },
            new() { Key = "user_value", Name = "用户价值清晰度", MaxScore = 12 },
            new() { Key = "feasibility", Name = "实现思路可行性", MaxScore = 12 },
            new() { Key = "testability", Name = "需求可测试性", MaxScore = 9 },
            new() { Key = "expression", Name = "表达质量与凝练度", MaxScore = 10 },
        };
    }

    /// <summary>构造一份「LLM 全填满分」的打分（清单 20 + 非清单 80 = 100）。</summary>
    private static List<ReviewDimensionScore> BuildAllMaxScores(string commentForNonChecklist = "整体表现优秀，内容完整、思路清晰、表达凝练。")
    {
        return new List<ReviewDimensionScore>
        {
            new() { Key = "global_rules_checklist", Name = "全局规则检查清单", Score = 20, MaxScore = 20,
                    Comment = "清单已系统派生", Items = new List<DimensionCheckItemResult>() },
            new() { Key = "template_compliance", Name = "文档规范完整性", Score = 8, MaxScore = 8, Comment = commentForNonChecklist },
            new() { Key = "consistency", Name = "内在自洽性", Score = 16, MaxScore = 16, Comment = commentForNonChecklist },
            new() { Key = "problem_quality", Name = "问题陈述质量", Score = 13, MaxScore = 13, Comment = commentForNonChecklist },
            new() { Key = "user_value", Name = "用户价值清晰度", Score = 12, MaxScore = 12, Comment = commentForNonChecklist },
            new() { Key = "feasibility", Name = "实现思路可行性", Score = 12, MaxScore = 12, Comment = commentForNonChecklist },
            new() { Key = "testability", Name = "需求可测试性", Score = 9, MaxScore = 9, Comment = commentForNonChecklist },
            new() { Key = "expression", Name = "表达质量与凝练度", Score = 10, MaxScore = 10, Comment = commentForNonChecklist },
        };
    }

    // ── HasSufficientEvidence ───────────────────────────────────

    [Fact]
    public void HasSufficientEvidence_空评语_视为无证据()
    {
        ReviewAgentController.HasSufficientEvidence(null).ShouldBeFalse();
        ReviewAgentController.HasSufficientEvidence("").ShouldBeFalse();
        ReviewAgentController.HasSufficientEvidence("   ").ShouldBeFalse();
    }

    [Fact]
    public void HasSufficientEvidence_短评语_视为无证据()
    {
        ReviewAgentController.HasSufficientEvidence("内容完整，思路清晰。").ShouldBeFalse();
    }

    [Fact]
    public void HasSufficientEvidence_长评语但纯定性形容_视为无证据()
    {
        // 长度足够但通篇空话套话，无任何具体数字/引用
        var comment = "整体表现优秀，内容完整、思路清晰、表达凝练，可立即指导落地实施。质量上乘。";
        ReviewAgentController.HasSufficientEvidence(comment).ShouldBeFalse();
    }

    [Fact]
    public void HasSufficientEvidence_LLM单数字凑数钻空子_无效()
    {
        // 30+ 字 + 一个孤零零的 "1" —— 之前 \d 单数字会过关，现在 \d{2,} 拦下
        var comment = "整体表现非常优秀，所有维度都得到了应得的分数，本次评审基于综合判断 1。";
        ReviewAgentController.HasSufficientEvidence(comment).ShouldBeFalse();
    }

    [Fact]
    public void HasSufficientEvidence_简洁高密度短评语_视为有证据()
    {
        // Finding D 修复：长度仅 16 字但含 2 个强标记，不应被误伤
        ReviewAgentController.HasSufficientEvidence("覆盖 40 应用 80% 成功率，归母清晰。").ShouldBeTrue();
    }

    [Fact]
    public void HasSufficientEvidence_含数字_视为有证据()
    {
        ReviewAgentController.HasSufficientEvidence("方案中 40 个应用的量化数据支撑，逻辑闭环清晰。").ShouldBeTrue();
    }

    [Fact]
    public void HasSufficientEvidence_含百分比_视为有证据()
    {
        ReviewAgentController.HasSufficientEvidence("覆盖了 80% 的核心场景，剩余 20% 已标注后续迭代。").ShouldBeTrue();
    }

    [Fact]
    public void HasSufficientEvidence_含章节引用_视为有证据()
    {
        ReviewAgentController.HasSufficientEvidence("第 3 章实现思路明确指出归母模块，与项目目的形成闭环。").ShouldBeTrue();
    }

    [Fact]
    public void HasSufficientEvidence_含书名号引用_视为有证据()
    {
        ReviewAgentController.HasSufficientEvidence("方案引用《互动营销规范 v2》明确边界，可执行性强。").ShouldBeTrue();
    }

    // ── CountDataPoints ─────────────────────────────────────────

    [Fact]
    public void CountDataPoints_空白原文_为零()
    {
        ReviewAgentController.CountDataPoints("").ShouldBe(0);
        ReviewAgentController.CountDataPoints("   ").ShouldBe(0);
    }

    [Fact]
    public void CountDataPoints_单数字不计_两位数及以上才计()
    {
        // "3 个" 中的 "3" 是单数字（< 2 位），按设计不计入
        ReviewAgentController.CountDataPoints("方案有 3 个应用").ShouldBe(0);
        // "40" 是两位数，计 1 次
        ReviewAgentController.CountDataPoints("方案覆盖 40 个应用").ShouldBe(1);
    }

    [Fact]
    public void CountDataPoints_典型空话方案_低于五处()
    {
        var content = "本次改造旨在优化产品体验，提升用户满意度。我们将通过技术手段实现这一目标，确保项目顺利落地。";
        ReviewAgentController.CountDataPoints(content).ShouldBeLessThan(5);
    }

    [Fact]
    public void CountDataPoints_扎实方案_达到阈值()
    {
        var content = "P95 首屏加载从 3200ms 降至 1500ms（监控来源 https://dashboard.example/perf），" +
                      "覆盖 12 个核心场景，第 3 章详细阐述方案，引用《性能规范 v2》。Safari 兼容性下降 0.8%。";
        ReviewAgentController.CountDataPoints(content).ShouldBeGreaterThanOrEqualTo(5);
    }

    [Fact]
    public void CountDataPoints_百分比不被重复计数()
    {
        // Finding C 修复：之前 "80%" 既匹配 \d{2,} 又匹配 \d+[%]，被计 2 次
        // 现在 \d{2,}(?![%％]) 排除百分号后续，"80%" 只计 1
        ReviewAgentController.CountDataPoints("覆盖率 80%").ShouldBe(1);
        ReviewAgentController.CountDataPoints("成功率 80%，失败率 20%").ShouldBe(2);
    }

    // ── SummaryContainsDowngradeKeyword ─────────────────────────

    [Fact]
    public void SummaryContainsDowngradeKeyword_匹配截图原文_命中()
    {
        // 用户截图里出现的原话
        var summary = "总体落在 75-89 合格区间上沿，因缺乏行业级洞察和非显而易见的数据分析，未达到 90+ 标杆级水平。";
        ReviewAgentController.SummaryContainsDowngradeKeyword(summary).ShouldBeTrue();
    }

    [Fact]
    public void SummaryContainsDowngradeKeyword_仅含正面评价_不命中()
    {
        var summary = "方案凝练扎实，数据充分，论证完整，可立即指导落地实施。";
        ReviewAgentController.SummaryContainsDowngradeKeyword(summary).ShouldBeFalse();
    }

    [Fact]
    public void SummaryContainsDowngradeKeyword_有改进空间_命中()
    {
        ReviewAgentController.SummaryContainsDowngradeKeyword("方案整体不错，但仍有改进空间。").ShouldBeTrue();
    }

    [Fact]
    public void SummaryContainsDowngradeKeyword_褒义标杆级表述_不命中()
    {
        // Finding B 修复：之前 "标杆级水平" 子串匹配会误伤褒义高分 summary
        // 现在关键词清单只保留单义负面词，褒义不应触发
        ReviewAgentController.SummaryContainsDowngradeKeyword(
            "方案达到行业标杆级水平，凝练扎实，数据充分，可立即对外发布。").ShouldBeFalse();
    }

    [Fact]
    public void SummaryContainsDowngradeKeyword_明确未达标杆_命中()
    {
        ReviewAgentController.SummaryContainsDowngradeKeyword("方案未达标杆级水平，仍需打磨。").ShouldBeTrue();
    }

    // ── ApplyScoringGuardrails 集成场景 ─────────────────────────

    [Fact]
    public void Guardrail_L1_LLM全填满分但评语空洞_所有非清单维度被压到89()
    {
        var dims = BuildDims();
        var scores = BuildAllMaxScores("整体表现优秀，内容完整、思路清晰、表达凝练，可立即指导落地实施。质量上乘。");
        // 给一份「数据密度足够 + summary 无降级关键词」的原文和 summary，确保 L2/L3 不会同时触发，单独验 L1
        var content = string.Join(" ", Enumerable.Repeat("第 1 章引用 40 个应用 80% 覆盖率《规范 v2》", 5));
        var summary = "方案凝练扎实，数据充分，论证完整。";

        var log = ReviewAgentController.ApplyScoringGuardrails(scores, dims, content, summary);

        log.ShouldNotBeEmpty();
        log.ShouldContain(e => e.Contains("L1 证据闸"));

        // 所有非清单维度都应被压（得分率原 100% → 89%）
        scores.First(s => s.Key == "consistency").Score.ShouldBe((int)System.Math.Floor(16 * 0.89));      // 14
        scores.First(s => s.Key == "problem_quality").Score.ShouldBe((int)System.Math.Floor(13 * 0.89)); // 11
        scores.First(s => s.Key == "feasibility").Score.ShouldBe((int)System.Math.Floor(12 * 0.89));     // 10
        scores.First(s => s.Key == "testability").Score.ShouldBe((int)System.Math.Floor(9 * 0.89));      // 8

        // 清单维度不被本兜底覆盖
        scores.First(s => s.Key == "global_rules_checklist").Score.ShouldBe(20);

        // 总分不再是 100：被压到合理范围内
        scores.Sum(s => s.Score).ShouldBeLessThan(100);
    }

    [Fact]
    public void Guardrail_L1_评语有具体证据_不触发()
    {
        var dims = BuildDims();
        var scores = BuildAllMaxScores(
            "方案覆盖 40 个应用，给出 80% 的能力清单，引用《互动营销规范 v2》，第 3 章实现思路明确归母。");
        var content = string.Join(" ", Enumerable.Repeat("第 1 章引用 40 个应用 80% 覆盖率《规范 v2》", 5));
        var summary = "方案凝练扎实，数据充分。";

        var log = ReviewAgentController.ApplyScoringGuardrails(scores, dims, content, summary);

        // 不应有 L1 触发条目（所有维度评语都含具体证据）
        log.ShouldNotContain(e => e.Contains("L1 证据闸"));
        // 分数保持原状
        scores.First(s => s.Key == "consistency").Score.ShouldBe(16);
    }

    [Fact]
    public void Guardrail_L2_数据密度不足_所有高分非清单维度被压()
    {
        var dims = BuildDims();
        var scores = BuildAllMaxScores(
            "方案覆盖 40 个应用，给出 80% 的能力清单，引用《互动营销规范 v2》。"); // L1 不会触发
        var content = "本次改造旨在优化产品体验。"; // 数据密度 = 0
        var summary = "方案凝练扎实，数据充分。"; // L3 不触发

        var log = ReviewAgentController.ApplyScoringGuardrails(scores, dims, content, summary);

        log.ShouldContain(e => e.Contains("L2 数据密度"));
        scores.First(s => s.Key == "consistency").Score.ShouldBe((int)System.Math.Floor(16 * 0.89));
    }

    [Fact]
    public void Guardrail_L3_summary含降级关键词但分高_被压()
    {
        var dims = BuildDims();
        // 评语含具体证据 → L1 不触发；原文数据密度高 → L2 不触发；仅 L3 触发
        var scores = BuildAllMaxScores(
            "方案覆盖 40 个应用，给出 80% 的能力清单，引用《互动营销规范 v2》，第 3 章实现思路明确归母。");
        var content = string.Join(" ", Enumerable.Repeat("第 1 章 40 个应用 80% 《规范 v2》", 5));
        var summary = "总体落在 75-89 合格区间上沿，未达到 90+ 标杆级水平。";

        var log = ReviewAgentController.ApplyScoringGuardrails(scores, dims, content, summary);

        log.ShouldContain(e => e.Contains("L3 一致性闸"));
        // 总分被压：99/100 → 应显著低于 90
        var total = scores.Sum(s => s.Score);
        var max = scores.Sum(s => s.MaxScore);
        ((double)total / max).ShouldBeLessThan(0.9);
    }

    [Fact]
    public void Guardrail_L1触发时记录OriginalScore()
    {
        // Finding H：被调整的维度必须留下原始分供审计
        var dims = BuildDims();
        var scores = BuildAllMaxScores("整体表现优秀，内容完整、思路清晰、表达凝练，可立即指导落地实施。质量上乘。");
        var content = string.Join(" ", Enumerable.Repeat("第 1 章引用 40 个应用 80% 覆盖率《规范 v2》", 5));
        var summary = "方案凝练扎实，数据充分。";

        ReviewAgentController.ApplyScoringGuardrails(scores, dims, content, summary);

        // 非清单维度被压时 OriginalScore 应保留原满分值
        var consistency = scores.First(s => s.Key == "consistency");
        consistency.OriginalScore.ShouldBe(16);
        consistency.Score.ShouldBeLessThan(16);

        // 清单维度未被本兜底调整，OriginalScore 保持 null
        var checklist = scores.First(s => s.Key == "global_rules_checklist");
        checklist.OriginalScore.ShouldBeNull();
    }

    [Fact]
    public void Guardrail_DB配置出现重复Key_不抛异常()
    {
        // Finding F：UpdateDimensions 未校验 Key 唯一性，guardrail 必须能容错
        var dims = BuildDims();
        dims.Add(new ReviewDimensionConfig { Key = "consistency", Name = "重复键", MaxScore = 16 });
        var scores = BuildAllMaxScores();
        var summary = "整体合格";

        Should.NotThrow(() => ReviewAgentController.ApplyScoringGuardrails(scores, dims, "短方案", summary));
    }

    [Fact]
    public void Guardrail_L2命中后L3因总分跌破90门槛而不再触发()
    {
        // L2 把所有高分维度压到 89%，total/max 降到 0.88 < 0.9，L3 门槛失效
        // 这是设计上正确的行为：summary 的降级措辞此时与系统打分一致，没有矛盾，不需要再压
        var dims = BuildDims();
        var scores = BuildAllMaxScores(
            "方案覆盖 40 个应用，给出 80% 的能力清单，引用《互动营销规范 v2》，第 3 章实现思路明确归母。");
        var content = "本次改造旨在优化产品体验。"; // L2 触发
        var summary = "总体落在 75-89 合格区间上沿，未达到 90+ 水平。"; // L3 关键词命中

        var log = ReviewAgentController.ApplyScoringGuardrails(scores, dims, content, summary);

        log.ShouldContain(e => e.Contains("L2 数据密度"));
        // L3 门槛失效，不应产生 L3 日志条目（设计正确：避免在已经合理的得分上重复打压）
        log.ShouldNotContain(e => e.Contains("L3 一致性闸"));
    }

    [Fact]
    public void Guardrail_无任何触发_日志为空()
    {
        var dims = BuildDims();
        // 一份「合格区间」打分：得分率 75-89 之间，不触发任何兜底
        var scores = new List<ReviewDimensionScore>
        {
            new() { Key = "global_rules_checklist", Name = "全局规则检查清单", Score = 16, MaxScore = 20,
                    Items = new List<DimensionCheckItemResult>() },
            new() { Key = "template_compliance", Name = "文档规范完整性", Score = 7, MaxScore = 8, Comment = "章节齐全" },
            new() { Key = "consistency", Name = "内在自洽性", Score = 13, MaxScore = 16, Comment = "逻辑闭环基本到位" },
            new() { Key = "problem_quality", Name = "问题陈述质量", Score = 10, MaxScore = 13, Comment = "问题描述清晰" },
            new() { Key = "user_value", Name = "用户价值清晰度", Score = 10, MaxScore = 12, Comment = "用户角色明确" },
            new() { Key = "feasibility", Name = "实现思路可行性", Score = 10, MaxScore = 12, Comment = "归母明确" },
            new() { Key = "testability", Name = "需求可测试性", Score = 7, MaxScore = 9, Comment = "标准基本可验证" },
            new() { Key = "expression", Name = "表达质量与凝练度", Score = 8, MaxScore = 10, Comment = "表达凝练" },
        };
        var content = "短方案";
        var summary = "整体合格";

        var log = ReviewAgentController.ApplyScoringGuardrails(scores, dims, content, summary);

        log.ShouldBeEmpty();
    }
}
