using PrdAgent.Infrastructure.LLM;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

[Trait("Category", TestCategories.CI)]
[Trait("Category", TestCategories.Unit)]
public class OpenAICompatUrlTests
{
    [Theory]
    // 规则一：以 "/" 结尾 —— 忽略 v1，自动拼接能力路径
    [InlineData("https://api.openai.com/", "chat/completions", "https://api.openai.com/chat/completions")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/", "chat/completions", "https://ark.cn-beijing.volces.com/api/v3/chat/completions")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/", "models", "https://ark.cn-beijing.volces.com/api/v3/models")]
    // 规则二：以 "#" 结尾 —— 强制使用原地址（不做任何拼接）
    [InlineData("https://api.openai.com/v1/chat/completions#", "chat/completions", "https://api.openai.com/v1/chat/completions")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3/chat/completions#", "chat/completions", "https://ark.cn-beijing.volces.com/api/v3/chat/completions")]
    [InlineData("http://localhost:3000/openai#", "chat/completions", "http://localhost:3000/openai")]
    // 规则三：其他情况 —— 默认拼接 "/v1/{capabilityPath}"
    [InlineData("https://api.openai.com", "chat/completions", "https://api.openai.com/v1/chat/completions")]
    [InlineData("https://ark.cn-beijing.volces.com/api", "chat/completions", "https://ark.cn-beijing.volces.com/api/v1/chat/completions")]
    // 边界补充：未以 / 结尾且包含版本段时，会出现 .../v3/v1/...（按规则保留）
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "chat/completions", "https://ark.cn-beijing.volces.com/api/v3/v1/chat/completions")]
    [InlineData("https://ark.cn-beijing.volces.com/api/v3", "models", "https://ark.cn-beijing.volces.com/api/v3/v1/models")]
    public void BuildEndpoint_ShouldFollowRules(string baseUrl, string capabilityPath, string expected)
    {
        var actual = OpenAICompatUrl.BuildEndpoint(baseUrl, capabilityPath);
        Assert.Equal(expected, actual);
    }
}


