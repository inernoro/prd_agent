using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Transformers;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class DoubaoAsrTransformerTests
{
    [Fact]
    public async Task SendRawWithResolutionAsync_SubmitSuccessMustQueryBeforeTransformingResponse()
    {
        var http = new DoubaoAsyncHttpClientFactory();
        var gateway = new LlmGateway(
            new NoopModelResolver(),
            http,
            NullLogger<LlmGateway>.Instance);

        var response = await gateway.SendRawWithResolutionAsync(
            new GatewayRawRequest
            {
                AppCallerCode = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
                ModelType = ModelTypes.Asr,
                RequestBody = new JsonObject { ["audio_data"] = "UklGRg==" },
            },
            new GatewayModelResolution
            {
                Success = true,
                ActualModel = "doubao-asr-bigmodel",
                ActualPlatformId = "doubao-exchange",
                ActualPlatformName = "Doubao ASR",
                PlatformType = "exchange",
                ApiUrl = "https://openspeech.example/api/v3/auc/bigmodel/submit",
                ApiKey = "app-id|access-key",
                IsExchange = true,
                ExchangeName = "Doubao ASR",
                ExchangeAuthScheme = "DoubaoAsr",
                ExchangeTransformerType = "doubao-asr",
            });

        response.Success.ShouldBeTrue(response.ErrorMessage);
        http.RequestUris.Count.ShouldBe(2);
        http.RequestUris[0].ShouldEndWith("/submit");
        http.RequestUris[1].ShouldEndWith("/query");
        JsonNode.Parse(response.Content!)!["text"]!.GetValue<string>()
            .ShouldBe("真实查询结果");
    }

    [Fact]
    public async Task SendRawWithResolutionAsync_PendingQueryMustContinueUntilComplete()
    {
        var http = new DoubaoAsyncHttpClientFactory(pendingQueryCount: 1);
        var gateway = new LlmGateway(
            new NoopModelResolver(),
            http,
            NullLogger<LlmGateway>.Instance);

        var response = await gateway.SendRawWithResolutionAsync(
            new GatewayRawRequest
            {
                AppCallerCode = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
                ModelType = ModelTypes.Asr,
                RequestBody = new JsonObject { ["audio_data"] = "UklGRg==" },
            },
            DoubaoResolution());

        response.Success.ShouldBeTrue(response.ErrorMessage);
        http.RequestUris.Count.ShouldBe(3);
        http.RequestUris[1].ShouldEndWith("/query");
        http.RequestUris[2].ShouldEndWith("/query");
        JsonNode.Parse(response.Content!)!["text"]!.GetValue<string>()
            .ShouldBe("真实查询结果");
    }

    [Fact]
    public void TransformResponse_ShouldReadCurrentResultObjectWithUtterances()
    {
        var raw = (JsonObject)JsonNode.Parse("""
        {
          "audio_info": { "duration": 2499 },
          "result": {
            "additions": { "duration": "2499" },
            "text": "关闭透传。",
            "utterances": [
              {
                "start_time": 450,
                "end_time": 1530,
                "speaker_id": "0",
                "text": "关闭透传。"
              }
            ]
          }
        }
        """)!;

        var transformed = new DoubaoAsrTransformer().TransformResponse(raw, null);

        transformed["text"]!.GetValue<string>().ShouldBe("关闭透传。");
        var segments = transformed["segments"]!.AsArray();
        segments.Count.ShouldBe(1);
        segments[0]!["start"]!.GetValue<double>().ShouldBe(0.45);
        segments[0]!["end"]!.GetValue<double>().ShouldBe(1.53);
        segments[0]!["text"]!.GetValue<string>().ShouldBe("关闭透传。");
        segments[0]!["speaker"]!.GetValue<string>().ShouldBe("0");
    }

    [Fact]
    public void TransformResponse_ShouldKeepLegacyResultArraySupport()
    {
        var raw = (JsonObject)JsonNode.Parse("""
        {
          "result": [
            {
              "additions": { "duration": "1200" },
              "text": "第一段。"
            },
            {
              "additions": { "duration": "800" },
              "text": "第二段。"
            }
          ]
        }
        """)!;

        var transformed = new DoubaoAsrTransformer().TransformResponse(raw, null);

        transformed["text"]!.GetValue<string>().ShouldBe("第一段。第二段。");
        var segments = transformed["segments"]!.AsArray();
        segments.Count.ShouldBe(2);
        segments[0]!["start"]!.GetValue<double>().ShouldBe(0);
        segments[0]!["end"]!.GetValue<double>().ShouldBe(1.2);
        segments[1]!["start"]!.GetValue<double>().ShouldBe(1.2);
        segments[1]!["end"]!.GetValue<double>().ShouldBe(2);
    }

    private static GatewayModelResolution DoubaoResolution()
        => new()
        {
            Success = true,
            ActualModel = "doubao-asr-bigmodel",
            ActualPlatformId = "doubao-exchange",
            ActualPlatformName = "Doubao ASR",
            PlatformType = "exchange",
            ApiUrl = "https://openspeech.example/api/v3/auc/bigmodel/submit",
            ApiKey = "app-id|access-key",
            IsExchange = true,
            ExchangeName = "Doubao ASR",
            ExchangeAuthScheme = "DoubaoAsr",
            ExchangeTransformerType = "doubao-asr",
        };

    private sealed class DoubaoAsyncHttpClientFactory(int pendingQueryCount = 0) : IHttpClientFactory
    {
        private int _requestCount;
        private int PendingQueryCount { get; } = pendingQueryCount;
        public List<string> RequestUris { get; } = [];

        public HttpClient CreateClient(string name)
            => new(new DoubaoAsyncHttpMessageHandler(this));

        private sealed class DoubaoAsyncHttpMessageHandler(DoubaoAsyncHttpClientFactory owner)
            : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request,
                CancellationToken cancellationToken)
            {
                owner.RequestUris.Add(request.RequestUri?.ToString() ?? string.Empty);
                var requestNumber = Interlocked.Increment(ref owner._requestCount);
                var isSubmit = requestNumber == 1;
                var isPendingQuery = requestNumber > 1
                    && requestNumber <= owner.PendingQueryCount + 1;
                var body = isSubmit || isPendingQuery
                    ? "{}"
                    : """
                      {
                        "result": {
                          "text": "真实查询结果",
                          "utterances": [
                            { "start_time": 0, "end_time": 1000, "text": "真实查询结果" }
                          ]
                        }
                      }
                      """;
                var response = new HttpResponseMessage(System.Net.HttpStatusCode.OK)
                {
                    Content = new StringContent(body),
                };
                response.Headers.TryAddWithoutValidation(
                    "X-Api-Status-Code",
                    isPendingQuery ? "20000001" : "20000000");
                return Task.FromResult(response);
            }
        }
    }

    private sealed class NoopModelResolver : IModelResolver
    {
        public Task<ModelResolutionResult> ResolveAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null,
            CancellationToken ct = default)
            => throw new InvalidOperationException("发送阶段不应重新 Resolve");

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(
            string appCallerCode,
            string modelType,
            CancellationToken ct = default)
            => Task.FromResult(new List<AvailableModelPool>());

        public Task RecordSuccessAsync(ModelResolutionResult resolution, CancellationToken ct = default)
            => Task.CompletedTask;

        public Task RecordFailureAsync(ModelResolutionResult resolution, CancellationToken ct = default)
            => Task.CompletedTask;
    }
}
