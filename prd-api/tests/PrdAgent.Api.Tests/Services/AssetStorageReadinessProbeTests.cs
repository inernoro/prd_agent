using System.Net;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Api.Services;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public sealed class AssetStorageReadinessProbeTests
{
    [Fact]
    public async Task CheckAsync_ShouldRejectProviderDriftBeforeWriting()
    {
        var storage = new ProbeAssetStorage("cloudflareR2");
        var probe = CreateProbe(storage, "tencentCos");

        var result = await probe.CheckAsync(force: true);

        result.Status.ShouldBe("unhealthy");
        result.ErrorCode.ShouldBe("provider_mismatch");
        result.Provider.ShouldBe("cloudflareR2");
        result.ExpectedProvider.ShouldBe("tencentCos");
        storage.UploadCount.ShouldBe(0);
    }

    [Fact]
    public async Task CheckAsync_ShouldVerifyWriteBothReadsAndCleanup()
    {
        var storage = new ProbeAssetStorage("tencentCos");
        var probe = CreateProbe(storage, "cos");

        var result = await probe.CheckAsync(force: true);

        result.Status.ShouldBe("healthy");
        result.Provider.ShouldBe("tencentCos");
        result.WriteVerified.ShouldBeTrue();
        result.InternalReadVerified.ShouldBeTrue();
        result.PublicReadVerified.ShouldBeTrue();
        result.CleanupVerified.ShouldBeTrue();
        storage.UploadCount.ShouldBe(1);
        storage.DeleteCount.ShouldBe(1);
        storage.ObjectCount.ShouldBe(0);
    }

    [Theory]
    [InlineData(ProbeFailure.Write, "write_failed")]
    [InlineData(ProbeFailure.InternalRead, "internal_read_failed")]
    [InlineData(ProbeFailure.PublicRead, "public_read_failed")]
    [InlineData(ProbeFailure.Cleanup, "cleanup_failed")]
    public async Task CheckAsync_ShouldReportEachStorageContractFailure(
        ProbeFailure failure,
        string expectedErrorCode)
    {
        var storage = new ProbeAssetStorage("tencentCos")
        {
            Failure = failure,
        };
        var probe = CreateProbe(storage, "tencentCos");

        var result = await probe.CheckAsync(force: true);

        result.Status.ShouldBe("unhealthy");
        result.ErrorCode.ShouldBe(expectedErrorCode);
        result.ErrorMessage.ShouldNotBeNullOrWhiteSpace();
        result.ErrorMessage.ToLowerInvariant().ShouldNotContain("secret");
        if (failure != ProbeFailure.Write)
        {
            storage.DeleteCount.ShouldBe(1);
        }
    }

    [Fact]
    public async Task CheckAsync_ShouldCacheSuccessfulProbeWithinConfiguredWindow()
    {
        var storage = new ProbeAssetStorage("tencentCos");
        var probe = CreateProbe(storage, "tencentCos", cacheSeconds: 300);

        var first = await probe.CheckAsync();
        var second = await probe.CheckAsync();

        first.ShouldBeSameAs(second);
        storage.UploadCount.ShouldBe(1);
        storage.DeleteCount.ShouldBe(1);
    }

    [Fact]
    public async Task CheckAsync_ShouldNotCacheFailureAcrossRecoveryRetry()
    {
        var storage = new ProbeAssetStorage("tencentCos")
        {
            Failure = ProbeFailure.Write,
        };
        var probe = CreateProbe(storage, "tencentCos", cacheSeconds: 300);

        var failed = await probe.CheckAsync();
        storage.Failure = ProbeFailure.None;
        var recovered = await probe.CheckAsync();

        failed.Status.ShouldBe("unhealthy");
        recovered.Status.ShouldBe("healthy");
        storage.UploadCount.ShouldBe(2);
        storage.DeleteCount.ShouldBe(1);
    }

    [Fact]
    public async Task CheckAsync_ShouldCoalesceConcurrentHealthChecksIntoOneProbe()
    {
        var storage = new ProbeAssetStorage("tencentCos")
        {
            UploadDelay = TimeSpan.FromMilliseconds(50),
        };
        var probe = CreateProbe(storage, "tencentCos", cacheSeconds: 300);

        var results = await Task.WhenAll(Enumerable.Range(0, 12)
            .Select(_ => probe.CheckAsync()));

        results.ShouldAllBe(result => result.Status == "healthy");
        storage.UploadCount.ShouldBe(1);
        storage.DeleteCount.ShouldBe(1);
    }

    [Fact]
    public async Task CheckAsync_ShouldAbsorbOneTransientPublicPropagationMiss()
    {
        var storage = new ProbeAssetStorage("tencentCos")
        {
            PublicReadFailuresRemaining = 1,
        };
        var probe = CreateProbe(storage, "tencentCos");

        var result = await probe.CheckAsync(force: true);

        result.Status.ShouldBe("healthy");
        result.PublicReadVerified.ShouldBeTrue();
        storage.PublicReadCount.ShouldBe(2);
    }

    [Fact]
    public async Task CheckAsync_ShouldVerifyLocalAssetThroughApplicationUrl()
    {
        var storage = new ProbeAssetStorage("local");
        var probe = CreateProbe(
            storage,
            expectedProvider: "local",
            publicBaseUrl: "https://app.test");

        var result = await probe.CheckAsync(force: true);

        result.Status.ShouldBe("healthy");
        result.PublicReadVerified.ShouldBeTrue();
        storage.PublicReadCount.ShouldBe(1);
        storage.DeleteCount.ShouldBe(1);
    }

    [Fact]
    public async Task CheckAsync_ShouldRejectUnverifiableLocalPublicUrl()
    {
        var storage = new ProbeAssetStorage("local");
        var probe = CreateProbe(storage, expectedProvider: "local");

        var result = await probe.CheckAsync(force: true);

        result.Status.ShouldBe("unhealthy");
        result.ErrorCode.ShouldBe("public_read_failed");
        result.PublicReadVerified.ShouldBeFalse();
        storage.PublicReadCount.ShouldBe(0);
        storage.DeleteCount.ShouldBe(1);
    }

    [Theory]
    [InlineData("Tencent-COS", "tencentCos")]
    [InlineData("cos", "tencentCos")]
    [InlineData("Cloudflare_R2", "cloudflareR2")]
    [InlineData("r2", "cloudflareR2")]
    [InlineData("local", "local")]
    public void CanonicalProvider_ShouldNormalizeSupportedAliases(string input, string expected)
    {
        AssetStorageReadinessProbe.CanonicalProvider(input).ShouldBe(expected);
    }

    [Theory]
    [InlineData("127.0.0.1", true)]
    [InlineData("::1", true)]
    [InlineData("10.0.0.8", false)]
    [InlineData("203.0.113.10", false)]
    public void ForceProbe_ShouldOnlyAllowContainerLoopback(
        string remoteAddress,
        bool expected)
    {
        AssetStorageReadinessProbe
            .CanForceProbe(IPAddress.Parse(remoteAddress))
            .ShouldBe(expected);
    }

    private static AssetStorageReadinessProbe CreateProbe(
        ProbeAssetStorage storage,
        string? expectedProvider,
        int cacheSeconds = 120,
        string? publicBaseUrl = null)
    {
        var values = new Dictionary<string, string?>
        {
            ["ASSETS_EXPECTED_PROVIDER"] = expectedProvider,
            ["AssetStorageReadiness:CacheSeconds"] = cacheSeconds.ToString(),
            ["AssetStorageReadiness:PublicBaseUrl"] = publicBaseUrl,
        };
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(values)
            .Build();
        var handler = new ProbeHttpMessageHandler(storage);
        var factory = new ProbeHttpClientFactory(handler);
        return new AssetStorageReadinessProbe(
            storage,
            storage,
            factory,
            configuration,
            NullLogger<AssetStorageReadinessProbe>.Instance);
    }

    public enum ProbeFailure
    {
        None,
        Write,
        InternalRead,
        PublicRead,
        Cleanup,
    }

    private sealed class ProbeAssetStorage : IAssetStorage, IAssetStorageRuntimeInfo
    {
        private readonly Dictionary<string, byte[]> _objects = new(StringComparer.Ordinal);

        public ProbeAssetStorage(string providerName)
        {
            ProviderName = providerName;
        }

        public string ProviderName { get; }
        public ProbeFailure Failure { get; set; }
        public int PublicReadFailuresRemaining { get; set; }
        public TimeSpan UploadDelay { get; set; }
        public int UploadCount { get; private set; }
        public int DeleteCount { get; private set; }
        public int PublicReadCount { get; private set; }
        public int ObjectCount => _objects.Count;

        public Task<StoredAsset> SaveAsync(
            byte[] bytes,
            string mime,
            CancellationToken ct,
            string? domain = null,
            string? type = null,
            string? fileName = null,
            string? extensionHint = null)
            => throw new NotSupportedException();

        public Task<(byte[] bytes, string mime)?> TryReadByShaAsync(
            string sha256,
            CancellationToken ct,
            string? domain = null,
            string? type = null)
            => Task.FromResult<(byte[] bytes, string mime)?>(null);

        public Task DeleteByShaAsync(
            string sha256,
            CancellationToken ct,
            string? domain = null,
            string? type = null)
            => Task.CompletedTask;

        public string? TryBuildUrlBySha(
            string sha256,
            string mime,
            string? domain = null,
            string? type = null)
            => null;

        public Task<byte[]?> TryDownloadBytesAsync(string key, CancellationToken ct)
        {
            if (Failure == ProbeFailure.InternalRead)
            {
                return Task.FromResult<byte[]?>(new byte[] { 0 });
            }
            return Task.FromResult(_objects.TryGetValue(key, out var bytes) ? bytes : null);
        }

        public Task<bool> ExistsAsync(string key, CancellationToken ct)
            => Task.FromResult(_objects.ContainsKey(key));

        public async Task UploadToKeyAsync(
            string key,
            byte[] bytes,
            string? contentType,
            CancellationToken ct,
            string? cacheControl = null)
        {
            UploadCount++;
            if (UploadDelay > TimeSpan.Zero)
            {
                await Task.Delay(UploadDelay, ct);
            }
            if (Failure == ProbeFailure.Write)
            {
                throw new HttpRequestException("secret provider detail");
            }
            _objects[key] = bytes.ToArray();
        }

        public string BuildUrlForKey(string key)
            => ProviderName == "local"
                ? $"/local-assets/{Uri.EscapeDataString(key)}"
                : $"https://assets.test/{Uri.EscapeDataString(key)}";

        public Task DeleteByKeyAsync(string key, CancellationToken ct)
        {
            DeleteCount++;
            if (Failure == ProbeFailure.Cleanup)
            {
                throw new HttpRequestException("cleanup denied");
            }
            _objects.Remove(key);
            return Task.CompletedTask;
        }

        public string BuildSiteKey(string siteId, string filePath)
            => $"{siteId}/{filePath}";

        public byte[]? PublicBytes()
        {
            PublicReadCount++;
            if (Failure == ProbeFailure.PublicRead || PublicReadFailuresRemaining-- > 0)
            {
                return null;
            }
            return _objects.Values.SingleOrDefault();
        }
    }

    private sealed class ProbeHttpMessageHandler : HttpMessageHandler
    {
        private readonly ProbeAssetStorage _storage;

        public ProbeHttpMessageHandler(ProbeAssetStorage storage)
        {
            _storage = storage;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var bytes = _storage.PublicBytes();
            if (bytes == null)
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
            }
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new ByteArrayContent(bytes),
            });
        }
    }

    private sealed class ProbeHttpClientFactory : IHttpClientFactory
    {
        private readonly HttpMessageHandler _handler;

        public ProbeHttpClientFactory(HttpMessageHandler handler)
        {
            _handler = handler;
        }

        public HttpClient CreateClient(string name)
            => new(_handler, disposeHandler: false);
    }
}
