using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.CI)]
[Trait("Category", TestCategories.Unit)]
public class ModelsListStatusFilterTests
{
    [Fact]
    public void ShouldInclude_VolcesArk_Shutdown_ShouldFilterOut()
    {
        var endpoint = "https://ark.cn-beijing.volces.com/api/v3/models";
        var ok = ModelsListStatusFilter.ShouldInclude("volces", endpoint, "doubao-1-5-pro-32k", "Shutdown");
        Assert.False(ok);
    }

    [Fact]
    public void ShouldInclude_VolcesArk_Active_ShouldKeep()
    {
        var endpoint = "https://ark.cn-beijing.volces.com/api/v3/models";
        var ok = ModelsListStatusFilter.ShouldInclude("volces", endpoint, "doubao-1-5-pro-32k", "Active");
        Assert.True(ok);
    }

    [Fact]
    public void ShouldInclude_NonVolces_Shutdown_ShouldKeep()
    {
        var endpoint = "https://api.openai.com/v1/models";
        var ok = ModelsListStatusFilter.ShouldInclude("openai", endpoint, "gpt-4o", "Shutdown");
        Assert.True(ok);
    }
}


