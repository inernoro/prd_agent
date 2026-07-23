using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Asr;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using System.Threading.Channels;
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
    public void BatchCandidatePolicy_ShouldExcludeStreamAndKeepThreeUniqueFallbacks()
    {
        var automatic = Candidate("p1", "openai/gpt-audio", "passthrough");
        automatic.RetryCandidates =
        [
            Candidate("p1", "openai/gpt-audio", "passthrough"),
            Candidate("p2", "doubao-asr-stream", "doubao-asr-stream"),
            Candidate("p3", "whisper-large-v3", "passthrough"),
            Candidate("p4", "doubao-asr-bigmodel", "doubao-asr"),
            Candidate("p5", "fourth-batch", "passthrough"),
        ];

        var selected = LiveAsrBatchFallbackService.SelectBatchCandidates(automatic);

        selected.Select(x => x.ActualModel)
            .ShouldBe(["openai/gpt-audio", "whisper-large-v3", "doubao-asr-bigmodel"]);
    }

    [Fact]
    public void BatchFallbackWave_ShouldPadShortPcmToProviderMinimum()
    {
        var pcm = new byte[] { 1, 2, 3, 4 };

        var wave = LiveAsrBatchFallbackService.EncodeWave(
            pcm,
            LiveAsrBatchFallbackService.MinimumProviderSeconds);

        wave.Length.ShouldBe(
            44
            + LiveAsrBatchFallbackService.SampleRate
            * LiveAsrBatchFallbackService.BytesPerSample
            * LiveAsrBatchFallbackService.MinimumProviderSeconds);
        System.Text.Encoding.ASCII.GetString(wave, 0, 4).ShouldBe("RIFF");
        System.Text.Encoding.ASCII.GetString(wave, 8, 4).ShouldBe("WAVE");
        wave[44..48].ShouldBe(pcm);
        wave[^1].ShouldBe((byte)0);
    }

    [Fact]
    public void BatchFallbackSpeechGate_ShouldRejectSilenceAndKeepAudiblePcm()
    {
        LiveAsrBatchFallbackService.HasLikelySpeech(
                new byte[LiveAsrBatchFallbackService.WindowBytes])
            .ShouldBeFalse();

        var audible = new byte[LiveAsrBatchFallbackService.WindowBytes];
        for (var offset = 0; offset < audible.Length / 50; offset += 2)
        {
            audible[offset] = 0;
            audible[offset + 1] = 1;
        }
        LiveAsrBatchFallbackService.HasLikelySpeech(audible).ShouldBeTrue();
    }

    [Theory]
    [InlineData("""{"text":"第一段"}""", "第一段")]
    [InlineData("""{"result":{"text":"第二段"}}""", "第二段")]
    [InlineData("""{"choices":[{"message":{"content":"第三段"}}]}""", "第三段")]
    public void BatchFallbackResponse_ShouldNormalizeSupportedTextShapes(string json, string expected)
    {
        LiveAsrBatchFallbackService.ExtractText(json).ShouldBe(expected);
    }

    [Theory]
    [InlineData("好的，请提供音频，我将为您逐字转写。", true)]
    [InlineData("好的，请将音频上传后，我会立即开始转写。", true)]
    [InlineData("我会立即开始转写这段音频。", true)]
    [InlineData("Please upload the audio and I will transcribe it.", true)]
    [InlineData("他说请播放音频，然后会议就开始了。", false)]
    [InlineData("我会把音频发给同事，请他帮我转写。", false)]
    [InlineData("我认为跑步最重要的是身体健康。", false)]
    public void BatchFallbackResponse_ShouldRejectAssistantReplies(string text, bool expected)
    {
        LiveAsrBatchFallbackService.LooksLikeAssistantReply(text).ShouldBe(expected);
    }

    [Fact]
    public async Task BatchFallback_ShouldEmitPartialAndFinalDuringRecording()
    {
        var candidate = new ModelResolutionResult
        {
            Success = true,
            ActualPlatformId = "openrouter",
            ActualPlatformName = "OpenRouter",
            ActualModel = "openai/gpt-audio",
            PlatformType = "openai",
            Protocol = "openrouter",
        };
        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(x => x.SendRawWithResolutionAsync(
                It.IsAny<GatewayRawRequest>(),
                It.IsAny<GatewayModelResolution>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = """{"choices":[{"message":{"content":"我认为跑步最重要的是身体健康"}}]}""",
            });
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(x => x.RecordSuccessAsync(
                It.IsAny<ModelResolutionResult>(),
                It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        var service = new LiveAsrBatchFallbackService(
            gateway.Object,
            resolver.Object,
            NullLogger<LiveAsrBatchFallbackService>.Instance);
        var frames = Channel.CreateUnbounded<LiveAsrAudioFrame>();
        await frames.Writer.WriteAsync(new LiveAsrAudioFrame(
            1,
            Enumerable.Repeat((byte)1, LiveAsrBatchFallbackService.WindowBytes).ToArray()));
        await frames.Writer.WriteAsync(new LiveAsrAudioFrame(2, [], IsFinal: true));
        frames.Writer.TryComplete();
        var events = new List<LiveAsrEvent>();

        var result = await service.TranscribeAsync(
            [candidate],
            frames.Reader,
            evt =>
            {
                events.Add(evt);
                return Task.CompletedTask;
            });

        result.Completed.ShouldBeTrue();
        result.Transcript.ShouldContain("身体健康");
        events.ShouldContain(evt => evt.Type == LiveAsrEventTypes.Partial && evt.Stable);
        events.ShouldContain(evt => evt.Type == LiveAsrEventTypes.Final && evt.Stable);
        gateway.Verify(x => x.SendRawWithResolutionAsync(
            It.Is<GatewayRawRequest>(request =>
                request.EndpointPath == "/v1/chat/completions"
                && request.RequestBody != null),
            It.IsAny<GatewayModelResolution>(),
            It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task BatchFallback_ShouldSkipSilentWindowWithoutProviderCall()
    {
        var candidate = BatchCandidate("primary", "openai/gpt-audio");
        var gateway = new Mock<ILlmGateway>();
        var service = new LiveAsrBatchFallbackService(
            gateway.Object,
            HealthyResolver().Object,
            NullLogger<LiveAsrBatchFallbackService>.Instance);
        var frames = Channel.CreateUnbounded<LiveAsrAudioFrame>();
        await frames.Writer.WriteAsync(new LiveAsrAudioFrame(
            1,
            new byte[LiveAsrBatchFallbackService.WindowBytes]));
        await frames.Writer.WriteAsync(new LiveAsrAudioFrame(2, [], IsFinal: true));
        frames.Writer.TryComplete();

        var result = await service.TranscribeAsync(
            [candidate],
            frames.Reader,
            _ => Task.CompletedTask);

        result.Completed.ShouldBeFalse();
        result.Degraded.ShouldBeTrue();
        result.Error.ShouldBe("没有识别到有效语音");
        gateway.Verify(x => x.SendRawWithResolutionAsync(
            It.IsAny<GatewayRawRequest>(),
            It.IsAny<GatewayModelResolution>(),
            It.IsAny<CancellationToken>()), Times.Never);
    }

    [Fact]
    public async Task BatchFallback_ShouldKeepBoundedWindowsForLongRecording()
    {
        var candidate = BatchCandidate("primary", "openai/gpt-audio");
        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(x => x.SendRawWithResolutionAsync(
                It.IsAny<GatewayRawRequest>(),
                It.IsAny<GatewayModelResolution>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = """{"text":"窗口原文"}""",
            });
        var resolver = HealthyResolver();
        var service = new LiveAsrBatchFallbackService(
            gateway.Object,
            resolver.Object,
            NullLogger<LiveAsrBatchFallbackService>.Instance);
        var frames = Channel.CreateUnbounded<LiveAsrAudioFrame>();
        for (var index = 1; index <= 12; index++)
        {
            var audible = new byte[LiveAsrBatchFallbackService.WindowBytes];
            for (var offset = 0; offset < audible.Length / 50; offset += 2)
            {
                audible[offset] = 0;
                audible[offset + 1] = 1;
            }
            await frames.Writer.WriteAsync(new LiveAsrAudioFrame(
                index,
                audible));
        }
        await frames.Writer.WriteAsync(new LiveAsrAudioFrame(13, [], IsFinal: true));
        frames.Writer.TryComplete();

        var result = await service.TranscribeAsync(
            [candidate],
            frames.Reader,
            _ => Task.CompletedTask);

        result.Completed.ShouldBeTrue();
        result.Transcript.Split("窗口原文").Length.ShouldBe(13);
        gateway.Verify(x => x.SendRawWithResolutionAsync(
            It.IsAny<GatewayRawRequest>(),
            It.IsAny<GatewayModelResolution>(),
            It.IsAny<CancellationToken>()), Times.Exactly(12));
    }

    [Fact]
    public async Task BatchFallback_ShouldSwitchCandidateWhenFirstProviderFails()
    {
        var first = BatchCandidate("first", "first-audio");
        var second = BatchCandidate("second", "second-audio");
        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(x => x.SendRawWithResolutionAsync(
                It.IsAny<GatewayRawRequest>(),
                It.IsAny<GatewayModelResolution>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync((
                GatewayRawRequest _,
                GatewayModelResolution resolution,
                CancellationToken _) =>
                resolution.ActualModel == "first-audio"
                    ? GatewayRawResponse.Fail("PROVIDER_FAILED", "首选供应商失败", 503)
                    : new GatewayRawResponse
                    {
                        Success = true,
                        StatusCode = 200,
                        Content = """{"text":"备用供应商成功"}""",
                    });
        var resolver = HealthyResolver();
        var service = new LiveAsrBatchFallbackService(
            gateway.Object,
            resolver.Object,
            NullLogger<LiveAsrBatchFallbackService>.Instance);
        var frames = Channel.CreateUnbounded<LiveAsrAudioFrame>();
        await frames.Writer.WriteAsync(new LiveAsrAudioFrame(
            1,
            Enumerable.Repeat((byte)1, LiveAsrBatchFallbackService.WindowBytes).ToArray()));
        await frames.Writer.WriteAsync(new LiveAsrAudioFrame(2, [], IsFinal: true));
        frames.Writer.TryComplete();

        var result = await service.TranscribeAsync(
            [first, second],
            frames.Reader,
            _ => Task.CompletedTask);

        result.Completed.ShouldBeTrue();
        result.Transcript.ShouldBe("备用供应商成功");
        resolver.Verify(x => x.RecordFailureAsync(
            It.Is<ModelResolutionResult>(item => item.ActualPlatformId == "first"),
            It.IsAny<CancellationToken>()), Times.Once);
        resolver.Verify(x => x.RecordSuccessAsync(
            It.Is<ModelResolutionResult>(item => item.ActualPlatformId == "second"),
            It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task BatchFallback_ShouldRetryWhenProviderReturnsAssistantReply()
    {
        var candidate = BatchCandidate("primary", "openai/gpt-audio");
        var gateway = new Mock<ILlmGateway>();
        gateway.SetupSequence(x => x.SendRawWithResolutionAsync(
                It.IsAny<GatewayRawRequest>(),
                It.IsAny<GatewayModelResolution>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = """{"text":"好的，请提供音频，我将为您转写。"}""",
            })
            .ReturnsAsync(new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = """{"text":"我认为跑步最重要的是身体健康。"}""",
            });
        var service = new LiveAsrBatchFallbackService(
            gateway.Object,
            HealthyResolver().Object,
            NullLogger<LiveAsrBatchFallbackService>.Instance);
        var frames = Channel.CreateUnbounded<LiveAsrAudioFrame>();
        await frames.Writer.WriteAsync(new LiveAsrAudioFrame(
            1,
            Enumerable.Repeat((byte)1, LiveAsrBatchFallbackService.WindowBytes).ToArray()));
        await frames.Writer.WriteAsync(new LiveAsrAudioFrame(2, [], IsFinal: true));
        frames.Writer.TryComplete();

        var result = await service.TranscribeAsync(
            [candidate],
            frames.Reader,
            _ => Task.CompletedTask);

        result.Completed.ShouldBeTrue();
        result.Transcript.ShouldContain("身体健康");
        gateway.Verify(x => x.SendRawWithResolutionAsync(
            It.IsAny<GatewayRawRequest>(),
            It.IsAny<GatewayModelResolution>(),
            It.IsAny<CancellationToken>()), Times.Exactly(2));
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

    private static ModelResolutionResult BatchCandidate(string platform, string model)
        => new()
        {
            Success = true,
            ActualPlatformId = platform,
            ActualPlatformName = platform,
            ActualModel = model,
            PlatformType = "openai",
            Protocol = "openrouter",
        };

    private static Mock<IModelResolver> HealthyResolver()
    {
        var resolver = new Mock<IModelResolver>();
        resolver.Setup(x => x.RecordSuccessAsync(
                It.IsAny<ModelResolutionResult>(),
                It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        resolver.Setup(x => x.RecordFailureAsync(
                It.IsAny<ModelResolutionResult>(),
                It.IsAny<CancellationToken>()))
            .Returns(Task.CompletedTask);
        return resolver;
    }
}
