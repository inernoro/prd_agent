using System.Net;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.LlmGateway;
using PrdAgent.Infrastructure.Services.AssetStorage;
using PrdAgent.LlmGatewayHost;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Gateway;

public class GatewayMultipartHttpTests
{
    private const string GatewayKey = "multipart-gateway-key";

    private static readonly JsonSerializerOptions PascalJson = new()
    {
        PropertyNamingPolicy = null,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    [Fact]
    public async Task HttpClient_UploadsInlineMultipartFiles_AsRefs_WithoutSerializingBytes()
    {
        var storage = new MemoryAssetStorage();
        GatewayRawRequest? captured = null;
        var handler = new CapturingHandler(async request =>
        {
            request.Headers.GetValues("X-Gateway-Key").Single().ShouldBe(GatewayKey);
            var body = await request.Content!.ReadAsStringAsync();
            captured = JsonSerializer.Deserialize<GatewayRawRequest>(body, PascalJson);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = JsonContent.Create(new GatewayRawResponse
                {
                    Success = true,
                    StatusCode = 200,
                    Content = "ok",
                }, options: PascalJson),
            };
        });

        var client = new HttpLlmGatewayClient(
            new SingleClientFactory(new HttpClient(handler)),
            Config("http://llmgw.test"),
            NullLogger<HttpLlmGatewayClient>.Instance,
            assetStorage: storage);

        var bytes = Encoding.UTF8.GetBytes("voice-bytes");
        var response = await client.SendRawWithResolutionAsync(
            new GatewayRawRequest
            {
                AppCallerCode = "demo.app::asr",
                ModelType = "asr",
                IsMultipart = true,
                MultipartFields = new Dictionary<string, object> { ["language"] = "zh" },
                MultipartFiles = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
                {
                    ["file"] = ("voice.wav", bytes, "audio/wav"),
                },
            },
            new GatewayModelResolution
            {
                Success = true,
                ActualModel = "asr-model",
            });

        response.Success.ShouldBeTrue();
        captured.ShouldNotBeNull();
        captured!.MultipartFiles.ShouldBeNull("HTTP JSON 过线不得携带 ValueTuple+byte[] 文件体");
        captured.MultipartFileRefs.ShouldNotBeNull();
        captured.MultipartFileRefs!.ShouldContainKey("file");

        var fileRef = captured.MultipartFileRefs["file"];
        fileRef.FileName.ShouldBe("voice.wav");
        fileRef.MimeType.ShouldBe("audio/wav");
        fileRef.SizeBytes.ShouldBe(bytes.LongLength);
        fileRef.Sha256.ShouldBe(Sha256Hex(bytes));
        var stored = await storage.TryDownloadBytesAsync(fileRef.RefKey, CancellationToken.None);
        stored.ShouldNotBeNull();
        stored!.ShouldBe(bytes);
    }

    [Fact]
    public async Task RawEndpoint_RehydratesMultipartFileRefs_BeforeGatewaySend()
    {
        var bytes = Encoding.UTF8.GetBytes("image-bytes");
        var key = "llmgw/multipart/test/image.png";
        var storage = new MemoryAssetStorage();
        await storage.UploadToKeyAsync(key, bytes, "image/png", CancellationToken.None);
        var gateway = new CapturingGateway();

        await using var app = BuildHost(storage, gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var request = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/raw")
            {
                Content = new StringContent(JsonSerializer.Serialize(new GatewayRawRequest
                {
                    AppCallerCode = "demo.app::image",
                    ModelType = "generation",
                    IsMultipart = true,
                    MultipartFields = new Dictionary<string, object> { ["prompt"] = "draw" },
                    MultipartFileRefs = new Dictionary<string, MultipartFileRef>
                    {
                        ["image"] = new()
                        {
                            RefKey = key,
                            FileName = "image.png",
                            MimeType = "image/png",
                            SizeBytes = bytes.LongLength,
                            Sha256 = Sha256Hex(bytes),
                        },
                    },
                }, PascalJson), Encoding.UTF8, "application/json"),
            };
            request.Headers.Add("X-Gateway-Key", GatewayKey);

            var response = await client.SendAsync(request);
            var body = await response.Content.ReadAsStringAsync();
            var raw = JsonSerializer.Deserialize<GatewayRawResponse>(body, PascalJson);

            response.StatusCode.ShouldBe(HttpStatusCode.OK);
            raw.ShouldNotBeNull();
            raw!.Success.ShouldBeTrue();
            gateway.CapturedRaw.ShouldNotBeNull();
            gateway.CapturedRaw!.MultipartFiles.ShouldNotBeNull();
            gateway.CapturedRaw.MultipartFiles!.ShouldContainKey("image");
            var file = gateway.CapturedRaw.MultipartFiles["image"];
            file.FileName.ShouldBe("image.png");
            file.MimeType.ShouldBe("image/png");
            Sha256Hex(file.Content).ShouldBe(Sha256Hex(bytes));
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task RawEndpoint_RejectsMultipartRefHashMismatch()
    {
        var bytes = Encoding.UTF8.GetBytes("real-bytes");
        var storage = new MemoryAssetStorage();
        await storage.UploadToKeyAsync("llmgw/multipart/test/audio.wav", bytes, "audio/wav", CancellationToken.None);
        var gateway = new CapturingGateway();

        await using var app = BuildHost(storage, gateway);
        await app.StartAsync();
        try
        {
            var client = app.GetTestClient();
            var request = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/raw")
            {
                Content = new StringContent(JsonSerializer.Serialize(new GatewayRawRequest
                {
                    AppCallerCode = "demo.app::asr",
                    ModelType = "asr",
                    IsMultipart = true,
                    MultipartFileRefs = new Dictionary<string, MultipartFileRef>
                    {
                        ["file"] = new()
                        {
                            RefKey = "llmgw/multipart/test/audio.wav",
                            FileName = "audio.wav",
                            MimeType = "audio/wav",
                            SizeBytes = bytes.LongLength,
                            Sha256 = new string('0', 64),
                        },
                    },
                }, PascalJson), Encoding.UTF8, "application/json"),
            };
            request.Headers.Add("X-Gateway-Key", GatewayKey);

            var response = await client.SendAsync(request);
            var raw = JsonSerializer.Deserialize<GatewayRawResponse>(
                await response.Content.ReadAsStringAsync(), PascalJson);

            response.StatusCode.ShouldBe(HttpStatusCode.OK);
            raw.ShouldNotBeNull();
            raw!.Success.ShouldBeFalse();
            raw.ErrorCode.ShouldBe("MULTIPART_REF_HASH_MISMATCH");
            gateway.CapturedRaw.ShouldBeNull("hash 不一致时不得继续触达上游发送路径");
        }
        finally
        {
            await app.StopAsync();
        }
    }

    private static WebApplication BuildHost(MemoryAssetStorage storage, CapturingGateway gateway)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseTestServer();
        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = null);
        builder.Services.AddSingleton<IAssetStorage>(storage);
        builder.Services.AddSingleton<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>(gateway);
        builder.Services.AddSingleton<ILLMRequestContextAccessor, PrdAgent.Core.Services.LLMRequestContextAccessor>();

        var app = builder.Build();
        app.MapGatewayServingEndpoints(PascalJson, GatewayKey, "multipart-http-test");
        return app;
    }

    private static IConfiguration Config(string baseUrl)
        => new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["LlmGateway:ServeBaseUrl"] = baseUrl,
            ["LlmGwServe:ApiKey"] = GatewayKey,
        }).Build();

    private static string Sha256Hex(byte[] bytes)
    {
        using var sha = SHA256.Create();
        return Convert.ToHexString(sha.ComputeHash(bytes)).ToLowerInvariant();
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

    private sealed class MemoryAssetStorage : IAssetStorage
    {
        private readonly Dictionary<string, (byte[] Bytes, string? ContentType)> _objects = new(StringComparer.Ordinal);

        public Task<StoredAsset> SaveAsync(byte[] bytes, string mime, CancellationToken ct, string? domain = null, string? type = null, string? fileName = null, string? extensionHint = null)
        {
            var sha = Sha256Hex(bytes);
            var key = $"{domain ?? "test"}/{type ?? "file"}/{sha}.bin";
            _objects[key] = (bytes, mime);
            return Task.FromResult(new StoredAsset(sha, BuildUrlForKey(key), bytes.LongLength, mime));
        }

        public Task<(byte[] bytes, string mime)?> TryReadByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
            => Task.FromResult<(byte[] bytes, string mime)?>(null);

        public Task DeleteByShaAsync(string sha256, CancellationToken ct, string? domain = null, string? type = null)
            => Task.CompletedTask;

        public string? TryBuildUrlBySha(string sha256, string mime, string? domain = null, string? type = null)
            => null;

        public Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct)
            => Task.FromResult(_objects.TryGetValue(key, out var value) ? value.Bytes : null);

        public Task<bool> ExistsAsync(string key, CancellationToken ct)
            => Task.FromResult(_objects.ContainsKey(key));

        public Task UploadToKeyAsync(string key, byte[] bytes, string? contentType, CancellationToken ct, string? cacheControl = null)
        {
            _objects[key] = (bytes, contentType);
            return Task.CompletedTask;
        }

        public string BuildUrlForKey(string key) => $"memory://{key}";

        public Task DeleteByKeyAsync(string key, CancellationToken ct)
        {
            _objects.Remove(key);
            return Task.CompletedTask;
        }

        public string BuildSiteKey(string siteId, string filePath)
            => $"web-hosting/sites/{siteId}/{filePath.TrimStart('/')}";
    }

    private sealed class CapturingGateway : PrdAgent.Infrastructure.LlmGateway.ILlmGateway
    {
        public GatewayRawRequest? CapturedRaw { get; private set; }

        public Task<GatewayResponse> SendAsync(GatewayRequest request, CancellationToken ct = default)
            => Task.FromResult(GatewayResponse.Ok("ok", Resolution()));

        public async IAsyncEnumerable<GatewayStreamChunk> StreamAsync(
            GatewayRequest request,
            [EnumeratorCancellation] CancellationToken ct = default)
        {
            await Task.Yield();
            yield return new GatewayStreamChunk { Type = GatewayChunkType.Done, Seq = 1 };
        }

        public Task<GatewayRawResponse> SendRawWithResolutionAsync(GatewayRawRequest request, GatewayModelResolution resolution, CancellationToken ct = default)
        {
            CapturedRaw = request;
            return Task.FromResult(new GatewayRawResponse { Success = true, StatusCode = 200, Content = "raw-ok" });
        }

        public Task<GatewayModelResolution> ResolveModelAsync(
            string appCallerCode,
            string modelType,
            string? expectedModel = null,
            string? pinnedPlatformId = null,
            string? pinnedModelId = null,
            CancellationToken ct = default)
            => Task.FromResult(Resolution());

        public Task<List<AvailableModelPool>> GetAvailablePoolsAsync(string appCallerCode, string modelType, CancellationToken ct = default)
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

        private static GatewayModelResolution Resolution() => new()
        {
            Success = true,
            ActualModel = "test-model",
            ActualPlatformId = "platform",
            Protocol = "openai",
        };
    }
}
