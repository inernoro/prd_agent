using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Moq;
using MongoDB.Driver;
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
    [Trait("Category", "Unit")]
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
        var audit = services.GetRequiredService<List<ApiRequestLog>>().Single();
        audit.StatusCode.ShouldBe(200);
        audit.ResponseBody.ShouldNotBeNull();
        audit.ResponseBody!.ShouldContain("decision=rejected");
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", "Unit")]
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
    [Trait("Category", "Unit")]
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
        result.Logs.ShouldContain("host=download.example.invalid");
        result.Logs.ShouldNotContain("synthetic-query-marker");
        storage.VerifyAll();
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", "Unit")]
    public async Task ExecuteVideoDownloaderAsync_ShouldKeepDeadlineWhileReadingBody()
    {
        using var content = new StreamContent(new StallingStream());
        content.Headers.ContentType = new MediaTypeHeaderValue("video/mp4");
        using var services = BuildDownloadServices(content, out var storage);
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 1024, 1));
        services.GetRequiredService<List<ApiRequestLog>>().Single().ResponseBody!.ShouldContain("decision=rejected");
        storage.VerifyNoOtherCalls();
    }

    [Theory]
    [Trait("Category", "Unit")]
    [InlineData("application/json", "{\"error\":{\"code\":\"LINK_EXPIRED\",\"message\":\"link-expired\",\"accessToken\":\"private-token-marker\"}}")]
    [InlineData("text/html", "<html>link-expired Authorization: Bearer private-token-marker</html>")]
    [InlineData("application/json", "\"link-expired Authorization: Bearer private-token-marker\"")]
    public async Task ExecuteVideoDownloaderAsync_ShouldRetainRedactedErrorResponseBeforeRejecting(string mime, string body)
    {
        using var content = new ByteArrayContent(Encoding.UTF8.GetBytes(body));
        content.Headers.ContentType = new MediaTypeHeaderValue(mime);
        using var services = BuildDownloadServices(content, out var storage, HttpStatusCode.Forbidden);
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 8192));
        ex.Message.ShouldNotContain("link-expired");
        ex.Message.ShouldNotContain("status=403");
        ex.Message.ShouldNotContain("private-token-marker");
        ex.Message.ShouldNotContain("prefixSha256");
        ex.Message.ShouldContain("请检查视频来源");
        var audit = services.GetRequiredService<List<ApiRequestLog>>().Single();
        audit.StatusCode.ShouldBe(403);
        audit.RequestId.ShouldBe("synthetic-operation");
        audit.SessionId.ShouldBe("synthetic-execution");
        audit.UserId.ShouldBe("synthetic-user");
        ex.Message.ShouldContain(audit.Id);
        audit.ResponseBody.ShouldNotBeNull();
        if (mime == "application/json" && body.StartsWith("{", StringComparison.Ordinal))
            audit.ResponseBody!.ShouldContain("link-expired");
        else
            audit.ResponseBody!.ShouldContain("unsafe-snapshot-omitted");
        audit.ResponseBody.ShouldContain("prefixSha256");
        audit.ResponseBody.ShouldNotContain("private-token-marker");
        audit.ResponseBody.ShouldNotContain("synthetic-query-marker");
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", "Unit")]
    public async Task ExecuteVideoDownloaderAsync_ShouldBoundUnknownLengthErrorEvidence()
    {
        var source = new NonSeekableStream(Encoding.UTF8.GetBytes("link-expired token=private-token-marker" + new string('x', 12000)));
        using var content = new StreamContent(source);
        content.Headers.ContentType = new MediaTypeHeaderValue("text/plain");
        using var services = BuildDownloadServices(content, out var storage, HttpStatusCode.Forbidden);
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 8192));
        ex.Message.ShouldNotContain("link-expired");
        ex.Message.ShouldNotContain("private-token-marker");
        var audit = services.GetRequiredService<List<ApiRequestLog>>().Single();
        audit.ResponseBody.ShouldNotBeNull();
        audit.ResponseBody!.ShouldContain("text-unsafe-snapshot-omitted");
        audit.ResponseBody.ShouldContain("\"bodyComplete\":false");
        audit.ResponseBody.ShouldNotContain("private-token-marker");
        source.BytesRead.ShouldBe(4096);
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", "Unit")]
    public async Task ExecuteVideoDownloaderAsync_ShouldRejectStorageWhenAuditCannotBeSaved()
    {
        using var content = new ByteArrayContent(Mp4Bytes());
        content.Headers.ContentType = new MediaTypeHeaderValue("video/mp4");
        using var services = BuildDownloadServices(content, out var storage);
        Mock.Get(services.GetRequiredService<IMongoCollection<ApiRequestLog>>())
            .Setup(x => x.InsertOneAsync(It.IsAny<ApiRequestLog>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new IOException("synthetic-private-database-detail"));
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 8192));
        ex.Message.ShouldContain("视频下载记录未能保存");
        ex.Message.ShouldNotContain("synthetic-private-database-detail");
        storage.VerifyNoOtherCalls();
    }

    [Theory]
    [Trait("Category", "Unit")]
    [InlineData("unknown")]
    [InlineData("unsupported")]
    [InlineData("mismatch")]
    public async Task ExecuteVideoDownloaderAsync_ShouldRetainSpecificFormatRejectionInAdminAudit(string kind)
    {
        var bytes = kind == "unsupported" ? Encoding.ASCII.GetBytes("OggS-not-supported")
            : kind == "mismatch" ? new byte[] { 0x1a, 0x45, 0xdf, 0xa3 }.Concat(Encoding.ASCII.GetBytes("webm-body")).ToArray()
            : Encoding.ASCII.GetBytes("not-a-video-container");
        using var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue(kind == "mismatch" ? "video/mp4" : "application/octet-stream");
        using var services = BuildDownloadServices(content, out var storage);
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 8192));
        var audit = services.GetRequiredService<List<ApiRequestLog>>().Single();
        var reason = kind == "unsupported" ? "不支持 OGV" : kind == "mismatch" ? "video/webm" : "无法识别的二进制格式";
        audit.ResponseBody.ShouldNotBeNull();
        audit.ResponseBody!.ShouldContain(reason);
        audit.ResponseBody.ShouldContain("container_validation");
        ex.Message.ShouldNotContain(reason);
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", "Unit")]
    public async Task ExecuteVideoDownloaderAsync_ShouldRetainWrappedConnectBlockWithoutLeakingItsTarget()
    {
        using var content = new ByteArrayContent([]);
        var blocked = new HttpRequestException("发送请求失败", new InvalidOperationException(
            "内网或保留地址：https://download.example.invalid/video?token=synthetic-private-connect-marker"));
        using var services = BuildDownloadServices(content, out var storage, sendFailure: blocked);
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 8192));
        ex.Message.ShouldContain("内网或保留地址");
        ex.Message.ShouldNotContain("synthetic-private-connect-marker");
        var audit = services.GetRequiredService<List<ApiRequestLog>>().Single();
        audit.ResponseBody.ShouldNotBeNull();
        audit.ResponseBody!.ShouldContain("内网或保留地址");
        audit.ResponseBody.ShouldContain("request");
        audit.ResponseBody.ShouldNotContain("synthetic-private-connect-marker");
        audit.ResponseBody.ShouldNotContain("https://download.example.invalid");
        storage.VerifyNoOtherCalls();
    }

    [Fact]
    [Trait("Category", "Unit")]
    public async Task ExecuteVideoDownloaderAsync_ShouldOmitUnsafeXmlSnapshotButKeepBoundedHash()
    {
        var bytes = Encoding.UTF8.GetBytes("<Error><Token>synthetic-private-xml-marker</Token></Error>");
        using var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/xml");
        using var services = BuildDownloadServices(content, out var storage, HttpStatusCode.Forbidden);
        var ex = await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 8192));
        var audit = services.GetRequiredService<List<ApiRequestLog>>().Single();
        audit.ResponseBody.ShouldNotBeNull();
        audit.ResponseBody!.ShouldNotContain("synthetic-private-xml-marker");
        audit.ResponseBody.ShouldContain("xml-unsafe-snapshot-omitted");
        audit.ResponseBody.ShouldContain(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant());
        audit.StatusCode.ShouldBe(403);
        ex.Message.ShouldNotContain("synthetic-private-xml-marker");
        storage.VerifyNoOtherCalls();
    }

    [Theory]
    [Trait("Category", "Unit")]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ShortVideoCaller_PreservesTrustedAuditCorrelation(bool rejected)
    {
        using var content = new ByteArrayContent(rejected ? Encoding.UTF8.GetBytes("{\"error\":\"expired\"}") : Mp4Bytes());
        content.Headers.ContentType = new MediaTypeHeaderValue(rejected ? "application/json" : "video/mp4");
        using var services = BuildDownloadServices(content, out var storage, rejected ? HttpStatusCode.Forbidden : HttpStatusCode.OK);
        if (!rejected)
            storage.Setup(x => x.SaveAsync(It.IsAny<byte[]>(), "video/mp4", It.IsAny<CancellationToken>(), "workflow-agent", "doc", null, null))
                .ReturnsAsync(new StoredAsset("synthetic-sha", "https://synthetic.invalid/video.mp4", 32, "video/mp4"));
        var context = (PrdAgent.Infrastructure.Database.MongoDbContext)System.Runtime.CompilerServices.RuntimeHelpers
            .GetUninitializedObject(typeof(PrdAgent.Infrastructure.Database.MongoDbContext));
        var documents = new Mock<IDocumentService>(MockBehavior.Strict);
        var processor = new ShortVideoMaterialProcessor(context, documents.Object,
            new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build(), services,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<ShortVideoMaterialProcessor>.Instance);
        var method = typeof(ShortVideoMaterialProcessor).GetMethod("DownloadVideoMaterialAsync",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        var parsed = Activator.CreateInstance(method.GetParameters()[0].ParameterType,
            [null, null, "direct-video", "synthetic", null, "https://download.example.invalid/video.mp4", null]);
        var run = new ShortVideoMaterialRun { Id = "synthetic-short-video-run", UserId = "synthetic-owner" };
        var task = (Task)method.Invoke(processor, [parsed, run])!;
        if (rejected) await Should.ThrowAsync<InvalidOperationException>(() => task);
        else await task;
        var audit = services.GetRequiredService<List<ApiRequestLog>>().Single();
        audit.RequestId.ShouldBe(run.Id); audit.SessionId.ShouldBe(run.Id); audit.UserId.ShouldBe(run.UserId);
        if (rejected) storage.VerifyNoOtherCalls();
        documents.VerifyNoOtherCalls();
    }

    [Theory]
    [Trait("Category", "Unit")]
    [InlineData("text/html", "<input name='access_token' value='synthetic-markup-secret'>")]
    [InlineData("text/plain", "<Token>synthetic-markup-secret</Token>")]
    [InlineData("application/json", "\"<Token>synthetic-markup-secret</Token>\"")]
    public async Task UnsafeUnstructuredSnapshots_AreExplicitlyOmitted(string mime, string body)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        using var content = new ByteArrayContent(bytes);
        content.Headers.ContentType = new MediaTypeHeaderValue(mime);
        using var services = BuildDownloadServices(content, out var storage, HttpStatusCode.Forbidden);
        await Should.ThrowAsync<InvalidOperationException>(() => Download(services, 8192));
        var audit = services.GetRequiredService<List<ApiRequestLog>>().Single();
        var evidence = audit.ResponseBody ?? throw new InvalidOperationException("Missing audit evidence");
        evidence.ShouldNotContain("synthetic-markup-secret");
        evidence.ShouldContain("unsafe-snapshot-omitted");
        evidence.ShouldContain(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes)).ToLowerInvariant());
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
                ["videoUrl"] = "https://download.example.invalid/video?token=synthetic-query-marker",
                ["maxFileSizeBytes"] = maxBytes.ToString(),
                ["timeoutSeconds"] = timeoutSeconds.ToString(),
            },
        }, new Dictionary<string, string>(), new List<ExecutionArtifact>(),
            new WorkflowDesignInvocation("synthetic-user", "synthetic-operation", "local-download-integration", "synthetic-execution", "synthetic-user"));

    private static ServiceProvider BuildDownloadServices(HttpContent content, out Mock<IAssetStorage> storage, HttpStatusCode status = HttpStatusCode.OK, Exception? sendFailure = null)
    {
        var services = new ServiceCollection();
        RegisterAudit(services);
        storage = new Mock<IAssetStorage>(MockBehavior.Strict);
        services.AddSingleton(storage.Object);
        var validator = new Mock<ISafeOutboundUrlValidator>(MockBehavior.Strict);
        validator.Setup(x => x.EnsureSafeHttpUrlAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync((string url, string purpose, CancellationToken ct) => new Uri(url));
        services.AddSingleton(validator.Object);
        services.AddHttpClient("SafeOutbound").ConfigurePrimaryHttpMessageHandler(() => new SyntheticHandler(content, status, sendFailure));
        return services.BuildServiceProvider();
    }

    private static void RegisterAudit(ServiceCollection services)
    {
        var auditRecords = new List<ApiRequestLog>();
        var audit = new Mock<IMongoCollection<ApiRequestLog>>(MockBehavior.Strict);
        audit.Setup(x => x.InsertOneAsync(It.IsAny<ApiRequestLog>(), It.IsAny<InsertOneOptions>(), It.IsAny<CancellationToken>()))
            .Callback<ApiRequestLog, InsertOneOptions, CancellationToken>((record, _, _) => auditRecords.Add(record))
            .Returns(Task.CompletedTask);
        services.AddSingleton(audit.Object);
        services.AddSingleton(auditRecords);
    }

    private sealed class SyntheticHandler(HttpContent content, HttpStatusCode status, Exception? sendFailure) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => sendFailure == null ? Task.FromResult(new HttpResponseMessage(status) { Content = content })
                : Task.FromException<HttpResponseMessage>(sendFailure);
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
        RegisterAudit(services);
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
