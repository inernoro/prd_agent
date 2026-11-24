using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using PrdAgent.Api.Controllers.Api;
using PrdAgent.Core.Models;
using Xunit;

namespace PrdAgent.Api.Tests.Controllers;

/// <summary>
/// 网页入口读取上限：约 12MB 的单文件网页必须可读，超过 16MB 必须拒绝；
/// 远端未声明或少报长度时，也要在边读边累计时截断，不能先整段缓冲。
/// </summary>
public class WebPagesHtmlReadLimitTests
{
    private const int SixteenMegabytes = 16 * 1024 * 1024;

    [Fact]
    public async Task TwelveMegabyteEntry_IsReadable()
    {
        var body = new byte[12 * 1024 * 1024];
        var result = await ReadAsync(new MemoryStream(body), body.Length);

        Assert.IsType<OkObjectResult>(result);
    }

    [Fact]
    public async Task EntryDeclaredOverSixteenMegabytes_IsRejectedBeforeReadingBody()
    {
        var stream = new ThrowingStream();
        var result = await ReadAsync(stream, SixteenMegabytes + 1L);

        var rejected = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("16MB", JsonSerializer.Serialize(rejected.Value));
        Assert.False(stream.WasRead);
    }

    [Fact]
    public async Task EntryWithoutContentLength_IsStillBoundedWhileStreaming()
    {
        var result = await ReadAsync(new MemoryStream(new byte[SixteenMegabytes + 1]), null);

        var rejected = Assert.IsType<BadRequestObjectResult>(result);
        Assert.Contains("16MB", JsonSerializer.Serialize(rejected.Value));
    }

    [Fact]
    public async Task EntryUnderreportingLength_IsStillBoundedWhileStreaming()
    {
        var result = await ReadAsync(new MemoryStream(new byte[SixteenMegabytes + 1]), 1024);

        Assert.IsType<BadRequestObjectResult>(result);
    }

    private static async Task<IActionResult> ReadAsync(Stream stream, long? declaredLength)
    {
        // 只测读取上限这一段纯逻辑，不依赖控制器的依赖注入构造参数。
        var controller = (WebPagesController)RuntimeHelpers.GetUninitializedObject(typeof(WebPagesController));
        var method = typeof(WebPagesController).GetMethod("ReadSiteHtmlStreamAsync",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(method);
        var site = new HostedSite
        {
            Id = "site-1",
            Title = "入口读取上限",
            SiteUrl = "https://example.test/index.html",
        };
        var task = Assert.IsAssignableFrom<Task<IActionResult>>(
            method!.Invoke(controller, [site, stream, declaredLength, CancellationToken.None]));
        return await task;
    }

    private sealed class ThrowingStream : Stream
    {
        public bool WasRead { get; private set; }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) { WasRead = true; throw new InvalidOperationException("不应读取正文"); }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) { WasRead = true; throw new InvalidOperationException("不应读取正文"); }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
