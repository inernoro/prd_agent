using System.Diagnostics;
using Microsoft.Extensions.Configuration;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class AsrAudioRoutePolicyTests
{
    [Fact]
    public void SelectCandidates_ShouldUsePrecomputedDistinctFallbacksInOrder()
    {
        var duplicate = new ModelResolutionResult
        {
            Success = true,
            OfferingId = "offering-primary",
            ActualModel = "primary",
        };
        var backup = new ModelResolutionResult
        {
            Success = true,
            OfferingId = "offering-backup",
            ActualModel = "backup",
        };
        var primary = new ModelResolutionResult
        {
            Success = true,
            OfferingId = "offering-primary",
            ActualModel = "primary",
            RetryCandidates = [duplicate, backup],
        };

        var candidates = TranscriptAsrCandidatePolicy.SelectCandidates(primary);

        candidates.Select(candidate => candidate.ActualModel)
            .ShouldBe(new[] { "primary", "backup" });
        TranscriptAsrCandidatePolicy.ChatValidationAttemptsPerCandidate.ShouldBe(4);
    }

    [Theory]
    [InlineData(null, 1800, 1680)]
    [InlineData(300, 300, 180)]
    [InlineData(9999, 7200, 7080)]
    public void AsrProcessingDeadline_AlwaysEndsBeforeTheWatchdog(
        int? configuredSeconds,
        int expectedWatchdogSeconds,
        int expectedAsrSeconds)
    {
        var values = new Dictionary<string, string?>();
        if (configuredSeconds.HasValue)
            values[TranscriptRunTimingPolicy.WatchdogTimeoutKey] = configuredSeconds.Value.ToString();
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();

        TranscriptRunTimingPolicy.ResolveWatchdogTimeout(configuration).TotalSeconds
            .ShouldBe(expectedWatchdogSeconds);
        TranscriptRunTimingPolicy.ResolveAsrProcessingDeadline(configuration).TotalSeconds
            .ShouldBe(expectedAsrSeconds);
        TranscriptRunTimingPolicy.ResolveAsrProcessingDeadline(configuration)
            .ShouldBeLessThan(TranscriptRunTimingPolicy.ResolveWatchdogTimeout(configuration));
    }

    [Fact]
    public void ConfigureFfmpegArguments_ShouldPadShortClipsWithoutTruncatingLongAudio()
    {
        var startInfo = new ProcessStartInfo();

        AsrAudioNormalizationPolicy.ConfigureFfmpegArguments(
            startInfo.ArgumentList,
            "/tmp/source.m4a",
            "/tmp/normalized.wav");

        startInfo.ArgumentList.ShouldContain("-af");
        startInfo.ArgumentList.ShouldContain("apad=whole_dur=15");
        startInfo.ArgumentList.ShouldNotContain("-t");
        startInfo.ArgumentList.ShouldNotContain("-shortest");
        startInfo.ArgumentList[^1].ShouldBe("/tmp/normalized.wav");
        AsrAudioNormalizationPolicy.MinimumDurationSeconds.ShouldBe(15);
    }

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
