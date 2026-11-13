using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;
using Moq;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.LlmGateway;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.LlmGateway.Transformers;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class DoubaoTtsTransformerTests
{
    private readonly DoubaoTtsTransformer _transformer = new();
    private static Dictionary<string, object> Config => new() { ["resourceId"] = "seed-tts-2.0" };
    private static JsonObject Request => new()
    {
        ["input"] = "只保存在用户生成历史的朗读原文",
        ["voice"] = "configured-speaker",
        ["response_format"] = "mp3",
        ["speed"] = 1.25,
    };

    [Fact]
    public void MapsStandardFieldsAndProviderOnlyEmotionWithoutInventingModel()
    {
        var request = Request;
        request["emotion"] = "happy";
        request["emotion_scale"] = 3;
        request["sample_rate"] = 24000;
        var result = _transformer.TransformRequest(request, Config);
        result["req_params"]!["text"]!.GetValue<string>().ShouldBe(request["input"]!.GetValue<string>());
        result["req_params"]!["speaker"]!.GetValue<string>().ShouldBe("configured-speaker");
        var audio = result["req_params"]!["audio_params"]!;
        audio["speech_rate"]!.GetValue<double>().ShouldBe(25);
        audio["emotion"]!.GetValue<string>().ShouldBe("happy");
        audio["emotion_scale"]!.GetValue<double>().ShouldBe(3);
        audio["sample_rate"]!.GetValue<int>().ShouldBe(24000);
        result["model"].ShouldBeNull();
        result["req_params"]!["model"].ShouldBeNull();
    }

    [Theory]
    [InlineData(0.5, -50)]
    [InlineData(1, 0)]
    [InlineData(2, 100)]
    public void SpeedUsesDocumentedMultiplierConversion(double speed, double native)
    {
        var request = Request;
        request["speed"] = speed;
        _transformer.TransformRequest(request, Config)["req_params"]!["audio_params"]!["speech_rate"]!.GetValue<double>()
            .ShouldBe(native);
    }

    [Theory]
    [InlineData("response_format", "wav")]
    [InlineData("response_format", "flac")]
    [InlineData("instructions", "Speak softly")]
    public void RejectsUnsupportedFeaturesInsteadOfDroppingThem(string field, string value)
    {
        var request = Request;
        request[field] = value;
        Should.Throw<ArgumentException>(() => _transformer.TransformRequest(request, Config));
    }

    [Fact]
    public void ResourceIsExplicitAndNotAnAccountDependentDefault()
    {
        Should.Throw<ArgumentException>(() => _transformer.TransformRequest(Request, null));
        Should.Throw<ArgumentException>(() => _transformer.GetExtraHeaders(new() { ["resourceId"] = "bad\r\nresource" }));
        var headers = _transformer.GetExtraHeaders(Config)!;
        headers["X-Api-Resource-Id"].ShouldBe("seed-tts-2.0");
        Guid.TryParse(headers["X-Api-Request-Id"], out _).ShouldBeTrue();
    }

    [Fact]
    public void JoinsFramesOnlyAfterTerminalSuccessAndKeepsSafeUsageEvidence()
    {
        var raw = """
        {"code":0,"message":"","data":"SUQz"}
        {"code":0,"message":"","data":null,"sentence":{"text":"私有字幕，不应写入审计"}}
        {"code":0,"message":"","data":"AQID"}
        {"code":20000000,"message":"ok","data":null,"usage":{"text_words":17}}
        """;
        var response = Transform(raw);
        response.Success.ShouldBeTrue();
        response.BinaryContent!.ShouldBe(new byte[] { 73, 68, 51, 1, 2, 3 });
        response.ContentType.ShouldBe("audio/mpeg");
        response.AuditSummary.ShouldNotContain("SUQz");
        response.AuditSummary.ShouldNotContain("私有字幕");
        JsonNode.Parse(response.AuditSummary)!["usage"]!["text_words"]!.GetValue<int>().ShouldBe(17);
    }

    [Fact]
    public void SupportsDocumentedSseEnvelopeWithoutTreatingEventNamesAsAudio()
    {
        var response = Transform(": heartbeat\n\nevent: 352\ndata: {\"code\":0,\"data\":\"SUQz\"}\n\nevent: 152\ndata: {\"code\":20000000,\"data\":null}\n");
        response.Success.ShouldBeTrue();
        response.BinaryContent!.ShouldBe(Encoding.ASCII.GetBytes("ID3"));
    }

    [Theory]
    [InlineData("{\"code\":0,\"data\":\"SUQz\"}", "TTS_RESPONSE_INCOMPLETE")]
    [InlineData("{\"code\":20000000,\"data\":null}", "TTS_RESPONSE_EMPTY")]
    [InlineData("{\"code\":0,\"data\":\"not base64!\"}", "TTS_RESPONSE_INVALID_AUDIO")]
    [InlineData("{\"code\":0,\"data\":42}", "TTS_RESPONSE_INVALID_AUDIO")]
    [InlineData("{\"code\":\"0\",\"data\":null}", "TTS_RESPONSE_INVALID")]
    [InlineData("{\"code\":40000001,\"message\":\"invalid resource id\"}", "TTS_UPSTREAM_FAILED")]
    [InlineData("{\"code\":0,\"data\":\"SUQz\"}\nmalformed", "TTS_RESPONSE_INVALID")]
    [InlineData("{\"code\":0,\"data\":\"SUQz\"}\n{\"code\":20000000}\n{\"code\":0,\"data\":\"AQID\"}", "TTS_RESPONSE_TRAILING_FRAME")]
    public void MalformedPartialAndBusinessFailuresNeverBecomeFinishedAudio(string raw, string errorCode)
    {
        var result = Transform(raw);
        result.Success.ShouldBeFalse();
        result.BinaryContent.ShouldBeNull();
        result.ErrorCode.ShouldBe(errorCode);
        result.AuditSummary.ShouldNotContain("SUQz");
    }

    [Fact]
    public void AuditRedactsEchoedTextCredentialsAndEmail()
    {
        var raw = new JsonObject
        {
            ["code"] = 45000000,
            ["message"] = $"invalid {Request["input"]!.GetValue<string>()} Bearer secret-user-key test@a.co",
        };
        var result = Transform(raw.ToJsonString());
        result.AuditSummary.ShouldNotContain(Request["input"]!.GetValue<string>());
        result.AuditSummary.ShouldNotContain("secret-user-key");
        result.AuditSummary.ShouldNotContain("test@a.co");
        JsonNode.Parse(result.AuditSummary)!["provider_code"]!.GetValue<int>().ShouldBe(45000000);
    }

    [Fact]
    public void OversizedResponseRecordsTruncationAndReturnsNoAudio()
    {
        var result = _transformer.TransformRawResponse(new byte[DoubaoTtsTransformer.MaximumResponseBytes + 1],
            "application/json", Request, Config);
        result.Success.ShouldBeFalse();
        result.ErrorCode.ShouldBe("TTS_RESPONSE_TOO_LARGE");
        JsonNode.Parse(result.AuditSummary)!["truncated"]!.GetValue<bool>().ShouldBeTrue();
    }

    [Fact]
    public void InvalidUtf8CannotBeAcceptedAsAReplacementCharacterJsonResponse()
    {
        var result = _transformer.TransformRawResponse(new byte[] { 0xff, 0xfe }, "application/json", Request, Config);
        result.Success.ShouldBeFalse();
        result.ErrorCode.ShouldBe("TTS_RESPONSE_INVALID");
        JsonNode.Parse(result.AuditSummary)!["parsed"]!.GetValue<bool>().ShouldBeFalse();
    }

    [Fact]
    public async Task NativeOpenAiSpeechKeepsItsOwnWireContractAndBinaryResponse()
    {
        var factory = new TestHttpFactory("ID3", "audio/mpeg");
        var logs = new Mock<ILlmRequestLogWriter>();
        LlmLogStart? audit = null;
        logs.Setup(x => x.StartAsync(It.IsAny<LlmLogStart>(), It.IsAny<CancellationToken>()))
            .Callback<LlmLogStart, CancellationToken>((start, _) => audit = start).ReturnsAsync("openai-tts-log");
        var gateway = new LlmGateway(new Mock<IModelResolver>().Object, factory, NullLogger<LlmGateway>.Instance, logs.Object);
        var request = Request;
        request["instructions"] = "声音指令仅对真实支持的上游发送";
        var result = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.Audio.Tts,
            ModelType = ModelTypes.Tts,
            RequestBody = request,
            RequiredOfferingId = "openai-speech-offering",
        }, new GatewayModelResolution
        {
            Success = true,
            ActualModel = "future-speech-model",
            ActualPlatformId = "configured-openai-instance",
            OfferingId = "openai-speech-offering",
            PlatformType = "openai",
            ApiUrl = "https://openai.example",
            ApiKey = "test-only-api-key",
        });
        result.Success.ShouldBeTrue(result.ErrorMessage);
        result.BinaryContent!.ShouldBe(Encoding.ASCII.GetBytes("ID3"));
        var responseAudit = JsonNode.Parse(result.Content!)!;
        responseAudit["media_omitted"]!.GetValue<bool>().ShouldBeTrue();
        responseAudit["received_bytes"]!.GetValue<int>().ShouldBe(3);
        responseAudit["response_sha256"]!.GetValue<string>().Length.ShouldBe(64);
        result.Content.ShouldNotContain("ID3");
        factory.Requests.Single().RequestUri!.AbsolutePath.ShouldBe("/v1/audio/speech");
        factory.Requests.Single().Headers.Authorization!.Scheme.ShouldBe("Bearer");
        var sent = JsonNode.Parse(await factory.Requests.Single().Content!.ReadAsStringAsync());
        sent!["instructions"]!.GetValue<string>().ShouldBe(request["instructions"]!.GetValue<string>());
        sent["voice"]!.GetValue<string>().ShouldBe("configured-speaker");
        audit.ShouldNotBeNull();
        audit!.RequestBodyRedacted.ShouldNotContain(request["input"]!.GetValue<string>());
        audit.RequestBodyRedacted.ShouldNotContain(request["instructions"]!.GetValue<string>());
    }

    [Fact]
    public async Task NativeSpeechCannotTreatJsonAsFinishedAudioEvenWhenBinaryWasExpected()
    {
        var gateway = new LlmGateway(new Mock<IModelResolver>().Object,
            new TestHttpFactory("{\"error\":{\"message\":\"invalid voice\"}}"), NullLogger<LlmGateway>.Instance);
        var result = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.Audio.Tts,
            ModelType = ModelTypes.Tts,
            RequestBody = Request,
            ExpectBinaryResponse = true,
        }, NativeResolution());
        result.Success.ShouldBeFalse();
        result.StatusCode.ShouldBe(200);
        result.ErrorCode.ShouldBe("TTS_RESPONSE_NOT_AUDIO");
        result.BinaryContent.ShouldBeNull();
    }

    [Fact]
    public async Task NativeSpeechReadsHeadersFirstAndStopsAtAudioLimitWithoutBufferingWholeResponse()
    {
        var content = new BoundedTestContent(GatewaySpeechResponseLimits.MaxAudioBytes + 1024L);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("audio/mpeg");
        var logs = new Mock<ILlmRequestLogWriter>();
        LlmLogDone? done = null;
        logs.Setup(x => x.StartAsync(It.IsAny<LlmLogStart>(), It.IsAny<CancellationToken>())).ReturnsAsync("bounded-tts");
        logs.Setup(x => x.MarkDone("bounded-tts", It.IsAny<LlmLogDone>()))
            .Callback<string, LlmLogDone>((_, entry) => done = entry);
        var resolver = new Mock<IModelResolver>();
        var gateway = new LlmGateway(resolver.Object, new ContentHttpFactory(content), NullLogger<LlmGateway>.Instance, logs.Object);
        var result = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.Audio.Tts,
            ModelType = ModelTypes.Tts,
            RequestBody = Request,
            ExpectBinaryResponse = true,
        }, NativeResolution());
        result.Success.ShouldBeFalse();
        result.ErrorCode.ShouldBe("TTS_RESPONSE_TOO_LARGE");
        result.StatusCode.ShouldBe(200);
        result.BinaryContent.ShouldBeNull();
        content.Stream.BytesRead.ShouldBe(GatewaySpeechResponseLimits.MaxAudioBytes + 1L);
        JsonNode.Parse(result.Content!)!["truncated"]!.GetValue<bool>().ShouldBeTrue();
        done.ShouldNotBeNull();
        done!.Status.ShouldBe("failed");
        done.ProviderAttempts!.Last().Status.ShouldBe("failed");
        resolver.Verify(x => x.RecordSuccessAsync(It.IsAny<ModelResolutionResult>(), It.IsAny<CancellationToken>()), Times.Never);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task GatewayPreservesHttpFactsAndAuditsBusinessOutcome(bool success)
    {
        var responseBody = success
            ? "{\"code\":0,\"data\":\"SUQz\"}\n{\"code\":20000000,\"message\":\"ok\"}"
            : "{\"code\":45000000,\"message\":\"permission denied\"}";
        var factory = new TestHttpFactory(responseBody);
        var resolver = new Mock<IModelResolver>();
        var logs = new Mock<ILlmRequestLogWriter>();
        LlmLogDone? audit = null;
        LlmLogStart? startAudit = null;
        logs.Setup(x => x.StartAsync(It.IsAny<LlmLogStart>(), It.IsAny<CancellationToken>()))
            .Callback<LlmLogStart, CancellationToken>((start, _) => startAudit = start).ReturnsAsync("tts-log");
        logs.Setup(x => x.MarkDone("tts-log", It.IsAny<LlmLogDone>())).Callback<string, LlmLogDone>((_, done) => audit = done);
        var gateway = new LlmGateway(resolver.Object, factory, NullLogger<LlmGateway>.Instance, logs.Object);
        var result = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.Audio.Tts,
            ModelType = ModelTypes.Tts,
            RequestBody = Request,
            RequiredOfferingId = "speech-offering",
        }, Resolution());

        result.Success.ShouldBe(success, result.ErrorMessage);
        result.StatusCode.ShouldBe(200);
        result.LogId.ShouldBe("tts-log");
        audit.ShouldNotBeNull();
        audit!.StatusCode.ShouldBe(200);
        audit.Status.ShouldBe(success ? "succeeded" : "failed");
        audit.ProviderAttempts!.Last().Status.ShouldBe(success ? "succeeded" : "failed");
        audit.AnswerText.ShouldNotContain("SUQz");
        startAudit.ShouldNotBeNull();
        startAudit!.RequestBodyRedacted.ShouldNotContain(Request["input"]!.GetValue<string>());
        startAudit.RequestBodyRedacted.ShouldContain("speech text omitted");
        factory.Requests.Count.ShouldBe(1);
        factory.Requests[0].Headers.GetValues("X-Api-Key").Single().ShouldBe("test-only-api-key");
        factory.Requests[0].Headers.GetValues("X-Api-Resource-Id").Single().ShouldBe("seed-tts-2.0");
        if (success)
        {
            result.BinaryContent!.ShouldBe(Encoding.ASCII.GetBytes("ID3"));
            resolver.Verify(x => x.RecordSuccessAsync(It.IsAny<ModelResolutionResult>(), It.IsAny<CancellationToken>()), Times.Once);
        }
        else
        {
            result.BinaryContent.ShouldBeNull();
            result.ErrorCode.ShouldBe("TTS_UPSTREAM_FAILED");
            audit.FinishReason.ShouldBe("TTS_UPSTREAM_FAILED");
            resolver.Verify(x => x.RecordSuccessAsync(It.IsAny<ModelResolutionResult>(), It.IsAny<CancellationToken>()), Times.Never);
        }
    }

    private ExchangeRawResponse Transform(string raw)
        => _transformer.TransformRawResponse(Encoding.UTF8.GetBytes(raw), "application/json", Request, Config);

    [Fact]
    public async Task LegacyAuthenticationUsesTtsAppIdHeaderRatherThanAsrAppKey()
    {
        var factory = new TestHttpFactory("{\"code\":0,\"data\":\"SUQz\"}\n{\"code\":20000000}");
        var gateway = new LlmGateway(new Mock<IModelResolver>().Object, factory, NullLogger<LlmGateway>.Instance);
        var result = await gateway.SendRawWithResolutionAsync(new GatewayRawRequest
        {
            AppCallerCode = AppCallerRegistry.VideoAgent.Audio.Tts,
            ModelType = ModelTypes.Tts,
            RequestBody = Request,
        }, Resolution("DoubaoTts"));
        result.Success.ShouldBeTrue(result.ErrorMessage);
        var headers = factory.Requests.Single().Headers;
        headers.GetValues("X-Api-App-Id").Single().ShouldBe("test-app-id");
        headers.GetValues("X-Api-Access-Key").Single().ShouldBe("test-only-access-token");
        headers.Contains("X-Api-App-Key").ShouldBeFalse();
        headers.Contains("Authorization").ShouldBeFalse();
    }

    private static GatewayModelResolution Resolution(string authScheme = "XApiKey") => new()
    {
        Success = true,
        ActualModel = "configured-tts-model",
        ActualPlatformId = "tts-exchange",
        ActualPlatformName = "Doubao TTS",
        ModelGroupId = "tts-pool",
        OfferingId = "speech-offering",
        PlatformType = "exchange",
        ApiUrl = "https://openspeech.example/api/v3/tts/unidirectional",
        ApiKey = authScheme == "DoubaoTts" ? "test-app-id|test-only-access-token" : "test-only-api-key",
        IsExchange = true,
        ExchangeName = "Doubao TTS",
        ExchangeAuthScheme = authScheme,
        ExchangeTransformerType = "doubao-tts",
        ExchangeTransformerConfig = Config,
    };

    private static GatewayModelResolution NativeResolution() => new()
    {
        Success = true,
        ActualModel = "configured-speech-model",
        ActualPlatformId = "configured-openai-instance",
        OfferingId = "openai-speech-offering",
        PlatformType = "openai",
        ApiUrl = "https://openai.example",
        ApiKey = "test-only-api-key",
    };

    private sealed class ContentHttpFactory(HttpContent content) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(new Handler(content));
        private sealed class Handler(HttpContent content) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
                => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        }
    }

    private sealed class BoundedTestContent(long length) : HttpContent
    {
        public CountingAudioStream Stream { get; } = new(length);
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
            => throw new InvalidOperationException("ResponseContentRead must not buffer the entire speech response.");
        protected override Task<Stream> CreateContentReadStreamAsync() => Task.FromResult<Stream>(Stream);
        protected override bool TryComputeLength(out long computedLength)
        {
            computedLength = length;
            return true;
        }
    }

    private sealed class CountingAudioStream(long length) : Stream
    {
        public long BytesRead { get; private set; }
        public override int Read(byte[] buffer, int offset, int count)
        {
            var read = (int)Math.Min(count, length - BytesRead);
            buffer.AsSpan(offset, read).Fill(0x55);
            BytesRead += read;
            return read;
        }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var read = (int)Math.Min(buffer.Length, length - BytesRead);
            buffer.Span[..read].Fill(0x55);
            BytesRead += read;
            return ValueTask.FromResult(read);
        }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => length;
        public override long Position { get => BytesRead; set => throw new NotSupportedException(); }
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class TestHttpFactory(string body, string contentType = "application/json") : IHttpClientFactory
    {
        private string Body { get; } = body;
        private string ContentType { get; } = contentType;
        public List<HttpRequestMessage> Requests { get; } = [];
        public HttpClient CreateClient(string name) => new(new Handler(this));
        private sealed class Handler(TestHttpFactory owner) : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
            {
                owner.Requests.Add(request);
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(owner.Body, Encoding.UTF8, owner.ContentType),
                });
            }
        }
    }
}
