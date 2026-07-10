using PrdAgent.Api.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class AsrAudioRoutePolicyTests
{
    [Theory]
    [InlineData("openai/gpt-4o-audio-preview", "openai-compatible", "google", true)]
    [InlineData("google/gemini-audio", "openrouter", "gemini", true)]
    [InlineData("google/gemini-audio", "gemini-compatible", "openai", false)]
    [InlineData("claude-audio", "anthropic", "openai", false)]
    [InlineData("qwen-audio", "exchange", "openai", false)]
    public void ShouldUseChatAudio_WhenProtocolPresent_ShouldUseProtocolBeforePlatform(
        string model,
        string protocol,
        string platformType,
        bool expected)
    {
        AsrAudioRoutePolicy.ShouldUseChatAudio(model, protocol, platformType).ShouldBe(expected);
    }

    [Theory]
    [InlineData("openai/gpt-4o-audio-preview", null, "openai", true)]
    [InlineData("openai/gpt-4o-audio-preview", "unknown", "openai", true)]
    [InlineData("openai/gpt-4o-audio-preview", null, "google", false)]
    [InlineData("whisper-large-v3", null, "openai", false)]
    [InlineData("gpt-4o", null, "openai", false)]
    public void ShouldUseChatAudio_WhenProtocolMissing_ShouldFallbackToLegacyPlatformGate(
        string model,
        string? protocol,
        string platformType,
        bool expected)
    {
        AsrAudioRoutePolicy.ShouldUseChatAudio(model, protocol, platformType).ShouldBe(expected);
    }
}
