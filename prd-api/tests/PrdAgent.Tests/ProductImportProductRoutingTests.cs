using PrdAgent.Core.Helpers;
using PrdAgent.Core.Models;
using Xunit;

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
            new Dictionary<string, string> { ["应用"] = "DCRM" });

        Assert.Equal("p2", productId);
        Assert.Equal("DCRM", label);
        Assert.True(matched);
    }

    [Fact]
    public void ResolveProductIdByLabel_returns_null_when_no_match()
    {
        var products = new List<Product> { P("p1", "互动营销") };
        var (productId, label, matched) = ProductImportProductRouting.ResolveProductIdByLabel(products, "不存在");
        Assert.Null(productId);
        Assert.False(matched);
        Assert.Equal("不存在", label);
    }
}
