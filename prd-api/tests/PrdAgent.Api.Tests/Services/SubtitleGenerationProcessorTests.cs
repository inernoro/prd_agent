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
                              { "start": 1.0, "end": 2.5, "text": "第一句字幕" }
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
            new object[] { run, audioBytes, resolution })!;

        var segments = await task;

        capturedRequest.ShouldNotBeNull();
        capturedResolution.ShouldNotBeNull();
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
            new object[] { BuildRun(), new byte[] { 1, 2, 3 }, BuildDoubaoResolution() })!;

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
