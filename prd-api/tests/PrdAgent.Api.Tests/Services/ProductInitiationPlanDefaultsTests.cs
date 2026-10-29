using PrdAgent.Api.Services.ProductAgent;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class ProductInitiationPlanDefaultsTests
{
    [Theory]
    [InlineData("互动营销T3.47.1（方案）", "方案.md", 1)]
    [InlineData("互动营销（方案）第二稿", "方案.md", 2)]
    [InlineData("互动营销（方案）", "方案_第2稿.docx", 2)]
    [InlineData("互动营销（方案）第三稿", "方案.md", 3)]
    [InlineData("互动营销（方案）第一稿", "方案_第二稿.md", 1)]
    [InlineData("互动营销（方案）", "方案_12稿.md", 1)]
    [InlineData(null, null, 1)]
    public void OnlyExplicitSupportedDraftMarkersChangeDefault(string? title, string? fileName, int expected)
        => Assert.Equal(expected, ProductInitiationPlanDefaults.MeetingDraftCount(title, fileName));
}
