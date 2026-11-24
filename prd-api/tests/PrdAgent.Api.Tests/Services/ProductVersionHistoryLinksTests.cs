using PrdAgent.Api.Services.ProductAgent;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionHistoryLinksTests
{
    private const string Topic = "渠道返利门店参与机会及订单结单后奖励判定功能优化";

    [Fact]
    public void ReadsExplicitVTableTColumnButNotIncidentalRemarkReferences()
    {
        var codes = ProductVersionHistoryLinks.ExplicitTCodes(null, new Dictionary<string, string> {
            ["内部版本号"] = "t3.47.1", ["备注"] = "参考另一个 T9.9.9", ["方案名称"] = "T8.8.8 对照说明",
        });
        Assert.Equal(new[] { "T3.47.1" }, codes);
        Assert.Contains("T2.0.0", ProductVersionHistoryLinks.ExplicitTCodes(null, null, "T2.0.0"));
    }

    [Fact]
    public void ExplicitRelationWinsEvenWhenTitlesAreCompletelyDifferent()
    {
        var row = new ProductVersionHistoryLinks.HistoryRow("v", "V8.9.0", "历史名称完全不同", new() { "T1.2.3" });
        var result = ProductVersionHistoryLinks.Resolve("T1.2.3", Topic, new[] { "T1.2.3" }, new[] { row });
        Assert.True(result.Blocked);
        Assert.False(result.NeedsConfirmation);
        Assert.Contains("V8.9.0", result.Message);
    }

    [Fact]
    public void SameTitleCannotOverrideExplicitAssociationToAnotherT()
    {
        var row = new ProductVersionHistoryLinks.HistoryRow("v", "V8.9.0", Topic, new() { "T9.9.9" });
        var result = ProductVersionHistoryLinks.Resolve("T1.2.3", Topic, new[] { "T1.2.3" }, new[] { row });
        Assert.False(result.Blocked);
        Assert.False(result.NeedsConfirmation);
    }

    [Fact]
    public void WhitespacePunctuationAndTVTitleNumbersCanMatchOneCurrentT()
    {
        var row = new ProductVersionHistoryLinks.HistoryRow("v", "V8.9.0", $"互动营销V8.9.0（{Topic}！）", new());
        var result = ProductVersionHistoryLinks.Resolve("T1.2.3", $"互动营销T1.2.3（ {Topic} ）", new[] { "T1.2.3" }, new[] { row });
        Assert.True(result.Blocked);
        Assert.Null(result.ConfirmationToken);
    }

    [Fact]
    public void CloseButNotEqualTitleRequiresHumanConfirmationInsteadOfAutoBinding()
    {
        var row = new ProductVersionHistoryLinks.HistoryRow("v", "V8.9.0", Topic + "一期", new());
        var result = ProductVersionHistoryLinks.Resolve("T1.2.3", Topic, new[] { "T1.2.3" }, new[] { row });
        Assert.False(result.Blocked);
        Assert.True(result.NeedsConfirmation);
        Assert.NotNull(result.ConfirmationToken);
        Assert.Single(result.Candidates);
    }

    [Fact]
    public void DuplicateNamesInCurrentTTableCannotBeAutoLinked()
    {
        var row = new ProductVersionHistoryLinks.HistoryRow("v", "V8.9.0", Topic, new());
        var result = ProductVersionHistoryLinks.Resolve("T1.2.3", Topic, new[] { "T1.2.3", "T1.2.4" }, new[] { row });
        Assert.False(result.Blocked);
        Assert.True(result.NeedsConfirmation);
    }

    [Fact]
    public void ConfirmationChangesWhenHistoricalCandidatesOrTChanges()
    {
        var row = new ProductVersionHistoryLinks.HistoryRow("v", "V8.9.0", Topic + "一期", new());
        var initial = ProductVersionHistoryLinks.Resolve("T1.2.3", Topic, new[] { "T1.2.3" }, new[] { row });
        var anotherT = ProductVersionHistoryLinks.Resolve("T1.2.4", Topic, new[] { "T1.2.4" }, new[] { row });
        var updated = ProductVersionHistoryLinks.Resolve("T1.2.3", Topic, new[] { "T1.2.3" }, new[] { row with { PlanName = Topic + "二期" } });
        Assert.NotEqual(initial.ConfirmationToken, anotherT.ConfirmationToken);
        Assert.NotEqual(initial.ConfirmationToken, updated.ConfirmationToken);
    }
}
