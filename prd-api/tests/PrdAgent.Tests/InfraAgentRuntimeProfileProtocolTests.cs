using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.InfraAgentSessions;
using Xunit;

namespace PrdAgent.Tests;

public class InfraAgentRuntimeProfileProtocolTests
{
    [Theory]
    [InlineData("openai-compatible", "anthropic", "https://api.anthropic.com/v1/messages", InfraAgentRuntimeProtocols.OpenAiCompatible)]
    [InlineData("openai", "anthropic", "https://api.anthropic.com/v1/messages", InfraAgentRuntimeProtocols.OpenAiCompatible)]
    [InlineData("gemini-compatible", "anthropic", "https://api.anthropic.com/v1/messages", InfraAgentRuntimeProtocols.OpenAiCompatible)]
    [InlineData("claude", "openai", "https://api.openai.com/v1", InfraAgentRuntimeProtocols.Anthropic)]
    [InlineData("anthropic", "openai", "https://api.openai.com/v1", InfraAgentRuntimeProtocols.Anthropic)]
    public void ResolveRuntimeProtocol_WhenModelProtocolKnown_ShouldOverridePlatformAndUrl(
        string modelProtocol,
        string platformType,
        string apiUrl,
        string expected)
    {
        var protocol = InfraAgentRuntimeProfileService.ResolveRuntimeProtocol(modelProtocol, platformType, apiUrl);

        Assert.Equal(expected, protocol);
    }

    [Theory]
    [InlineData(null, "anthropic", "https://api.example.com/v1", InfraAgentRuntimeProtocols.Anthropic)]
    [InlineData("", "openai", "https://gateway.example.com/anthropic/v1/messages", InfraAgentRuntimeProtocols.Anthropic)]
    [InlineData("unknown", "openai", "https://api.openai.com/v1", InfraAgentRuntimeProtocols.OpenAiCompatible)]
    public void ResolveRuntimeProtocol_WhenModelProtocolMissingOrUnknown_ShouldFallbackToLegacyInference(
        string? modelProtocol,
        string platformType,
        string apiUrl,
        string expected)
    {
        var protocol = InfraAgentRuntimeProfileService.ResolveRuntimeProtocol(modelProtocol, platformType, apiUrl);

        Assert.Equal(expected, protocol);
    }
}
