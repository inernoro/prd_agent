using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;

namespace PrdAgent.Tests;

public class ProductImportProductRoutingTests
{
    private static Product P(string id, string name) => new()
    {
        Id = id,
        Name = name,
        ProductNo = id,
    };

    [Fact]
    public void ResolveProductId_prefers_应用_in_source_fields()
    {
        var products = new List<Product> { P("p1", "互动营销"), P("p2", "DCRM") };
        var (productId, label, matched) = ProductImportProductRouting.ResolveProductId(
            products,
            "【绿业元】某需求",
            new Dictionary<string, string> { ["应用"] = "DCRM" },
            "fallback");

        Assert.Equal("p2", productId);
        Assert.Equal("DCRM", label);
        Assert.True(matched);
    }

    [Fact]
    public void ResolveProductLabelFromVersionRow_uses_appName_first()
    {
        var label = ProductImportProductRouting.ResolveProductLabelFromVersionRow(
            "互动营销",
            "大数据引擎系统",
            new Dictionary<string, string> { ["产品"] = "互动营销" });
        Assert.Equal("互动营销", label);
    }
}
