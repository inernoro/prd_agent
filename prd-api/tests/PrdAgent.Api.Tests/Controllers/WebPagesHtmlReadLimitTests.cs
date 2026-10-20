using System.Net;
using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Moq;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

public class WebPagesHtmlReadLimitTests
{
    [Fact]
    public async Task TwelveMegabyteEntry_IsReadable()
    {
        var result = await FetchAsync(new ByteArrayContent(new byte[12 * 1024 * 1024]));

        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task EntryOverSixteenMegabytes_IsRejectedBeforeReadingBody()
    {
        var result = await FetchAsync(new ByteArrayContent(new byte[16 * 1024 * 1024 + 1]));

        var rejected = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("16MB", JsonSerializer.Serialize(rejected.Value));
    }

    [Fact]
    public async Task EntryWithoutContentLength_IsStillBoundedWhileStreaming()
    {
        using var stream = new NonSeekableReadStream(new byte[16 * 1024 * 1024 + 1]);
        var result = await FetchAsync(new StreamContent(stream));

        Assert.IsType<BadRequestObjectResult>(result);
    }

    private static async Task<IActionResult> FetchAsync(HttpContent content)
    {
        using var handler = new StaticResponseHandler(content);
        using var client = new HttpClient(handler);
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(x => x.CreateClient(It.IsAny<string>())).Returns(client);
        var controller = new WebPagesController(null!, null!, null!, null!, null!, factory.Object);
        var method = typeof(WebPagesController).GetMethod("FetchSiteHtmlResultAsync",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(method);
        var site = new HostedSite
        {
            Id = "site-1",
            SiteUrl = "https://example.test/index.html",
            ContentVersion = DateTime.UtcNow,
        };
        var task = Assert.IsType<Task<IActionResult>>(method!.Invoke(controller, [site]));
        return await task;
    }

    private sealed class StaticResponseHandler(HttpContent content) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
    }

    private sealed class NonSeekableReadStream(byte[] bytes) : Stream
    {
        private readonly MemoryStream _inner = new(bytes);

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => _inner.Read(buffer, offset, count);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) =>
            _inner.ReadAsync(buffer, cancellationToken);
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
