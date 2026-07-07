using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class GatewayDoubaoStreamAsrTests
{
    [Fact]
    public async Task RawDoubaoStreamAsr_ShouldExecuteInsideGateway_AndReturnVerboseJson()
    {
        var fakeAsr = new FakeDoubaoStreamAsrExecutor();
        var gateway = new LlmGateway(
            new NoopModelResolver(),
            new NoopHttpClientFactory(),
            NullLogger<LlmGateway>.Instance,
            doubaoStreamAsr: fakeAsr);

        var response = await gateway.SendRawWithResolutionAsync(
            new GatewayRawRequest
            {
                AppCallerCode = AppCallerRegistry.DocumentStoreAgent.Subtitle.Audio,
                ModelType = ModelTypes.Asr,
                IsMultipart = true,
                MultipartFields = new Dictionary<string, object>
                {
                    ["response_format"] = "verbose_json",
                },
                MultipartFiles = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
                {
                    ["file"] = ("audio.wav", [1, 2, 3, 4], "audio/wav"),
                },
            },
            new GatewayModelResolution
            {
                Success = true,
                ResolutionType = "DedicatedPool",
                ActualModel = "doubao-asr-stream",
                ActualPlatformId = "exchange-doubao-stream",
                ActualPlatformName = "Doubao Stream ASR",
                PlatformType = "exchange",
                ApiUrl = "wss://example.test/asr",
                ApiKey = "app-123|access-456",
                IsExchange = true,
                ExchangeName = "Doubao Stream ASR",
                ExchangeTransformerType = "doubao-asr-stream",
                ExchangeTransformerConfig = new Dictionary<string, object>
                {
                    ["resourceId"] = "volc.test",
                },
            });

        response.Success.ShouldBeTrue(response.ErrorMessage);
        response.StatusCode.ShouldBe(200);
        response.ContentType.ShouldBe("application/json");
        response.ResponseHeaders.ShouldNotBeNull();
        response.ResponseHeaders!["x-gateway-exchange-protocol"].ShouldBe("websocket");

        fakeAsr.WsUrl.ShouldBe("wss://example.test/asr");
        fakeAsr.AppKey.ShouldBe("app-123");
        fakeAsr.AccessKey.ShouldBe("access-456");
        fakeAsr.AudioBytes.ShouldBe([1, 2, 3, 4]);

        using var doc = JsonDocument.Parse(response.Content!);
        var root = doc.RootElement;
        root.GetProperty("text").GetString().ShouldBe("第一句字幕");
        var segment = root.GetProperty("segments")[0];
        segment.GetProperty("start").GetDouble().ShouldBe(1);
        segment.GetProperty("end").GetDouble().ShouldBe(2.5);
        segment.GetProperty("text").GetString().ShouldBe("第一句字幕");
        root.GetProperty("gateway").GetProperty("protocol").GetString().ShouldBe("websocket");
    }

    [Fact]
    public async Task DoubaoStreamAsrFailure_ShouldKeepInitializedDiagnostic()
    {
        var service = new DoubaoStreamAsrService(NullLogger<DoubaoStreamAsrService>.Instance);

        var result = await service.TranscribeAsync(
            "not-a-ws-url",
            "",
            "single-access-key",
            CreateSilentWav(),
            new Dictionary<string, object>
            {
                ["resourceId"] = "volc.test.resource",
            });

        result.Success.ShouldBeFalse();
        result.Error.ShouldNotBeNullOrWhiteSpace();
        result.Diagnostic.WsUrl.ShouldBe("not-a-ws-url");
        result.Diagnostic.ResourceId.ShouldBe("volc.test.resource");
        result.Diagnostic.RequestId.ShouldNotBeNullOrWhiteSpace();
        result.Diagnostic.AuthMode.ShouldBe("单Key (x-api-key)");
        result.Diagnostic.AppKeyPreview.ShouldBe("(空)");
        result.Diagnostic.AccessKeyPreview!.ShouldContain("len=17");
        result.Diagnostic.RawErrorChain.ShouldNotBeNullOrWhiteSpace();
        result.Diagnostic.FriendlyError.ShouldNotBeNullOrWhiteSpace();
        result.Diagnostic.WscatCommand!.ShouldContain("not-a-ws-url");
        result.Diagnostic.Audio.ShouldNotBeNull();
        result.Diagnostic.Audio!.SegmentCount.ShouldBeGreaterThan(0);
    }

    private static byte[] CreateSilentWav()
    {
        const int sampleRate = 16000;
        const short channels = 1;
        const short bitsPerSample = 16;
        const int samples = sampleRate / 10;
        var pcmBytes = samples * channels * bitsPerSample / 8;

        using var ms = new MemoryStream();
        using var writer = new BinaryWriter(ms);
        writer.Write("RIFF"u8.ToArray());
        writer.Write(36 + pcmBytes);
        writer.Write("WAVE"u8.ToArray());
        writer.Write("fmt "u8.ToArray());
        writer.Write(16);
        writer.Write((short)1);
        writer.Write(channels);
        writer.Write(sampleRate);
        writer.Write(sampleRate * channels * bitsPerSample / 8);
        writer.Write((short)(channels * bitsPerSample / 8));
        writer.Write(bitsPerSample);
        writer.Write("data"u8.ToArray());
        writer.Write(pcmBytes);
        writer.Write(new byte[pcmBytes]);
        return ms.ToArray();
    }

    private sealed class FakeDoubaoStreamAsrExecutor : IDoubaoStreamAsrExecutor
    {
        public string? WsUrl { get; private set; }
        public string? AppKey { get; private set; }
        public string? AccessKey { get; private set; }
        public byte[] AudioBytes { get; private set; } = [];

        public Task<StreamAsrResult> TranscribeAsync(
            string wsUrl,
            string appKey,
            string accessKey,
            byte[] audioData,
            Dictionary<string, object>? config = null,
            CancellationToken ct = default)
        {
            WsUrl = wsUrl;
            AppKey = appKey;
            AccessKey = accessKey;
            AudioBytes = audioData;

            using var payload = JsonDocument.Parse("""
                {
                  "result": {
                    "text": "第一句字幕",
                    "utterances": [
                      { "start_time": 1000, "end_time": 2500, "text": "第一句字幕" }
                    ]
                  }
                }
                """);

            return Task.FromResult(new StreamAsrResult
            {
                Success = true,
                FullText = "第一句字幕",
                Responses =
                [
                    new AsrResponseFrame
                    {
                        Code = 0,
                        IsLastPackage = true,
                        PayloadMsg = payload.RootElement.Clone(),
                    },
                ],
            });
        }
    }

    private sealed class NoopHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => throw new InvalidOperationException("不应走 HTTP fallback");
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
