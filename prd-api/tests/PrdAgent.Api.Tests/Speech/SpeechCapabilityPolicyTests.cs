using System.Text.Json;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using Xunit;

namespace PrdAgent.Api.Tests.Speech;

public sealed class SpeechCapabilityPolicyTests
{
    internal static SpeechProfile Profile(string protocol = "openai") => new()
    {
        Id = "future-speech-profile", Name = "未来语音能力", Enabled = true, IsDefault = true,
        Revision = 1, Protocol = protocol, ModelPoolId = "future-unconfigured-tts-model",
        Voices = new() { new() { Id = "voice-a", Name = "测试音色", Languages = new() { "zh" } } },
        DefaultVoiceId = "voice-a", Formats = new() { "mp3" }, DefaultFormat = "mp3",
        MinSpeed = 0.5, MaxSpeed = 2,
    };

    [Fact]
    public void OpenAiInstructionsAndDoubaoEmotionRemainDistinct()
    {
        var openai = Profile();
        openai.SupportsInstructions = true;
        var options = SpeechCapabilityPolicy.ResolveOptions(openai, new() { Instructions = "平缓朗读" });
        Assert.Equal("平缓朗读", options.Instructions);
        Assert.Equal("EMOTION_UNSUPPORTED", Assert.Throws<SpeechException>(() =>
            SpeechCapabilityPolicy.ResolveOptions(openai, new() { Emotion = "happy" })).Code);

        var doubao = Profile("doubao-tts");
        doubao.SupportsEmotion = true;
        doubao.Emotions = new() { "happy" };
        Assert.Equal("happy", SpeechCapabilityPolicy.ResolveOptions(doubao, new() { Emotion = "happy" }).Emotion);
        Assert.Equal("INSTRUCTIONS_UNSUPPORTED", Assert.Throws<SpeechException>(() =>
            SpeechCapabilityPolicy.ResolveOptions(doubao, new() { Instructions = "平缓朗读" })).Code);
    }

    [Fact]
    public void StaleProfileAndMissingVoiceAreRejectedWithoutFallback()
    {
        var profile = Profile();
        Assert.Equal("PROFILE_CHANGED", Assert.Throws<SpeechException>(() =>
            SpeechCapabilityPolicy.ResolveOptions(profile, new() { ProfileRevision = 2 })).Code);
        Assert.Equal("VOICE_UNAVAILABLE", Assert.Throws<SpeechException>(() =>
            SpeechCapabilityPolicy.ResolveOptions(profile, new() { VoiceId = "voice-from-another-provider" })).Code);
    }

    [Fact]
    public void ActualProtocolBoundsAndFormatsAreEnforced()
    {
        var profile = Profile("doubao-tts");
        profile.Formats.Add("wav");
        Assert.Equal("FORMAT_UNSUPPORTED", Assert.Throws<SpeechException>(() => SpeechCapabilityPolicy.ValidateProfile(profile)).Code);
        profile.Formats.Remove("wav");
        profile.MaxSpeed = 3;
        Assert.Equal("SPEED_INVALID", Assert.Throws<SpeechException>(() => SpeechCapabilityPolicy.ValidateProfile(profile)).Code);
        profile.MaxSpeed = 2;
        SpeechCapabilityPolicy.ValidateProfile(profile);
    }

    [Theory]
    [InlineData(double.NaN)]
    [InlineData(double.PositiveInfinity)]
    [InlineData(0.49)]
    [InlineData(2.01)]
    public void InvalidSpeedDoesNotGetSilentlyClamped(double speed)
        => Assert.Equal("SPEED_UNSUPPORTED", Assert.Throws<SpeechException>(() =>
            SpeechCapabilityPolicy.ResolveOptions(Profile(), new() { Speed = speed })).Code);

    [Fact]
    public void CharacterBudgetCountsUnicodeScalarsAndFingerprintCoversAudioOptions()
    {
        Assert.Equal(3, SpeechCapabilityPolicy.CountCharacters("甲\U00020000乙"));
        var first = new SpeechCreateRequest { Text = "朗读原文", ProfileId = "profile", VoiceId = "voice-a" };
        var second = new SpeechCreateRequest { Text = "朗读原文", ProfileId = "profile", VoiceId = "voice-b" };
        Assert.NotEqual(SpeechCapabilityPolicy.RequestFingerprint(first), SpeechCapabilityPolicy.RequestFingerprint(second));
    }

    [Fact]
    public void RequestBodyPreservesOriginalTextAndProviderSpecificFields()
    {
        const string original = "  原文，保留标点。\n第二行。";
        var request = SpeechCapabilityPolicy.BuildRequestBody(new()
        {
            Text = original, VoiceId = "voice-a", Format = "mp3", Speed = 1.25, Emotion = "happy",
        });
        Assert.Equal(original, request["input"]!.GetValue<string>());
        Assert.Equal("happy", request["emotion"]!.GetValue<string>());
        Assert.False(request.ContainsKey("instructions"));
    }

    [Fact]
    public void UnknownPublicOptionsCannotBeIgnored()
        => Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<SpeechCreateRequest>(
            "{\"Text\":\"原文\",\"UnrecognizedEmotionParameter\":\"happy\"}"));
}
