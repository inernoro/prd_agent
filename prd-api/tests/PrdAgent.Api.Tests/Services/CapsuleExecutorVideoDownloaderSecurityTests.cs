using System.Text;
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
