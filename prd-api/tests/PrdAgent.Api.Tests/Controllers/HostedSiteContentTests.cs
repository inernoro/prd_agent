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
    [InlineData(16 * 1024 * 1024, true)]
    [InlineData(16 * 1024 * 1024 + 1, false)]
    public async Task LocalEntryUsesActualStreamSizeInsteadOfTrustingSmallMetadata(int size, bool allowed)
    {
        var dir = Path.Combine(Path.GetTempPath(), "hosted-content-" + Guid.NewGuid().ToString("N"));
        try {
            var storage = new LocalAssetStorage(dir); const string key = "web-hosting/sites/entry/index.html";
            await storage.UploadToKeyAsync(key, new byte[size], "text/html", CancellationToken.None);
            var factory = new Mock<IHttpClientFactory>(); factory.Setup(f => f.CreateClient(It.IsAny<string>())).Returns(new HttpClient());
            var result = await Controller(Sites(Site(storage.BuildUrlForKey(key), key)).Object, storage, factory.Object).GetSiteContent("site");
            if (allowed) Assert.IsType<OkObjectResult>(result);
            else Assert.Contains("16MB", JsonSerializer.Serialize(Assert.IsType<BadRequestObjectResult>(result).Value, WebJson));
        } finally { if (Directory.Exists(dir)) Directory.Delete(dir, true); }
    }

    [Fact]
    public async Task ALocalFileDoesNotBypassTheExistingSiteReadPermission()
    {
        var controller = Controller(Sites(null).Object, new Mock<IAssetStorage>(MockBehavior.Strict).Object, new Mock<IHttpClientFactory>(MockBehavior.Strict).Object);
        Assert.IsType<NotFoundObjectResult>(await controller.GetSiteContent("site"));
        Assert.IsType<NotFoundObjectResult>(await controller.GetSiteContent("site", prepareGeneratedReview: true));
    }

    [Fact]
    public async Task VerifiedGeneratedPackagePreparesAnAnnotationCopyFromTheHostedEntry()
    {
        const string directory = "data/web-hosting/sites/site/.generated/0123456789abcdef0123456789abcdef/";
        const string address = "https://assets.example/" + directory;
        const string key = directory + "index.html";
        var site = Site(address + "index.html?v=123", key);
        site.SourceType = "design-agent";
        site.Files.Add(new() { Path = "assets/cover.png", CosKey = directory + "assets/cover.png" });
        var source = HostedSiteRevisionRules.HardenVerifiedPackageHtml(
            "<html><head></head><body><p>可以选择的正文</p><img src=\"assets/cover.png\"></body></html>",
            ["index.html", "assets/cover.png"]);
        var bytes = Encoding.UTF8.GetBytes(source);
        var http = new Mock<IHttpClientFactory>(MockBehavior.Strict);
        http.Setup(f => f.CreateClient(It.IsAny<string>()))
            .Returns(() => new HttpClient(new ContentHandler(new MemoryStream(bytes), bytes.Length)));
        var controller = Controller(Sites(site).Object, new Mock<IAssetStorage>(MockBehavior.Strict).Object, http.Object);

        var result = Assert.IsType<OkObjectResult>(await controller.GetSiteContent("site", prepareGeneratedReview: true));
        var data = JsonSerializer.SerializeToElement(result.Value, WebJson).GetProperty("data");
        Assert.True(data.GetProperty("preparedGeneratedReview").GetBoolean());
        var review = data.GetProperty("html").GetString()!;
        Assert.Contains($"<base href=\"{address}\">", review);
        Assert.Contains($"img-src {address} data: blob:", review);
        Assert.Contains("connect-src 'none'; form-action 'none'", review);
        Assert.Contains("script-src 'unsafe-inline';", review);
        Assert.Contains("<script data-map-annotations=\"v1\">", review);
        Assert.Contains("可以选择的正文", review);
        var raw = Assert.IsType<OkObjectResult>(await controller.GetSiteContent("site"));
        var rawData = JsonSerializer.SerializeToElement(raw.Value, WebJson).GetProperty("data");
        Assert.False(rawData.GetProperty("preparedGeneratedReview").GetBoolean());
        Assert.Equal(source, rawData.GetProperty("html").GetString());
        http.Verify(f => f.CreateClient(It.IsAny<string>()), Times.Exactly(2));
    }

    [Fact]
    public void PackagesThatDependOnExternalScriptsAndStrictStaticPagesKeepTheirCurrentPolicy()
    {
        const string directory = "web-hosting/sites/site/.generated/0123456789abcdef0123456789abcdef/";
        var site = Site("https://assets.example/" + directory + "index.html", directory + "index.html");
        site.SourceType = "design-agent";
        site.Files.Add(new() { Path = "app.js", CosKey = directory + "app.js" });
        Assert.False(site.CanPrepareGeneratedReview);
        var strict = HostedSiteRevisionRules.HardenGeneratedHtml("<html><head></head><body><p>静态正文</p></body></html>");
        Assert.Null(HostedSiteRevisionRules.PrepareVerifiedPackageReviewHtml(strict, site.SiteUrl));
    }

    [Theory]
    [InlineData(null)]
    [InlineData(1L)]
    public async Task RemoteUnknownOrIncorrectLengthStillStopsAtTheSameSixteenMegabyteLimit(long? length)
    {
        var stream = new UnseekableContent(17 * 1024 * 1024);
        using var client = new HttpClient(new ContentHandler(stream, length));
        var factory = new Mock<IHttpClientFactory>(); factory.Setup(f => f.CreateClient(It.IsAny<string>())).Returns(client);
        var result = Assert.IsType<BadRequestObjectResult>(await Controller(Sites(Site("https://assets.example/index.html", "index.html")).Object, new Mock<IAssetStorage>(MockBehavior.Strict).Object, factory.Object).GetSiteContent("site"));
        Assert.Contains("16MB", JsonSerializer.Serialize(result.Value, WebJson));
        Assert.InRange(stream.BytesRead, 16 * 1024 * 1024, 16 * 1024 * 1024 + 8192);
    }
    private async Task<IActionResult> ReadRemote(int size, long? length)
    {
        using var client = new HttpClient(new ContentHandler(new UnseekableContent(size), length));
        var factory = new Mock<IHttpClientFactory>(); factory.Setup(f => f.CreateClient(It.IsAny<string>())).Returns(client);
        return await Controller(Sites(Site("https://assets.example/index.html", "index.html")).Object, new Mock<IAssetStorage>(MockBehavior.Strict).Object, factory.Object).GetSiteContent("site");
    }

    [Theory]
    [InlineData(3L * 1024 * 1024)]
    [InlineData(null)]
    public async Task LargeEntryWaitsForAReadSlotAndTellsTheUserWhenAllAreBusy(long? declared)
    {
        var originalWait = WebPagesController.LargeSiteHtmlWait;
        var taken = 0;
        try {
            WebPagesController.LargeSiteHtmlWait = TimeSpan.FromMilliseconds(50);
            while (WebPagesController.LargeSiteHtmlReads.Wait(0)) taken++;
            var busy = await ReadRemote(3 * 1024 * 1024, declared);
            var rejected = Assert.IsType<ObjectResult>(busy);
            Assert.Equal(StatusCodes.Status429TooManyRequests, rejected.StatusCode);
            var error = Assert.IsType<ApiResponse<object>>(rejected.Value).Error!;
            Assert.Equal(ErrorCodes.RATE_LIMITED, error.Code);
            Assert.Contains("稍后重试", error.Message);
            // 不超过 2MB 的入口与放宽上限前一样，不占大文件名额，名额满了也照常打开。
            Assert.IsType<OkObjectResult>(await ReadRemote(1024 * 1024, 1024 * 1024));
        } finally {
            WebPagesController.LargeSiteHtmlReads.Release(taken);
            WebPagesController.LargeSiteHtmlWait = originalWait;
        }
    }

    [Theory]
    [InlineData(12 * 1024 * 1024, true)]
    [InlineData(17 * 1024 * 1024, false)]
    public async Task LargeEntryReturnsItsReadSlotWhetherItSucceedsOrIsRejected(int size, bool allowed)
    {
        var before = WebPagesController.LargeSiteHtmlReads.CurrentCount;
        var result = await ReadRemote(size, null);
        if (allowed) Assert.IsType<OkObjectResult>(result); else Assert.IsType<BadRequestObjectResult>(result);
        Assert.Equal(before, WebPagesController.LargeSiteHtmlReads.CurrentCount);
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
