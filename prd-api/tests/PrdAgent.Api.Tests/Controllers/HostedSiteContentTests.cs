using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using PrdAgent.Infrastructure.Database;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;
using PrdAgent.Infrastructure.Services.AssetStorage;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public sealed class HostedSiteContentTests
{
    private static readonly JsonSerializerOptions WebJson = new(JsonSerializerDefaults.Web);
    private static WebPagesController Controller(IHostedSiteService sites, IAssetStorage storage, IHttpClientFactory factory)
    {
        var controller = new WebPagesController(sites, null!, null!, null!, null!, factory, assetStorage: storage);
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() };
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(new[] { new Claim(ClaimTypes.NameIdentifier, "viewer") }, "test"));
        controller.Request.Host = new HostString("untrusted-host.example");
        return controller;
    }
    private static HostedSite Site(string url, string key) => new() { Id = "site", Title = "模版文档", SiteUrl = url, EntryFile = "index.html", Files = new() { new() { Path = "index.html", CosKey = key, Size = 1 } } };
    private static Mock<IHostedSiteService> Sites(HostedSite? site)
    {
        var mock = new Mock<IHostedSiteService>(MockBehavior.Strict);
        mock.Setup(s => s.GetByIdAsync("site", "viewer", It.IsAny<CancellationToken>())).ReturnsAsync(site);
        return mock;
    }

    [Fact]
    public async Task LocalEntryReadsActualBodyWithoutResolvingARequestHost()
    {
        var dir = Path.Combine(Path.GetTempPath(), "hosted-content-" + Guid.NewGuid().ToString("N"));
        try {
            var storage = new LocalAssetStorage(dir);
            const string key = "web-hosting/sites/entry/index.html";
            await storage.UploadToKeyAsync(key, Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes("<h1>已保存正文</h1>")).ToArray(), "text/html", CancellationToken.None);
            var factory = new Mock<IHttpClientFactory>(); factory.Setup(f => f.CreateClient(It.IsAny<string>())).Returns(new HttpClient());
            // MongoDbContext only creates a collection handle here; this read path must not contact Mongo.
            var registered = new RegistryAssetStorage(storage, new MongoDbContext("mongodb://127.0.0.1:27018", "unused_content_test"), "local", NullLogger<RegistryAssetStorage>.Instance);
            var result = Assert.IsType<OkObjectResult>(await Controller(Sites(Site(storage.BuildUrlForKey(key), key)).Object, registered, factory.Object).GetSiteContent("site"));
            var data = JsonSerializer.SerializeToElement(result.Value, WebJson).GetProperty("data");
            Assert.Equal("<h1>已保存正文</h1>", data.GetProperty("html").GetString());
            factory.Verify(f => f.CreateClient(It.IsAny<string>()), Times.Never);
        } finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }

    [Theory]
    [InlineData(2 * 1024 * 1024, true)]
    [InlineData(2 * 1024 * 1024 + 1, false)]
    public async Task LocalEntryUsesActualStreamSizeInsteadOfTrustingSmallMetadata(int size, bool allowed)
    {
        var dir = Path.Combine(Path.GetTempPath(), "hosted-content-" + Guid.NewGuid().ToString("N"));
        try {
            var storage = new LocalAssetStorage(dir); const string key = "web-hosting/sites/entry/index.html";
            await storage.UploadToKeyAsync(key, new byte[size], "text/html", CancellationToken.None);
            var factory = new Mock<IHttpClientFactory>(); factory.Setup(f => f.CreateClient(It.IsAny<string>())).Returns(new HttpClient());
            var result = await Controller(Sites(Site(storage.BuildUrlForKey(key), key)).Object, storage, factory.Object).GetSiteContent("site");
            if (allowed) Assert.IsType<OkObjectResult>(result);
            else Assert.Contains("2MB", JsonSerializer.Serialize(Assert.IsType<BadRequestObjectResult>(result).Value, WebJson));
        } finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }

    [Fact]
    public async Task ALocalFileDoesNotBypassTheExistingSiteReadPermission()
    {
        var controller = Controller(Sites(null).Object, new Mock<IAssetStorage>(MockBehavior.Strict).Object, new Mock<IHttpClientFactory>(MockBehavior.Strict).Object);
        Assert.IsType<NotFoundObjectResult>(await controller.GetSiteContent("site"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(1L)]
    public async Task RemoteUnknownOrIncorrectLengthStillStopsAtTheSameTwoMegabyteLimit(long? length)
    {
        var stream = new UnseekableContent(3 * 1024 * 1024);
        using var client = new HttpClient(new ContentHandler(stream, length));
        var factory = new Mock<IHttpClientFactory>(); factory.Setup(f => f.CreateClient(It.IsAny<string>())).Returns(client);
        var result = Assert.IsType<BadRequestObjectResult>(await Controller(Sites(Site("https://assets.example/index.html", "index.html")).Object, new Mock<IAssetStorage>(MockBehavior.Strict).Object, factory.Object).GetSiteContent("site"));
        Assert.Contains("2MB", JsonSerializer.Serialize(result.Value, WebJson));
        Assert.InRange(stream.BytesRead, 2 * 1024 * 1024, 2 * 1024 * 1024 + 8192);
    }
    private sealed class ContentHandler(Stream stream, long? length) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var content = new StreamContent(stream);
            content.Headers.ContentLength = length;
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
        }
    }
    private sealed class UnseekableContent(int size) : Stream
    {
        public int BytesRead { get; private set; }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => BytesRead; set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) { var read = Math.Min(count, size - BytesRead); Array.Fill(buffer, (byte)'x', offset, read); BytesRead += read; return read; }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default) { ct.ThrowIfCancellationRequested(); var read = Math.Min(buffer.Length, size - BytesRead); buffer.Span[..read].Fill((byte)'x'); BytesRead += read; return ValueTask.FromResult(read); }
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
