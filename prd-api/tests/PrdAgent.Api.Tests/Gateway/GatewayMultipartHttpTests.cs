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
using MongoDB.Bson;
using MongoDB.Driver;
using PrdAgent.Core.Interfaces;
using PrdAgent.Infrastructure.Database;
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
    public async Task ScopedRawEndpoint_RejectsMultipartRefOwnedByAnotherTenantBeforeDownload()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var bytes = Encoding.UTF8.GetBytes("tenant-b-secret-image");
        const string key = "llmgw/multipart/tenant-b/image.png";
        var storage = new MemoryAssetStorage();
        await storage.UploadToKeyAsync(key, bytes, "image/png", CancellationToken.None);
        await scope.Context.Database.GetCollection<GatewayMultipartObjectRecord>("llmgw_multipart_objects")
            .InsertOneAsync(new GatewayMultipartObjectRecord
            {
                TenantId = "tenant-b",
                RefKey = key,
                Sha256 = Sha256Hex(bytes),
                SizeBytes = bytes.LongLength,
                Status = "uploaded",
            });
        var gateway = new CapturingGateway();

        await using var app = BuildHost(
            storage,
            gateway,
            scope.Context,
            new StaticTenantKeyAuthorizer("tenant-a"));
        await app.StartAsync();
        try
        {
            HttpRequestMessage CreateRequest()
            {
                var request = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/raw")
                {
                    Content = JsonContent.Create(new GatewayRawRequest
                    {
                        AppCallerCode = "tenant-a.app::vision",
                        ModelType = "vision",
                        IsMultipart = true,
                        Context = new GatewayRequestContext { TenantId = "tenant-b" },
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
                    }, options: PascalJson),
                };
                request.Headers.Add("X-Gateway-Key", "tenant-a-scoped-key");
                return request;
            }

            using var crossTenantRequest = CreateRequest();
            var response = await app.GetTestClient().SendAsync(crossTenantRequest);
            var raw = JsonSerializer.Deserialize<GatewayRawResponse>(
                await response.Content.ReadAsStringAsync(),
                PascalJson);

            response.StatusCode.ShouldBe(HttpStatusCode.NotFound);
            raw.ShouldNotBeNull();
            raw!.ErrorCode.ShouldBe("MULTIPART_REF_NOT_FOUND");
            storage.DownloadCount.ShouldBe(0);
            storage.DeleteCount.ShouldBe(0);
            gateway.CapturedRaw.ShouldBeNull();

            await scope.Context.Database.GetCollection<GatewayMultipartObjectRecord>("llmgw_multipart_objects")
                .InsertOneAsync(new GatewayMultipartObjectRecord
                {
                    TenantId = "tenant-a",
                    RefKey = key,
                    Sha256 = Sha256Hex(bytes),
                    SizeBytes = bytes.LongLength,
                    Status = "uploaded",
                });
            using var ownTenantRequest = CreateRequest();
            var ownTenantResponse = await app.GetTestClient().SendAsync(ownTenantRequest);

            ownTenantResponse.StatusCode.ShouldBe(HttpStatusCode.OK);
            storage.DownloadCount.ShouldBe(1);
            storage.DeleteCount.ShouldBe(1);
            gateway.CapturedRaw.ShouldNotBeNull();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task ScopedRawEndpoint_DoesNotCleanupUnverifiedRefsWhenInlineFilesBypassRehydration()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        var victimBytes = Encoding.UTF8.GetBytes("tenant-b-secret-image");
        var inlineBytes = Encoding.UTF8.GetBytes("tenant-a-inline-image");
        const string key = "llmgw/multipart/tenant-b/mixed-image.png";
        var storage = new MemoryAssetStorage();
        await storage.UploadToKeyAsync(key, victimBytes, "image/png", CancellationToken.None);
        await scope.Context.Database.GetCollection<GatewayMultipartObjectRecord>("llmgw_multipart_objects")
            .InsertOneAsync(new GatewayMultipartObjectRecord
            {
                TenantId = "tenant-b",
                RefKey = key,
                Sha256 = Sha256Hex(victimBytes),
                SizeBytes = victimBytes.LongLength,
                Status = "uploaded",
            });

        await using var app = BuildHost(
            storage,
            new CapturingGateway(),
            scope.Context,
            new StaticTenantKeyAuthorizer("tenant-a"));
        await app.StartAsync();
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/raw")
            {
                Content = JsonContent.Create(new GatewayRawRequest
                {
                    AppCallerCode = "tenant-a.app::vision",
                    ModelType = "vision",
                    IsMultipart = true,
                    Context = new GatewayRequestContext { TenantId = "tenant-b" },
                    MultipartFiles = new Dictionary<string, (string FileName, byte[] Content, string MimeType)>
                    {
                        ["inline"] = ("inline.png", inlineBytes, "image/png"),
                    },
                    MultipartFileRefs = new Dictionary<string, MultipartFileRef>
                    {
                        ["victim"] = new()
                        {
                            RefKey = key,
                            FileName = "mixed-image.png",
                            MimeType = "image/png",
                            SizeBytes = victimBytes.LongLength,
                            Sha256 = Sha256Hex(victimBytes),
                        },
                    },
                }, options: PascalJson),
            };
            request.Headers.Add("X-Gateway-Key", "tenant-a-scoped-key");

            var response = await app.GetTestClient().SendAsync(request);

            response.StatusCode.ShouldBe(HttpStatusCode.OK);
            storage.DownloadCount.ShouldBe(0);
            storage.DeleteCount.ShouldBe(0);
            (await storage.ExistsAsync(key, CancellationToken.None)).ShouldBeTrue();
        }
        finally
        {
            await app.StopAsync();
        }
    }

    [Fact]
    public async Task ScopedRawEndpoint_IdempotencyIgnoresClientReportedTenantContext()
    {
        var testDatabase = await TryCreateDatabaseAsync();
        if (testDatabase is null) return;
        await using var scope = testDatabase;
        await scope.Context.Database.GetCollection<GatewayRequestExecutionRecord>("llmgw_request_executions")
            .Indexes.CreateOneAsync(new CreateIndexModel<GatewayRequestExecutionRecord>(
                Builders<GatewayRequestExecutionRecord>.IndexKeys
                    .Ascending(x => x.TenantId)
                    .Ascending(x => x.AppCallerCode)
                    .Ascending(x => x.RequestId)
                    .Ascending(x => x.Operation),
                new CreateIndexOptions { Unique = true }));
        var bytes = Encoding.UTF8.GetBytes("tenant-a-owned-image");
        const string key = "llmgw/multipart/tenant-a/idempotent-image.png";
        var storage = new MemoryAssetStorage();
        await storage.UploadToKeyAsync(key, bytes, "image/png", CancellationToken.None);
        await scope.Context.Database.GetCollection<GatewayMultipartObjectRecord>("llmgw_multipart_objects")
            .InsertOneAsync(new GatewayMultipartObjectRecord
            {
                TenantId = "tenant-a",
                RefKey = key,
                Sha256 = Sha256Hex(bytes),
                SizeBytes = bytes.LongLength,
                Status = "uploaded",
            });

        await using var app = BuildHost(
            storage,
            new CapturingGateway(),
            scope.Context,
            new StaticTenantKeyAuthorizer("tenant-a"));
        await app.StartAsync();
        try
        {
            HttpRequestMessage CreateRequest(string clientTenantId)
            {
                var request = new HttpRequestMessage(HttpMethod.Post, "/gw/v1/raw")
                {
                    Content = JsonContent.Create(new GatewayRawRequest
                    {
                        AppCallerCode = "tenant-a.app::vision",
                        ModelType = "vision",
                        IsMultipart = true,
                        Context = new GatewayRequestContext
                        {
                            TenantId = clientTenantId,
                            RequestId = "stable-idempotency-request",
                        },
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
                    }, options: PascalJson),
                };
                request.Headers.Add("X-Gateway-Key", "tenant-a-scoped-key");
                return request;
            }

            using var firstRequest = CreateRequest("tenant-a");
            var first = await app.GetTestClient().SendAsync(firstRequest);
            using var retryRequest = CreateRequest("tenant-b-client-spoof");
            var retry = await app.GetTestClient().SendAsync(retryRequest);

            first.StatusCode.ShouldBe(HttpStatusCode.OK);
            retry.StatusCode.ShouldBe(HttpStatusCode.OK);
            storage.DownloadCount.ShouldBe(1);
            storage.DeleteCount.ShouldBe(1);
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

            response.StatusCode.ShouldBe(HttpStatusCode.BadRequest);
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

    private static WebApplication BuildHost(
        MemoryAssetStorage storage,
        CapturingGateway gateway,
        LlmGatewayDataContext? data = null,
        IGatewayScopedKeyAuthorizer? keyAuthorizer = null)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseTestServer();
        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.PropertyNamingPolicy = null);
        builder.Services.AddSingleton<IAssetStorage>(storage);
        builder.Services.AddSingleton<PrdAgent.Infrastructure.LlmGateway.ILlmGateway>(gateway);
        builder.Services.AddSingleton<ILLMRequestContextAccessor, PrdAgent.Core.Services.LLMRequestContextAccessor>();
        if (data is not null)
        {
            builder.Services.AddSingleton(data);
            builder.Services.AddSingleton(new GatewayRequestExecutionStore(data));
        }
        if (keyAuthorizer is not null) builder.Services.AddSingleton(keyAuthorizer);

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

    private static async Task<TestDatabase?> TryCreateDatabaseAsync()
    {
        var connectionString = Environment.GetEnvironmentVariable("MONGODB_TEST_CONNECTION")
                               ?? "mongodb://localhost:27017";
        var settings = MongoClientSettings.FromConnectionString(connectionString);
        settings.ServerSelectionTimeout = TimeSpan.FromSeconds(2);
        var client = new MongoClient(settings);
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
            await client.GetDatabase("admin").RunCommandAsync<BsonDocument>(
                new BsonDocument("ping", 1),
                cancellationToken: cts.Token);
            var databaseName = $"llmgw_multipart_tenant_test_{Guid.NewGuid():N}";
            return new TestDatabase(client, databaseName, new LlmGatewayDataContext(connectionString, databaseName));
        }
        catch
        {
            return null;
        }
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
        public int DownloadCount { get; private set; }
        public int DeleteCount { get; private set; }

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
        {
            DownloadCount++;
            return Task.FromResult(_objects.TryGetValue(key, out var value) ? value.Bytes : null);
        }

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
            DeleteCount++;
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

    private sealed class StaticTenantKeyAuthorizer : IGatewayScopedKeyAuthorizer
    {
        private readonly string _tenantId;

        public StaticTenantKeyAuthorizer(string tenantId) => _tenantId = tenantId;

        public Task<GatewayKeyAuthorization> AuthorizeAsync(
            string providedKey,
            string legacySharedKey,
            string sourceSystem,
            string appCallerCode,
            string ingressProtocol,
            string requiredScope,
            System.Net.IPAddress? remoteIp,
            CancellationToken ct)
            => Task.FromResult(new GatewayKeyAuthorization(
                true,
                true,
                200,
                string.Empty,
                "allowed",
                "tenant-key",
                _tenantId));
    }

    private sealed class TestDatabase : IAsyncDisposable
    {
        private readonly MongoClient _client;
        private readonly string _databaseName;

        public TestDatabase(MongoClient client, string databaseName, LlmGatewayDataContext context)
        {
            _client = client;
            _databaseName = databaseName;
            Context = context;
        }

        public LlmGatewayDataContext Context { get; }

        public async ValueTask DisposeAsync() => await _client.DropDatabaseAsync(_databaseName);
    }
}
