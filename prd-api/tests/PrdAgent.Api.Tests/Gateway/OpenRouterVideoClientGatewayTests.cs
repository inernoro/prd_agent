using System.Net;
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
            new SingleClientFactory(new HttpClient(new CapturingHandler(_ => throw new NotSupportedException()))),
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

    [Fact]
    public async Task VolcengineVideoExchange_ShouldUseGatewayStatusAndDownloadSignedUrl()
    {
        var gateway = new CapturingGateway(new GatewayModelResolution
        {
            Success = true,
            ResolutionType = "DedicatedPool",
            ActualModel = "doubao-seedance-2-0-fast-260128",
            ActualPlatformId = "exchange-volc-video",
            ActualPlatformName = "Exchange:火山方舟 Seedance 视频生成",
            PlatformType = "exchange",
            Protocol = "exchange",
            ApiUrl = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
            ApiKey = "ark-test",
            IsExchange = true,
            ExchangeId = "exchange-volc-video",
            ExchangeName = "火山方舟 Seedance 视频生成",
            ExchangeTransformerType = "volcengine-video",
            ExchangeAuthScheme = "Bearer",
        });
        var downloadHttp = new HttpClient(new CapturingHandler(request =>
        {
            request.RequestUri!.ToString().ShouldBe("https://tos.example.test/video.mp4");
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent([9, 8, 7])
                {
                    Headers = { ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("video/mp4") }
                },
            });
        }));
        var client = new OpenRouterVideoClient(
            gateway,
            new SingleClientFactory(downloadHttp),
            NullLogger<OpenRouterVideoClient>.Instance);

        var submit = await client.SubmitAsync(new OpenRouterVideoSubmitRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.VideoGen.Generate,
            Model = "doubao-seedance-2-0-fast-260128",
            Prompt = "产品演示视频",
        });

        submit.Success.ShouldBeTrue(submit.ErrorMessage);
        submit.JobId.ShouldBe("cgt-123");

        var status = await client.GetStatusAsync(AppCallerRegistry.VideoAgent.VideoGen.Generate, "cgt-123");
        status.IsCompleted.ShouldBeTrue();
        status.VideoUrl.ShouldBe("https://tos.example.test/video.mp4");

        var download = await client.DownloadVideoBytesAsync(AppCallerRegistry.VideoAgent.VideoGen.Generate, "cgt-123");
        download.Success.ShouldBeTrue(download.ErrorMessage);
        download.Bytes.ShouldBe([9, 8, 7]);

        gateway.RawCalls.Count.ShouldBe(3);
        gateway.RawCalls[0].Request.EndpointPath.ShouldBe("/videos");
        gateway.RawCalls[1].Request.HttpMethod.ShouldBe("GET");
        gateway.RawCalls[1].Request.RequestBody.ShouldNotBeNull();
        gateway.RawCalls[1].Request.RequestBody!["_gateway_operation"]!.GetValue<string>().ShouldBe("status");
        gateway.RawCalls[1].Request.RequestBody!["task_id"]!.GetValue<string>().ShouldBe("cgt-123");
        gateway.RawCalls[2].Request.RequestBody!["task_id"]!.GetValue<string>().ShouldBe("cgt-123");
    }

    private sealed class CapturingGateway : ILlmGateway
    {
        public CapturingGateway()
            : this(new GatewayModelResolution
            {
                Success = true,
                ResolutionType = "DedicatedPool",
                ActualModel = "openrouter/test-video",
                ActualPlatformId = "openrouter",
                ActualPlatformName = "OpenRouter",
                PlatformType = "openrouter",
                ApiUrl = "https://openrouter.ai/api/v1",
                ApiKey = "sk-test",
            })
        {
        }

        public CapturingGateway(GatewayModelResolution resolution)
        {
            Resolution = resolution;
        }

        public GatewayModelResolution Resolution { get; }

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
            if (resolution.IsExchange
                && string.Equals(resolution.ExchangeTransformerType, "volcengine-video", StringComparison.OrdinalIgnoreCase))
            {
                return Task.FromResult(request.RequestBody?["_gateway_operation"]?.GetValue<string>() == "status"
                    ? new GatewayRawResponse
                    {
                        Success = true,
                        StatusCode = 200,
                        ContentType = "application/json",
                        Content = """
                                  {"status":"completed","unsigned_urls":["https://tos.example.test/video.mp4"],"usage":{"cost":0.56}}
                                  """,
                    }
                    : new GatewayRawResponse
                    {
                        Success = true,
                        StatusCode = 200,
                        ContentType = "application/json",
                        Content = """
                                  {"id":"cgt-123","status":"pending"}
                                  """,
                    });
            }

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

    private sealed class CapturingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> _handler;

        public CapturingHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler)
        {
            _handler = handler;
        }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => _handler(request);
    }

    private sealed class SingleClientFactory : IHttpClientFactory
    {
        private readonly HttpClient _client;

        public SingleClientFactory(HttpClient client)
        {
            _client = client;
        }

        public HttpClient CreateClient(string name) => _client;
    }
}
