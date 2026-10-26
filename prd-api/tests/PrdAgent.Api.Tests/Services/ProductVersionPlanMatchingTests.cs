using PrdAgent.Api.Services.ProductAgent;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionPlanMatchingTests
{
    private static readonly VersionPlanApplication[] Applications = { new("marketing", "互动营销"), new("retail", "零售") };
    private const string Topic = "渠道返利是否宴席/团购商品订单结单后判定优化";

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void 米多星球统一识别为米多总平台且保留明确粘贴的标题(bool formal)
    {
        var name = $"米多星球R=T1.2.3（{Topic}）-AI文档";
        var result = VersionRegistrationMessageParser.Parse($"产品立项方案名称：{name}", formal ? "formal" : "internal");
        var applications = new[] { new VersionPlanApplication("legacy", "米多星球"), new VersionPlanApplication("platform", "米多总平台") };
        ProductVersionPlanMatching.Match(result, applications, new[] { new VersionPlanCandidate("plan", "platform", $"米多总平台（{Topic}）", "T1.2.3") }, formal);
        result.MatchedApplicationId.ShouldBe("platform");
        result.PlanName.ShouldBe(name);
        if (formal) result.MatchedInitiationId.ShouldBe("plan");
        ProductVersionPlanMatching.CleanTitle(name, "米多总平台").ShouldBe($"米多总平台（{Topic}）-AI文档");
    }

    [Fact]
    public void 别名不绕过应用范围且同主题多个立项仍需选择()
    {
        var missing = new VersionRegistrationMessageParseResult { PlanName = $"米多星球（{Topic}）" };
        ProductVersionPlanMatching.Match(missing, new[] { new VersionPlanApplication("legacy", "米多星球") },
            new[] { new VersionPlanCandidate("legacy-plan", "legacy", $"米多星球（{Topic}）", "T1.0.0") }, true);
        missing.MatchedApplicationId.ShouldBeNull(); missing.MatchedInitiationId.ShouldBeNull();
        var ambiguous = new VersionRegistrationMessageParseResult { PlanName = $"米多星球（{Topic}）" };
        ProductVersionPlanMatching.Match(ambiguous, new[] { new VersionPlanApplication("platform", "米多总平台") }, new[] {
            new VersionPlanCandidate("first", "platform", $"米多总平台（{Topic}）", "T1.2.3"),
            new VersionPlanCandidate("second", "platform", $"米多总平台（{Topic}）", "T1.2.4"),
        }, true);
        ambiguous.MatchedApplicationId.ShouldBe("platform"); ambiguous.MatchedInitiationId.ShouldBeNull();
        ambiguous.CandidateInitiationIds.ShouldBe(new[] { "first", "second" });
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void 明确粘贴的立项名称优先于规范化和匹配方案(bool formal)
    {
        var name = $"互动营销T3.47.1（{Topic}调整）-AI文档";
        var result = VersionRegistrationMessageParser.Parse($"产品立项方案名称：{name} @张三", formal ? "formal" : "internal");
        ProductVersionPlanMatching.Match(result, Applications,
            new[] { new VersionPlanCandidate("plan", "marketing", $"互动营销（{Topic}）", "T3.47.1") }, formal);
        result.PlanName.ShouldBe(name);
        result.MatchedApplicationId.ShouldBe("marketing");
        if (formal) result.MatchedInitiationId.ShouldBe("plan");
    }

    [Theory]
    [InlineData("互动营销R=TXXXX（订单优化）", "互动营销（订单优化）")]
    [InlineData("互动营销 临时占位R=T3.47.1 (订单优化)-AI文档", "互动营销(订单优化)-AI文档")]
    [InlineData("互动营销（合法R=T内容不可删除）", "互动营销（合法R=T内容不可删除）")]
    [InlineData("未知应用R=TXXXX（订单优化）", "未知应用R=TXXXX（订单优化）")]
    [InlineData("没有括号的完整方案名", "没有括号的完整方案名")]
    public void 只清洗已知应用与括号之间的占位(string input, string expected)
    {
        ProductVersionPlanMatching.CleanTitle(input, "互动营销").ShouldBe(expected);
    }

    [Fact]
    public void 示例正式方案忽略占位和文档后缀并回填规范立项()
    {
        var result = new VersionRegistrationMessageParseResult { PlanName = $"互动营销T3.47.1（{Topic}）-AI文档", TCode = "T3.47.1" };
        var plans = new[] { new VersionPlanCandidate("plan", "marketing", $"互动营销（{Topic}）", "T3.47.1") };
        ProductVersionPlanMatching.Match(result, Applications, plans, true);
        result.MatchedInitiationId.ShouldBe("plan");
        result.MatchedApplicationId.ShouldBe("marketing");
        result.PlanName.ShouldBe(plans[0].PlanName);
    }

    [Fact]
    public void 缺少T号也可按应用和方案主题匹配且不会跨应用选择()
    {
        var result = new VersionRegistrationMessageParseResult { PlanName = $"互动营销占位（{Topic}）" };
        var plans = new[] {
            new VersionPlanCandidate("correct", "marketing", $"互动营销（{Topic}）", "T1.2.3"),
            new VersionPlanCandidate("other", "retail", $"零售（{Topic}）", "T1.2.3"),
        };
        ProductVersionPlanMatching.Match(result, Applications, plans, true);
        result.MatchedInitiationId.ShouldBe("correct");
    }

    [Fact]
    public void 同主题多个立项只给候选不选第一条()
    {
        var result = new VersionRegistrationMessageParseResult { PlanName = $"互动营销（{Topic}）" };
        var plans = new[] {
            new VersionPlanCandidate("first", "marketing", $"互动营销（{Topic}）", "T1.2.3"),
            new VersionPlanCandidate("second", "marketing", $"互动营销（{Topic}）", "T1.2.4"),
        };
        ProductVersionPlanMatching.Match(result, Applications, plans, true);
        result.MatchedInitiationId.ShouldBeNull();
        result.CandidateInitiationIds.ShouldBe(new[] { "first", "second" });
    }

    [Fact]
    public void 占位T号与主题冲突时不选错误方案()
    {
        var result = new VersionRegistrationMessageParseResult { PlanName = $"互动营销R=T9.9.9（{Topic}）", TCode = "T9.9.9" };
        var plans = new[] {
            new VersionPlanCandidate("wrong", "marketing", "互动营销（完全不相关的收款方案）", "T9.9.9"),
            new VersionPlanCandidate("correct", "marketing", $"互动营销（{Topic}）", "T3.47.1"),
        };
        ProductVersionPlanMatching.Match(result, Applications, plans, true);
        result.MatchedInitiationId.ShouldBe("correct");
    }

    [Fact]
    public void 有限相似和未匹配保留手工输入()
    {
        var result = new VersionRegistrationMessageParseResult { PlanName = $"互动营销（{Topic}调整）" };
        ProductVersionPlanMatching.Match(result, Applications, new[] { new VersionPlanCandidate("plan", "marketing", $"互动营销（{Topic}）", "T1.2.3") }, true);
        result.MatchedInitiationId.ShouldBe("plan");
        var missing = new VersionRegistrationMessageParseResult { PlanName = "互动营销（一个新方案）" };
        ProductVersionPlanMatching.Match(missing, Applications, Array.Empty<VersionPlanCandidate>(), true);
        missing.MatchedInitiationId.ShouldBeNull();
        missing.PlanName.ShouldBe("互动营销（一个新方案）");
    }

    [Fact]
    public void 不认识的应用前缀不能仅凭主题自动跨应用()
    {
        var result = new VersionRegistrationMessageParseResult { PlanName = $"未知应用（{Topic}）" };
        ProductVersionPlanMatching.Match(result, Applications,
            new[] { new VersionPlanCandidate("plan", "marketing", $"互动营销（{Topic}）", "T1.2.3") }, true);
        result.MatchedInitiationId.ShouldBeNull();
        result.CandidateInitiationIds.ShouldBe(new[] { "plan" });
    }

    [Fact]
    public void 应用归属识别用关联应用而申领归属仍按立项所属产品()
    {
        var result = new VersionRegistrationMessageParseResult { PlanName = $"互动营销（{Topic}）" };
        ProductVersionPlanMatching.Match(result, Applications,
            new[] { new VersionPlanCandidate("plan", "container", $"互动营销（{Topic}）", "T1.2.3", "marketing") }, true);
        result.MatchedInitiationId.ShouldBe("plan");
        result.MatchedApplicationId.ShouldBe("container");
    }
}
