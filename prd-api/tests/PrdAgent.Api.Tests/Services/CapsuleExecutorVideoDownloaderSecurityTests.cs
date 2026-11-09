using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Moq;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Microsoft.Extensions.DependencyInjection;
using PrdAgent.Api.Services;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services;
using Shouldly;
using Xunit;

namespace PrdAgent.Api.Tests.Services;

public class CapsuleExecutorVideoDownloaderSecurityTests
{
    [Fact]
    public void ResolveDownloadedVideoContentType_ShouldDetectMp4WhenServerReturnsOctetStream()
    {
        CapsuleExecutor.ResolveDownloadedVideoContentType(Mp4Bytes(), "application/octet-stream")
            .ShouldBe("video/mp4");
    }

    [Theory]
    [InlineData("free")]
    [InlineData("skip")]
    [InlineData("wide")]
    public void ResolveDownloadedVideoContentType_ShouldParseLeadingIsoBmffBoxes(string leadingBoxType)
    {
        var bytes = Box(leadingBoxType, new byte[12])
            .Concat(Mp4Bytes())
            .ToArray();

        CapsuleExecutor.ResolveDownloadedVideoContentType(bytes, "video/mp4")
            .ShouldBe("video/mp4");
    }

    [Theory]
    [InlineData("avif", "mif1")]
    [InlineData("heic", "mif1")]
    [InlineData("M4A ", "isom")]
    public void ResolveDownloadedVideoContentType_ShouldRejectNonVideoIsoBmffBrands(
        string majorBrand,
        string compatibleBrand)
    {
        var bytes = FtypBytes(majorBrand, compatibleBrand);

        Should.Throw<InvalidOperationException>(() =>
                CapsuleExecutor.ResolveDownloadedVideoContentType(bytes, "application/octet-stream"))
            .Message.ShouldContain("无法识别的二进制格式");
        Should.Throw<InvalidOperationException>(() =>
                CapsuleExecutor.ResolveDownloadedVideoContentType(bytes, "video/mp4"))
            .Message.ShouldContain("文件签名不是受支持的视频容器");
    }

    [Fact]
    public void ResolveDownloadedVideoContentType_ShouldPreserveWebmContainer()
    {
        var bytes = new byte[] { 0x1A, 0x45, 0xDF, 0xA3 }
            .Concat(Encoding.ASCII.GetBytes("header-webm-video"))
            .ToArray();

        CapsuleExecutor.ResolveDownloadedVideoContentType(bytes, null)
            .ShouldBe("video/webm");
    }

    [Fact]
    public void ResolveDownloadedVideoContentType_ShouldRejectUnknownBinary()
    {
        var ex = Should.Throw<InvalidOperationException>(() =>
            CapsuleExecutor.ResolveDownloadedVideoContentType(
                Encoding.ASCII.GetBytes("not-a-video-container"),
                "application/octet-stream"));

        ex.Message.ShouldContain("无法识别的二进制格式");
    }

    [Fact]
    public void ResolveDownloadedVideoContentType_ShouldNormalizeM4vAndRejectOgv()
    {
        CapsuleExecutor.ResolveDownloadedVideoContentType(Mp4Bytes(), "video/x-m4v")
            .ShouldBe("video/mp4");
        var ex = Should.Throw<InvalidOperationException>(() =>
            CapsuleExecutor.ResolveDownloadedVideoContentType(
                new byte[] { (byte)'O', (byte)'g', (byte)'g', (byte)'S' },
                "application/octet-stream"));

        ex.Message.ShouldContain("不支持 OGV");
    }

    [Fact]
    public void ResolveDownloadedVideoContentType_ShouldRejectDeclaredVideoWhenSignatureIsNotVideo()
    {
        var ex = Should.Throw<InvalidOperationException>(() =>
            CapsuleExecutor.ResolveDownloadedVideoContentType(
                Encoding.UTF8.GetBytes("<html>sign in required</html>"),
                "video/mp4"));

        ex.Message.ShouldContain("文件签名不是受支持的视频容器");
    }

    [Theory]
    [InlineData("video/mp4")]
    [InlineData("video/x-m4v")]
    public void ResolveDownloadedVideoContentType_ShouldAcceptMp4CompatibleDeclarations(string declaredType)
    {
        CapsuleExecutor.ResolveDownloadedVideoContentType(Mp4Bytes(), declaredType)
            .ShouldBe("video/mp4");
    }

    [Fact]
    public void ResolveDownloadedVideoContentType_ShouldRejectContainerMismatch()
    {
        var webm = new byte[] { 0x1A, 0x45, 0xDF, 0xA3 }
            .Concat(Encoding.ASCII.GetBytes("header-webm-video"))
            .ToArray();

        var ex = Should.Throw<InvalidOperationException>(() =>
            CapsuleExecutor.ResolveDownloadedVideoContentType(webm, "video/mp4"));

        ex.Message.ShouldContain("文件签名实际为 video/webm");
    }


    [Fact]
    public async Task ExecuteVideoDownloaderAsync_ShouldBlockPrivateNetworkTargets()
    {
        using var services = BuildServices();
        var node = new WorkflowNode
        {
            NodeId = "video-download-test",
            Name = "视频下载安全测试",
            NodeType = CapsuleTypes.VideoDownloader,
            Config = new Dictionary<string, object?>
            {
                ["videoUrl"] = "http://169.254.169.254/latest/meta-data",
            },
        };

        var ex = await Should.ThrowAsync<InvalidOperationException>(() =>
            CapsuleExecutor.ExecuteVideoDownloaderAsync(
                services,
                node,
                new Dictionary<string, string>(),
                new List<ExecutionArtifact>()));

        ex.Message.ShouldContain("内网或保留地址");
    }

    [Theory]
    [Trait("Category", "Integration")]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ExecuteVideoDownloaderAsync_ShouldRejectOversizeBeforeStorage(bool declaredLength)
    {
        using var content = declaredLength
            ? (HttpContent)new ByteArrayContent(new byte[17])
            : new StreamContent(new NonSeekableStream(new byte[17]));
        content.Headers.ContentType = new MediaTypeHeaderValue("video/mp4");
        using var services = BuildDownloadServices(content, out var storage);
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 16));
        ex.Message.ShouldContain("超过大小限制");
        ex.Message.ShouldContain("status=200");
        ex.Message.ShouldContain("decision=rejected");
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task ExecuteVideoDownloaderAsync_ShouldRejectFalseVideoBeforeStorage()
    {
        using var content = new ByteArrayContent(Encoding.UTF8.GetBytes("<html>sign in required</html>"));
        content.Headers.ContentType = new MediaTypeHeaderValue("video/mp4");
        using var services = BuildDownloadServices(content, out var storage);
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 1024));
        ex.Message.ShouldContain("文件签名不是受支持的视频容器");
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task ExecuteVideoDownloaderAsync_ShouldStoreDetectedWebmAndReturnMatchingMetadata()
    {
        var bytes = new byte[] { 0x1A, 0x45, 0xDF, 0xA3 }
            .Concat(Encoding.ASCII.GetBytes("header-webm-video")).ToArray();
        using var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        using var services = BuildDownloadServices(content, out var storage);
        storage.Setup(x => x.SaveAsync(It.Is<byte[]>(b => b.SequenceEqual(bytes)), "video/webm",
                It.IsAny<CancellationToken>(), "workflow-agent", "doc", null, null))
            .ReturnsAsync(new StoredAsset("synthetic-sha", "https://assets.example.invalid/video.webm", bytes.Length, "video/webm"));
        var result = await Download(services, 1024);
        result.Artifacts.Single().InlineContent.ShouldNotBeNull();
        result.Artifacts.Single().InlineContent!.ShouldContain("video/webm");
        result.Logs.ShouldContain("sha256=");
        result.Logs.ShouldContain("decision=accepted");
        storage.VerifyAll();
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task ExecuteVideoDownloaderAsync_ShouldKeepDeadlineWhileReadingBody()
    {
        using var content = new StreamContent(new StallingStream());
        content.Headers.ContentType = new MediaTypeHeaderValue("video/mp4");
        using var services = BuildDownloadServices(content, out var storage);
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 1024, 1));
        ex.Message.ShouldContain("decision=rejected");
        storage.VerifyNoOtherCalls();
    }

    [Theory]
    [Trait("Category", "Integration")]
    [InlineData("application/json", "{\"error\":{\"code\":\"LINK_EXPIRED\",\"message\":\"link-expired\",\"accessToken\":\"private-token-marker\"}}")]
    [InlineData("text/html", "<html>link-expired Authorization: Bearer private-token-marker</html>")]
    [InlineData("application/json", "\"link-expired Authorization: Bearer private-token-marker\"")]
    public async Task ExecuteVideoDownloaderAsync_ShouldRetainRedactedErrorResponseBeforeRejecting(string mime, string body)
    {
        using var content = new ByteArrayContent(Encoding.UTF8.GetBytes(body));
        content.Headers.ContentType = new MediaTypeHeaderValue(mime);
        using var services = BuildDownloadServices(content, out var storage, HttpStatusCode.Forbidden);
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 8192));
        ex.Message.ShouldContain("link-expired");
        ex.Message.ShouldContain("status=403");
        ex.Message.ShouldNotContain("private-token-marker");
        ex.Message.ShouldContain("prefixSha256");
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", "Integration")]
    public async Task ExecuteVideoDownloaderAsync_ShouldBoundUnknownLengthErrorEvidence()
    {
        var source = new NonSeekableStream(Encoding.UTF8.GetBytes("link-expired token=private-token-marker" + new string('x', 12000)));
        using var content = new StreamContent(source);
        content.Headers.ContentType = new MediaTypeHeaderValue("text/plain");
        using var services = BuildDownloadServices(content, out var storage, HttpStatusCode.Forbidden);
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 8192));
        ex.Message.ShouldContain("link-expired");
        ex.Message.ShouldContain("\"bodyComplete\":false");
        ex.Message.ShouldNotContain("private-token-marker");
        source.BytesRead.ShouldBe(4096);
        storage.VerifyNoOtherCalls();
    }

    private static Task<CapsuleExecutor.CapsuleResult> Download(ServiceProvider services, long maxBytes, int timeoutSeconds = 120)
        => CapsuleExecutor.ExecuteVideoDownloaderAsync(services, new WorkflowNode
        {
            NodeId = "local-download-integration",
            Name = "本地合成视频下载",
            NodeType = CapsuleTypes.VideoDownloader,
            Config = new Dictionary<string, object?>
            {
                ["videoUrl"] = "https://download.example.invalid/video",
                ["maxFileSizeBytes"] = maxBytes.ToString(),
                ["timeoutSeconds"] = timeoutSeconds.ToString(),
            },
        }, new Dictionary<string, string>(), new List<ExecutionArtifact>());

    private static ServiceProvider BuildDownloadServices(HttpContent content, out Mock<IAssetStorage> storage, HttpStatusCode status = HttpStatusCode.OK)
    {
        var services = new ServiceCollection();
        storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        services.AddSingleton(storage.Object);
        var validator = new Mock<ISafeOutboundUrlValidator>(MockBehavior.Strict);
        validator.Setup(x => x.EnsureSafeHttpUrlAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((string url, string purpose, CancellationToken ct) => new Uri(url));
        services.AddSingleton(validator.Object);
        services.AddHttpClient("SafeOutbound").ConfigurePrimaryHttpMessageHandler(() => new SyntheticHandler(content, status));
        return services.BuildServiceProvider();
    }

    private sealed class SyntheticHandler(HttpContent content, HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(new HttpResponseMessage(status) { Content = content });
    }

    private sealed class StallingStream : MemoryStream
    {
        public override bool CanSeek => false;
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
            return 0;
        }
    }

    private sealed class NonSeekableStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override bool CanSeek => false;
        public int BytesRead { get; private set; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            var read = await base.ReadAsync(buffer, cancellationToken);
            BytesRead += read;
            return read;
        }
    }

    [Fact]
    public async Task ReadContentWithLimitAsync_ShouldRejectDeclaredOversizeBeforeReading()
    {
        using var content = new ByteArrayContent(new byte[16]);
        content.Headers.ContentLength = 16;

        var ex = await Should.ThrowAsync<InvalidOperationException>(() =>
            CapsuleExecutor.ReadContentWithLimitAsync(content, 8, CancellationToken.None));

        ex.Message.ShouldContain("超过大小限制");
    }

    [Fact]
    public async Task ReadContentWithLimitAsync_ShouldStopChunkedResponseAtHardLimit()
    {
        using var content = new StreamContent(new MemoryStream(new byte[17]));

        var ex = await Should.ThrowAsync<InvalidOperationException>(() =>
            CapsuleExecutor.ReadContentWithLimitAsync(content, 16, CancellationToken.None));

        ex.Message.ShouldContain("超过大小限制");
    }

    private static ServiceProvider BuildServices()
    {
        var services = new ServiceCollection();
        services.AddSingleton<ISafeOutboundUrlValidator, SafeOutboundUrlValidator>();
        services.AddSingleton<ISafeOutboundHttpHandlerFactory, SafeOutboundHttpHandlerFactory>();
        services.AddHttpClient("SafeOutbound")
            .ConfigurePrimaryHttpMessageHandler(sp =>
                sp.GetRequiredService<ISafeOutboundHttpHandlerFactory>().CreateHandler());
        return services.BuildServiceProvider();
    }
    private static byte[] Mp4Bytes() => FtypBytes("isom", "mp42", "avc1");

    private static byte[] FtypBytes(string majorBrand, params string[] compatibleBrands)
    {
        var payload = Encoding.ASCII.GetBytes(majorBrand)
            .Concat(new byte[4])
            .Concat(compatibleBrands.SelectMany(Encoding.ASCII.GetBytes))
            .ToArray();
        return Box("ftyp", payload);
    }

    private static byte[] Box(string type, byte[] payload)
    {
        var size = 8 + payload.Length;
        return new byte[]
        {
            (byte)(size >> 24),
            (byte)(size >> 16),
            (byte)(size >> 8),
            (byte)size,
        }
        .Concat(Encoding.ASCII.GetBytes(type))
        .Concat(payload)
        .ToArray();
    }
}
