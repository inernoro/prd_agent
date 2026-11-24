using PrdAgent.Api.Controllers.Api;
using PrdAgent.Api.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductVersionImportFingerprintTests
{
    [Fact]
    public void SameRowIgnoresLegacyDictionaryInsertionOrder()
    {
        var first = new ImportVersionWorkflowRow
        {
            PlanName = "方案 A", AppName = "应用 A",
            LegacyData = new Dictionary<string, string> { ["产品负责人"] = "张三", ["需求来源"] = "内部" },
        };
        var repeated = new ImportVersionWorkflowRow
        {
            PlanName = "方案 A", AppName = "应用 A",
            LegacyData = new Dictionary<string, string> { ["需求来源"] = "内部", ["产品负责人"] = "张三" },
        };

        Assert.Equal(ProductVersionImportFingerprint.Compute("p1", first),
            ProductVersionImportFingerprint.Compute("p1", repeated));
        Assert.NotEqual(ProductVersionImportFingerprint.Compute("p1", first),
            ProductVersionImportFingerprint.Compute("p2", repeated));
    }
}
