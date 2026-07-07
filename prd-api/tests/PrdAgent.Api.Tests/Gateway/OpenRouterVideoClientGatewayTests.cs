using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class OpenRouterVideoClientGatewayTests
{
    [Fact]
    public async Task SubmitStatusAndDownload_ShouldUseGatewayRawPath()
    {
        var gateway = new CapturingGateway();
        var client = new OpenRouterVideoClient(
            gateway,
            NullLogger<OpenRouterVideoClient>.Instance);

        var submit = await client.SubmitAsync(new OpenRouterVideoSubmitRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.VideoGen.Generate,
            Model = "openrouter/test-video",
            Prompt = "生成一个产品演示视频",
            FirstFrameImageUrl = "https://example.test/frame.png",
            AspectRatio = "16:9",
            Resolution = "720p",
            DurationSeconds = 5,
            GenerateAudio = true,
            Seed = 42,
            UserId = "user-1",
            RequestId = "req-1",
        });

        submit.Success.ShouldBeTrue(submit.ErrorMessage);
        submit.JobId.ShouldBe("job-123");
        submit.ActualModel.ShouldBe("openrouter/test-video");

        var status = await client.GetStatusAsync(AppCallerRegistry.VideoAgent.VideoGen.Generate, "job-123");
        status.Status.ShouldBe("completed");
        status.VideoUrl.ShouldBe("https://example.test/video.mp4");

        var download = await client.DownloadVideoBytesAsync(AppCallerRegistry.VideoAgent.VideoGen.Generate, "job-123");
        download.Success.ShouldBeTrue(download.ErrorMessage);
        download.Bytes.ShouldBe([1, 2, 3, 4]);
        download.ContentType.ShouldBe("video/mp4");

        gateway.ResolveCalls.Count.ShouldBe(1);
        gateway.ResolveCalls[0].AppCallerCode.ShouldBe(AppCallerRegistry.VideoAgent.VideoGen.Generate);
        gateway.ResolveCalls[0].ModelType.ShouldBe(ModelTypes.VideoGen);
        gateway.ResolveCalls[0].ExpectedModel.ShouldBe("openrouter/test-video");

        gateway.RawCalls.Count.ShouldBe(3);

        var submitCall = gateway.RawCalls[0];
        submitCall.Request.AppCallerCode.ShouldBe(AppCallerRegistry.VideoAgent.VideoGen.Generate);
        submitCall.Request.ModelType.ShouldBe(ModelTypes.VideoGen);
        submitCall.Request.EndpointPath.ShouldBe("/videos");
        submitCall.Request.HttpMethod.ShouldBe("POST");
        submitCall.Request.Context.ShouldNotBeNull();
        submitCall.Request.Context!.RequestId.ShouldBe("req-1");
        submitCall.Request.Context.UserId.ShouldBe("user-1");
        submitCall.Request.Context.QuestionText.ShouldBe("生成一个产品演示视频");
        submitCall.Resolution.ActualModel.ShouldBe("openrouter/test-video");
        submitCall.Request.RequestBody.ShouldNotBeNull();
        submitCall.Request.RequestBody!["model"]!.GetValue<string>().ShouldBe("openrouter/test-video");
        submitCall.Request.RequestBody!["prompt"]!.GetValue<string>().ShouldBe("生成一个产品演示视频");
        submitCall.Request.RequestBody!["frame_images"]!.AsArray().Count.ShouldBe(1);

        var statusCall = gateway.RawCalls[1];
        statusCall.Request.EndpointPath.ShouldBe("/videos/job-123");
        statusCall.Request.HttpMethod.ShouldBe("GET");
        statusCall.Resolution.ShouldBe(gateway.Resolution);

        var downloadCall = gateway.RawCalls[2];
        downloadCall.Request.EndpointPath.ShouldBe("/videos/job-123/content?index=0");
        downloadCall.Request.HttpMethod.ShouldBe("GET");
        downloadCall.Request.ExpectBinaryResponse.ShouldBeTrue();
        downloadCall.Resolution.ShouldBe(gateway.Resolution);
    }

    private sealed class CapturingGateway : ILlmGateway
    {
        public GatewayModelResolution Resolution { get; } = new()
        {
            Success = true,
            ResolutionType = "DedicatedPool",
            ActualModel = "openrouter/test-video",
            ActualPlatformId = "openrouter",
            ActualPlatformName = "OpenRouter",
            PlatformType = "openrouter",
            ApiUrl = "https://openrouter.ai/api/v1",
            ApiKey = "sk-test",
        };

        public List<(string AppCallerCode, string ModelType, string? ExpectedModel)> ResolveCalls { get; } = [];
        public List<(GatewayRawRequest Request, GatewayModelResolution Resolution)> RawCalls { get; } = [];

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null,
            CancellationToken ct = default)
        {
            ResolveCalls.Add((appCallerCode, modelType, expectedModel));
            return Task.FromResult(Resolution);
        }

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(
            GatewayRawRequest request,
            GatewayModelResolution resolution,
            CancellationToken ct = default)
        {
            RawCalls.Add((request, resolution));
            return Task.FromResult(request.EndpointPath switch
            {
                "/videos" => new GatewayRawResponse
                {
                    Success = true,
                    StatusCode = 200,
                    ContentType = "application/json",
                    Content = """
                              {"id":"job-123","usage":{"cost":0.12}}
                              """,
                },
                "/videos/job-123" => new GatewayRawResponse
                {
                    Success = true,
                    StatusCode = 200,
                    ContentType = "application/json",
                    Content = """
                              {"status":"completed","unsigned_urls":["https://example.test/video.mp4"],"usage":{"cost":0.34}}
                              """,
                },
                "/videos/job-123/content?index=0" => new GatewayRawResponse
                {
                    Success = true,
                    StatusCode = 200,
                    ContentType = "application/json",
                    BinaryContent = [1, 2, 3, 4],
                },
                _ => new GatewayRawResponse
                {
                    Success = false,
                    StatusCode = 404,
                    ErrorCode = "UNEXPECTED_PATH",
                    ErrorMessage = request.EndpointPath,
                }
            });
        }

        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
            => throw new NotSupportedException();

        public IAsyncEnumerable<GatewayStreamChunk> StreamAsync(GatewayRequest request, CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode,
            string modelType,
            CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>());

        public ILLMClient CreateClient(
            string appCallerCode,
            string modelType,
            int maxTokens = 4096,
            double temperature = 0.2,
            bool includeThinking = false,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null)
            => throw new NotSupportedException();
    }
}
