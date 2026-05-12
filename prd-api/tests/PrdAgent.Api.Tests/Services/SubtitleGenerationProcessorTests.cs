using System.Reflection;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
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
                            "result": {
                              "utterances": [
                                { "start_time": 1000, "end_time": 2500, "text": "第一句字幕" }
                              ]
                            }
                          }
                          """
            });

        var processor = new SubtitleGenerationProcessor(
            streamAsr: null!,
            modelResolver: Mock.Of<IModelResolver>(),
            llmGateway: gateway.Object,
            documentService: Mock.Of<IDocumentService>(),
            httpClientFactory: Mock.Of<IHttpClientFactory>(),
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
}
