using Microsoft.AspNetCore.Http;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Asr;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class LiveAsrProtocolTests
{
    [Fact]
    public void AudioFrame_ShouldPreserveLittleEndianSequenceAndPcm()
    {
        var payload = new byte[] { 1, 0, 0, 0, 0x34, 0x12, 0x78, 0x56 };

        var ok = LiveAsrWireProtocol.TryDecodeAudioFrame(payload, 0, out var frame, out var error);

        ok.ShouldBeTrue();
        error.ShouldBeNull();
        frame!.Sequence.ShouldBe(1);
        frame.Pcm.ShouldBe(new byte[] { 0x34, 0x12, 0x78, 0x56 });
    }

    [Theory]
    [InlineData(1, "duplicate")]
    [InlineData(3, "不连续")]
    public void AudioFrame_ShouldRejectDuplicateAndGap(int sequence, string expectedError)
    {
        var payload = new byte[] { (byte)sequence, 0, 0, 0, 0, 0 };

        var ok = LiveAsrWireProtocol.TryDecodeAudioFrame(payload, 1, out _, out var error);

        ok.ShouldBeFalse();
        error.ShouldNotBeNull();
        error!.ShouldContain(expectedError);
    }

    [Fact]
    public void AudioFrame_ShouldRejectOddPcmBytes()
    {
        var payload = new byte[] { 1, 0, 0, 0, 0 };

        LiveAsrWireProtocol.TryDecodeAudioFrame(payload, 0, out _, out var error)
            .ShouldBeFalse();
        error.ShouldNotBeNull();
        error!.ShouldContain("偶数");
    }

    [Fact]
    public void CandidatePolicy_ShouldOnlyKeepThreeUniqueStreamingCandidates()
    {
        var preferred = Candidate("p1", "m1", "doubao-asr-stream");
        preferred.RetryCandidates =
        [
            Candidate("p1", "m1", "doubao-asr-stream"),
            Candidate("p2", "m2", "doubao-asr"),
            Candidate("p3", "m3", "doubao-asr-stream"),
            Candidate("p4", "m4", "doubao-asr-stream"),
            Candidate("p5", "m5", "doubao-asr-stream"),
        ];
        var automaticBatch = Candidate("batch", "openai/gpt-audio", "passthrough");

        var selected = LiveAsrCandidatePolicy.Select(preferred, automaticBatch);

        selected.Select(x => x.ActualModel).ShouldBe(["m1", "m3", "m4"]);
    }

    [Fact]
    public void CandidatePolicy_ShouldKeepPreferredStreamWhenAutomaticPoolIsBatchOnly()
    {
        var preferred = Candidate("doubao", LiveAsrCandidatePolicy.PreferredModel, "doubao-asr-stream");
        var automaticBatch = Candidate("openrouter", "openai/gpt-audio", "passthrough");

        var selected = LiveAsrCandidatePolicy.Select(preferred, automaticBatch);

        selected.Count.ShouldBe(1);
        selected[0].ActualModel.ShouldBe(LiveAsrCandidatePolicy.PreferredModel);
    }

    [Fact]
    public void WebSocketAuth_ShouldReadTokenOnlyOnExactLiveTranscriptionSuffix()
    {
        LiveAsrWebSocketAuth.ExtractToken(
                new PathString("/api/document-store/recording-uploads/s1/live-transcription"),
                "map-live-asr, bearer.header.payload.signature")
            .ShouldBe("header.payload.signature");
        LiveAsrWebSocketAuth.ExtractToken(
                new PathString("/api/other/live"),
                "map-live-asr, bearer.secret")
            .ShouldBeNull();
    }

    [Fact]
    public void WebSocketAuth_ShouldNeverTreatApplicationProtocolAsToken()
    {
        LiveAsrWebSocketAuth.ExtractToken(
                new PathString("/api/document-store/recording-uploads/s1/live-transcription"),
                "map-live-asr")
            .ShouldBeNull();
    }

    private static ModelResolutionResult Candidate(string platform, string model, string transformer)
        => new()
        {
            Success = true,
            IsExchange = true,
            ActualPlatformId = platform,
            ActualModel = model,
            ExchangeTransformerType = transformer,
        };
}
