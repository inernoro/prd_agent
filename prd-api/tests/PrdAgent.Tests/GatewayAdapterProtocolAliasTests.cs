using PrdAgent.Infrastructure.LlmGateway;
using Xunit;

namespace PrdAgent.Tests;

public class GatewayAdapterProtocolAliasTests
{
    [Theory]
    [InlineData("claude", "claude")]
    [InlineData("anthropic", "claude")]
    [InlineData("claude-compatible", "claude")]
    [InlineData("openai", "openai")]
    [InlineData("openai-compatible", "openai")]
    [InlineData("openrouter", "openai")]
    [InlineData("gemini-compatible", "openai")]
    [InlineData("unknown", null)]
    [InlineData("", null)]
    public void NormalizeAdapterKey_ShouldMapProtocolAliasesToRegisteredAdapters(string protocol, string? expected)
    {
        Assert.Equal(expected, LlmGateway.NormalizeAdapterKey(protocol));
    }
}
