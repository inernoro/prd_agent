using System.Reflection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Core.Services;
using PrdAgent.Infrastructure.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class SubtitleGenerationProcessorTests
{
    [Fact]
    public void CompletedLiveTranscript_ShouldBeUsed_OnlyWhenStatusAndTextAreValid()
    {
        var completed = new DocumentEntry
        {
            Metadata = new Dictionary<string, string>
            {
                ["liveTranscriptStatus"] = DocumentLiveTranscriptStatus.Completed,
                ["liveTranscript"] = "  已实时识别的原文  ",
            },
        };
        var degraded = new DocumentEntry
        {
            Metadata = new Dictionary<string, string>
            {
                ["liveTranscriptStatus"] = DocumentLiveTranscriptStatus.Degraded,
                ["liveTranscript"] = "不稳定的局部文字",
            },
        };

        SubtitleGenerationProcessor.GetCompletedLiveTranscript(completed)
            .ShouldBe("已实时识别的原文");
        SubtitleGenerationProcessor.GetCompletedLiveTranscript(degraded)
            .ShouldBeNull();
    }

    [Fact]
    public void DeferredCalibrationIntent_ShouldForceFullRecordingAudio_AfterLateLiveCompletion()
    {
        var entry = new DocumentEntry
        {
            Metadata = new Dictionary<string, string>
            {
                ["liveTranscriptStatus"] = DocumentLiveTranscriptStatus.Completed,
                ["liveTranscript"] = "晚到但可能不完整的实时原文",
                [DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey] = "true",
            },
        };

        SubtitleGenerationProcessor.GetCompletedLiveTranscript(entry)
            .ShouldBe("晚到但可能不完整的实时原文");
        SubtitleGenerationProcessor.RequiresFullRecordingAudio(entry)
            .ShouldBeTrue();
        SubtitleGenerationProcessor.GetPreferredLiveTranscriptForTranscription(entry)
            .ShouldBeNull();

        entry.Metadata[DocumentRecordingArchiveWorker.DeferredTranscriptionRequiredMetadataKey] =
            "false";
        SubtitleGenerationProcessor.RequiresFullRecordingAudio(entry)
            .ShouldBeFalse();
        SubtitleGenerationProcessor.GetPreferredLiveTranscriptForTranscription(entry)
            .ShouldBe("晚到但可能不完整的实时原文");
    }

    [Fact]
    public async Task MissingArchivedAudio_ShouldUseProviderNeutralFailureMessage()
    {
        var processor = BuildProcessor(Mock.Of<ILlmGateway>());
        var method = typeof(SubtitleGenerationProcessor).GetMethod(
            "TranscribeAudioOrVideoAsync",
            BindingFlags.Instance | BindingFlags.NonPublic);

        method.ShouldNotBeNull();
        var task = (Task<List<SubtitleSegment>>)method.Invoke(
            processor,
            new object?[] { BuildRun(), null, null, null, false, null })!;

        var exception = await Should.ThrowAsync<InvalidOperationException>(() => task);
        exception.Message.ShouldBe("源文件 URL 不可用（可能尚未归档到对象存储）");
        exception.Message.ShouldNotContain("COS");
    }

    [Fact]
    public async Task DoubaoAsyncAsr_ShouldSendAudioDataJson_NotMultipart()
    {
        GatewayRawRequest? capturedRequest = null;
        GatewayModelResolution? capturedResolution = null;
        var audioBytes = new byte[] { 1, 2, 3, 4, 5 };

        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(g => g.SendRawWithResolutionAsync(
                It.IsAny<GatewayRawRequest>(),
                It.IsAny<GatewayModelResolution>(),
                It.IsAny<CancellationToken>()))
            .Callback<GatewayRawRequest, GatewayModelResolution, CancellationToken>((request, resolution, _) =>
            {
                capturedRequest = request;
                capturedResolution = resolution;
            })
            .ReturnsAsync(new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = """
                          {
                            "text": "第一句字幕",
                            "segments": [
                              { "start": 1.0, "end": 2.5, "text": "第一句字幕", "speaker": "0" }
                            ]
                          }
                          """
            });

        var processor = new SubtitleGenerationProcessor(
            modelResolver: Mock.Of<IModelResolver>(),
            llmGateway: gateway.Object,
            documentService: Mock.Of<IDocumentService>(),
            httpClientFactory: Mock.Of<IHttpClientFactory>(),
            llmCtx: new LLMRequestContextAccessor(),
            // 本用例只走 ASR 分发，不触及「换个整理方式」写回路径；
            // ContentReprocessApplyService 是具体类且携带多层依赖，此处置空即可
            applyService: null!,
            logger: NullLogger<SubtitleGenerationProcessor>.Instance);

        var resolution = new ModelResolutionResult
        {
            Success = true,
            ResolutionType = "DedicatedPool",
            ActualModel = "doubao-asr-bigmodel",
            ActualPlatformId = "exchange-doubao-asr",
            ActualPlatformName = "Exchange:Doubao ASR",
            PlatformType = "exchange",
            IsExchange = true,
            ExchangeName = "Doubao ASR",
            ExchangeTransformerType = "doubao-asr",
            ApiUrl = "https://example.test/asr",
            ApiKey = "test-key"
        };
        var run = new DocumentStoreAgentRun
        {
            Id = "run-1",
            UserId = "user-1",
            SourceEntryId = "entry-1"
        };

        var method = typeof(SubtitleGenerationProcessor).GetMethod(
            "TranscribeViaDoubaoAsyncJsonAsync",
            BindingFlags.Instance | BindingFlags.NonPublic);

        method.ShouldNotBeNull();
        var task = (Task<List<SubtitleSegment>>)method.Invoke(
            processor,
            new object[]
            {
                run,
                audioBytes,
                resolution,
                AppCallerRegistry.TranscriptAgent.Transcribe.Audio,
            })!;

        var segments = await task;

        capturedRequest.ShouldNotBeNull();
        capturedResolution.ShouldNotBeNull();
        capturedRequest.AppCallerCode.ShouldBe(AppCallerRegistry.TranscriptAgent.Transcribe.Audio);
        capturedRequest.IsMultipart.ShouldBeFalse();
        capturedRequest.MultipartFiles.ShouldBeNull();
        capturedRequest.MultipartFields.ShouldBeNull();
        capturedRequest.RequestBody.ShouldNotBeNull();
        capturedRequest.RequestBody["audio_data"]!.GetValue<string>()
            .ShouldBe(Convert.ToBase64String(audioBytes));
        capturedRequest.Context!.UserId.ShouldBe("user-1");
        capturedResolution.IsExchange.ShouldBeTrue();
        capturedResolution.ExchangeTransformerType.ShouldBe("doubao-asr");

        segments.Count.ShouldBe(1);
        segments[0].StartSec.ShouldBe(1);
        segments[0].EndSec.ShouldBe(2.5);
        segments[0].Text.ShouldBe("第一句字幕");
        segments[0].SpeakerId.ShouldBe("0");
    }

    [Fact]
    public void ChatAudioSpeakerSegments_ShouldPreserveStableSpeakersAndUnlabeledContinuation()
    {
        var segments = SubtitleGenerationProcessor.ParseChatAudioSpeakerSegments("""
            [说话人1] 我们有多年行业经验。
            并且有丰富的营销策略。
            说话人2：只要交付质量达标，价格合理。
            [说话人1] 周五前提供实施计划。
            """);

        segments.Count.ShouldBe(3);
        segments[0].SpeakerId.ShouldBe("说话人1");
        segments[0].Text.ShouldBe("我们有多年行业经验。 并且有丰富的营销策略。");
        segments[1].SpeakerId.ShouldBe("说话人2");
        segments[2].SpeakerId.ShouldBe("说话人1");

        var note = SubtitleFormatter.FormatTranscriptNote("meeting.m4a", string.Empty, segments);
        note.ShouldContain("[说话人1] 我们有多年行业经验。");
        note.ShouldContain("[说话人2] 只要交付质量达标，价格合理。");
    }

    [Fact]
    public void ChatAudioSpeakerSegments_ShouldLabelProviderFallbackAsSpeakerOne()
    {
        var segments = SubtitleGenerationProcessor.ParseChatAudioSpeakerSegments("只有一位说话人的原文");

        segments.Count.ShouldBe(1);
        segments[0].SpeakerId.ShouldBe("说话人1");
    }

    [Fact]
    public async Task ChatAudio_ShouldRetryOneFalseNoSpeechResult_WithFullAudio()
    {
        var requests = new List<GatewayRawRequest>();
        var responses = new Queue<GatewayRawResponse>(
        [
            new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = "{\"choices\":[{\"message\":{\"content\":\"NO_SPEECH\"}}]}",
            },
            new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = "{\"choices\":[{\"message\":{\"content\":\"米多有多年行业经验。当前报价合理。\"}}]}",
            },
            new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = "{\"choices\":[{\"message\":{\"content\":\"[说话人1] 米多有多年行业经验。\\n[说话人2] 当前报价合理。\"}}]}",
            },
        ]);
        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(g => g.SendRawWithResolutionAsync(
                It.IsAny<GatewayRawRequest>(),
                It.IsAny<GatewayModelResolution>(),
                It.IsAny<CancellationToken>()))
            .Callback<GatewayRawRequest, GatewayModelResolution, CancellationToken>((request, _, _) => requests.Add(request))
            .ReturnsAsync(() => responses.Dequeue());

        var processor = BuildProcessor(gateway.Object);
        var method = typeof(SubtitleGenerationProcessor).GetMethod(
            "TranscribeViaChatAudioAsync",
            BindingFlags.Instance | BindingFlags.NonPublic);
        var audioBytes = new byte[] { 1, 2, 3, 4 };
        var task = (Task<List<SubtitleSegment>>)method!.Invoke(
            processor,
            new object[]
            {
                BuildRun(),
                audioBytes,
                new GatewayModelResolution { ActualModel = "openai/gpt-audio" },
                AppCallerRegistry.TranscriptAgent.Transcribe.Audio,
            })!;

        var segments = await task;

        segments.Select(segment => segment.SpeakerId).ShouldBe(["说话人1", "说话人2"]);
        requests.Count.ShouldBe(3);
        requests[0].RequestBody!["temperature"]!.GetValue<int>().ShouldBe(0);
        requests[1].RequestBody!["messages"]![0]!["content"]![0]!["text"]!
            .GetValue<string>().ShouldContain("上一次识别可能误判为无人声");
        requests[2].RequestBody!["messages"]![0]!["content"]![0]!["text"]!
            .GetValue<string>().ShouldContain("粗转原文如下");
        foreach (var request in requests)
        {
            request.AppCallerCode.ShouldBe(AppCallerRegistry.TranscriptAgent.Transcribe.Audio);
            request.RequestBody!.ToJsonString().ShouldContain(Convert.ToBase64String(audioBytes));
        }
    }

    [Fact]
    public async Task ChatAudio_ShouldKeepConfirmedTranscript_WhenDiarizationFails()
    {
        var gateway = new Mock<ILlmGateway>();
        gateway.SetupSequence(g => g.SendRawWithResolutionAsync(
                It.IsAny<GatewayRawRequest>(),
                It.IsAny<GatewayModelResolution>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = "{\"choices\":[{\"message\":{\"content\":\"已经确认的完整原文\"}}]}",
            })
            .ReturnsAsync(new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = "{\"choices\":[{\"message\":{\"content\":\"无法区分\"}}]}",
            });

        var processor = BuildProcessor(gateway.Object);
        var method = typeof(SubtitleGenerationProcessor).GetMethod(
            "TranscribeViaChatAudioAsync",
            BindingFlags.Instance | BindingFlags.NonPublic);
        var task = (Task<List<SubtitleSegment>>)method!.Invoke(
            processor,
            new object[]
            {
                BuildRun(),
                new byte[] { 1, 2, 3 },
                new GatewayModelResolution { ActualModel = "openai/gpt-audio" },
                AppCallerRegistry.TranscriptAgent.Transcribe.Audio,
            })!;

        var segments = await task;

        segments.Count.ShouldBe(1);
        segments[0].Text.ShouldBe("已经确认的完整原文");
        segments[0].SpeakerId.ShouldBe("说话人1");
    }

    [Fact]
    public async Task DoubaoAsyncAsr_EmptyNormalizedResponse_ShouldKeepSpecificFailure()
    {
        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(g => g.SendRawWithResolutionAsync(
                It.IsAny<GatewayRawRequest>(),
                It.IsAny<GatewayModelResolution>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync(new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = "{\"text\":\"\",\"segments\":[]}",
            });
        var processor = BuildProcessor(gateway.Object);
        var method = typeof(SubtitleGenerationProcessor).GetMethod(
            "TranscribeViaDoubaoAsyncJsonAsync",
            BindingFlags.Instance | BindingFlags.NonPublic);

        var task = (Task<List<SubtitleSegment>>)method!.Invoke(
            processor,
            new object[]
            {
                BuildRun(),
                new byte[] { 1, 2, 3 },
                BuildDoubaoResolution(),
                AppCallerRegistry.TranscriptAgent.Transcribe.Audio,
            })!;

        var exception = await Should.ThrowAsync<SubtitleAsrException>(() => task);
        exception.Message.ShouldContain("豆包异步 ASR 返回为空");
        exception.Diagnostic["responseSnippet"].ShouldBe("{\"text\":\"\",\"segments\":[]}");
    }

    [Fact]
    public async Task AsrFallback_ShouldSwitchToNextCandidate_WhenPrimaryReturnsEmptyContent()
    {
        var gateway = new Mock<ILlmGateway>();
        gateway.Setup(g => g.SendRawWithResolutionAsync(
                It.IsAny<GatewayRawRequest>(),
                It.IsAny<GatewayModelResolution>(),
                It.IsAny<CancellationToken>()))
            .ReturnsAsync((
                GatewayRawRequest _,
                GatewayModelResolution resolution,
                CancellationToken _) => new GatewayRawResponse
            {
                Success = true,
                StatusCode = 200,
                Content = resolution.ActualModel == "doubao-asr-bigmodel"
                    ? "{\"text\":\"\",\"segments\":[]}"
                    : "{\"text\":\"备用 Whisper 识别成功\"}",
            });

        var primary = BuildDoubaoResolution();
        primary.RetryCandidates =
        [
            new ModelResolutionResult
            {
                Success = true,
                ResolutionType = "DedicatedPool",
                ActualModel = "whisper-large-v3",
                ActualPlatformId = "whisper-provider",
                ActualPlatformName = "Whisper Provider",
                PlatformType = "openai",
                Protocol = "openai",
                ApiUrl = "https://example.test/v1",
                ApiKey = "test-key",
            },
        ];

        var attempts = new List<(int Attempt, int Total)>();
        Func<int, int, Task> onAttempt = (attempt, total) =>
        {
            attempts.Add((attempt, total));
            return Task.CompletedTask;
        };
        var processor = BuildProcessor(gateway.Object);
        var method = typeof(SubtitleGenerationProcessor).GetMethod(
            "TranscribeWithFallbackAsync",
            BindingFlags.Instance | BindingFlags.NonPublic);

        var task = (Task<List<SubtitleSegment>>)method!.Invoke(
            processor,
            new object?[] { BuildRun(), new byte[] { 1, 2, 3 }, primary, onAttempt })!;

        var segments = await task;

        segments.Count.ShouldBe(1);
        segments[0].Text.ShouldBe("备用 Whisper 识别成功");
        attempts.ShouldBe([(1, 2), (2, 2)]);
        gateway.Verify(g => g.SendRawWithResolutionAsync(
            It.IsAny<GatewayRawRequest>(),
            It.IsAny<GatewayModelResolution>(),
            It.IsAny<CancellationToken>()), Times.Exactly(2));
    }

    [Fact]
    public void RecordingAsrCandidates_ShouldPreferNativeSpeakerInformation_AndKeepPoolFallbackOrder()
    {
        var chatAudio = new ModelResolutionResult
        {
            Success = true,
            ActualModel = "openai/gpt-audio",
            ActualPlatformId = "openrouter",
        };
        var doubaoStream = new ModelResolutionResult
        {
            Success = true,
            ActualModel = "doubao-asr-stream",
            ActualPlatformId = "doubao-stream",
            IsExchange = true,
            ExchangeTransformerType = "doubao-asr-stream",
        };
        var whisper = new ModelResolutionResult
        {
            Success = true,
            ActualModel = "whisper-large-v3",
            ActualPlatformId = "whisper",
        };

        var ordered = SubtitleGenerationProcessor.OrderRecordingAsrCandidates(
            [chatAudio, doubaoStream, whisper]).ToList();

        ordered.Select(candidate => candidate.ActualModel)
            .ShouldBe(["doubao-asr-stream", "openai/gpt-audio", "whisper-large-v3"]);
    }

    [Fact]
    public void RecordingAsrCallerChain_ShouldTryDedicatedTranscriptionBeforeGenericSubtitle()
    {
        SubtitleGenerationProcessor.RecordingAsrCallerChain.ShouldBe(
        [
            AppCallerRegistry.TranscriptAgent.Transcribe.Audio,
            AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
        ]);
    }

    private static SubtitleGenerationProcessor BuildProcessor(ILlmGateway gateway)
        => new(
            modelResolver: Mock.Of<IModelResolver>(),
            llmGateway: gateway,
            documentService: Mock.Of<IDocumentService>(),
            httpClientFactory: Mock.Of<IHttpClientFactory>(),
            llmCtx: new LLMRequestContextAccessor(),
            applyService: null!,
            logger: NullLogger<SubtitleGenerationProcessor>.Instance);

    private static ModelResolutionResult BuildDoubaoResolution()
        => new()
        {
            Success = true,
            ResolutionType = "DedicatedPool",
            ActualModel = "doubao-asr-bigmodel",
            ActualPlatformId = "exchange-doubao-asr",
            ActualPlatformName = "Exchange:Doubao ASR",
            PlatformType = "exchange",
            IsExchange = true,
            ExchangeName = "Doubao ASR",
            ExchangeTransformerType = "doubao-asr",
            ApiUrl = "https://example.test/asr",
            ApiKey = "test-key",
        };

    private static DocumentStoreAgentRun BuildRun()
        => new()
        {
            Id = "run-1",
            UserId = "user-1",
            SourceEntryId = "entry-1",
        };
}
