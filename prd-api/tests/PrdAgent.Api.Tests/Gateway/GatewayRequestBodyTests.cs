using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using PrdAgent.LlmGatewayHost;
using Xunit;
using Xunit.Abstractions;

namespace PrdAgent.Api.Tests.Gateway;

public class GatewayRequestBodyTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData(1_048_576)]
    [InlineData(30_000_000)]
    public async Task UnknownLength_StopsAtBudgetPlusOne(long budget)
    {
        using var source = new GeneratedBodyStream(100_000_000, "{\"data\":\"");
        using var bounded = new GatewayBudgetReadStream(source, budget);
        var http = new DefaultHttpContext();
        http.Request.Body = bounded;
        var before = GC.GetTotalAllocatedBytes();
        var ex = await Assert.ThrowsAsync<BadHttpRequestException>(() => GatewayRequestBody.ValidateJsonAsync(http.Request, default));
        Assert.Equal(413, ex.StatusCode);
        Assert.Equal(budget + 1, source.BytesRead);
        output.WriteLine($"budget={budget}; physicalRead={source.BytesRead}; allocatedDelta={GC.GetTotalAllocatedBytes() - before}");
        await http.Request.Body.DisposeAsync();
        Assert.True(source.CanRead); // host owns the transport, replay buffer owns its temp file
    }

    [Fact]
    public async Task DeepJson_StopsBeforeLargeTail()
    {
        using var source = new GeneratedBodyStream(100_000_000, new string('[', 65));
        var http = new DefaultHttpContext();
        http.Request.Body = new GatewayBudgetReadStream(source, GatewayRequestBody.MaxBytes);
        var before = GC.GetTotalAllocatedBytes();
        await Assert.ThrowsAnyAsync<JsonException>(() => GatewayRequestBody.ValidateJsonAsync(http.Request, default));
        Assert.InRange(source.BytesRead, 65, 16 * 1024);
        output.WriteLine($"deepJson physicalRead={source.BytesRead}; allocatedDelta={GC.GetTotalAllocatedBytes() - before}");
        await http.Request.Body.DisposeAsync();
    }

    [Theory]
    [InlineData("{\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}],\"stream\":true}")]
    [InlineData("{\"contents\":[{\"parts\":[{\"text\":\"hi\"}]}]}")]
    [InlineData("{\"AppCallerCode\":\"test::chat\",\"RequestBody\":{\"messages\":[]}}")]
    public async Task ValidJson_ReplaysIdenticalBytes(string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        var http = new DefaultHttpContext();
        http.Request.Body = new GatewayBudgetReadStream(new MemoryStream(bytes), bytes.Length);
        await GatewayRequestBody.ValidateJsonAsync(http.Request, default);
        using var replay = new MemoryStream();
        await http.Request.Body.CopyToAsync(replay);
        Assert.Equal(bytes, replay.ToArray());
        await http.Request.Body.DisposeAsync();
    }

    [Theory]
    [InlineData(1)]
    [InlineData(3)]
    [InlineData(16)]
    public async Task MultipartRepresentativeBatches_ReplayAndReleaseStorage(int count)
    {
        using var content = new System.Net.Http.MultipartFormDataContent("test");
        for (var i = 0; i < count; i++) content.Add(new System.Net.Http.ByteArrayContent(new byte[1024 * 1024]), "image[]", $"image{i}.png");
        var bytes = await content.ReadAsByteArrayAsync();
        output.WriteLine($"multipart files={count}; bodyBytes={bytes.Length}; perFileBytes=1048576");
        var http = new DefaultHttpContext();
        http.Request.ContentType = content.Headers.ContentType!.ToString();
        http.Request.Body = new GatewayBudgetReadStream(new MemoryStream(bytes), GatewayRequestBody.MaxBytes);
        var parsed = await GatewayRequestBody.ReadMultipartAsync(http.Request, default);
        Assert.Equal(count, parsed.Form.Files.Count);
        using var file = parsed.Form.Files[0].OpenReadStream();
        Assert.Equal(1024 * 1024, file.Length);
        Assert.Equal(0, file.ReadByte());
        parsed.Dispose();
        Assert.Throws<ObjectDisposedException>(() => file.ReadByte());
    }

    [Fact]
    public async Task MultipartFileCount_RejectsAtNextHeaders()
    {
        var section = "--test\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"a.png\"\r\n\r\n";
        var prefix = string.Concat(Enumerable.Repeat(section + "x\r\n", 16)) + section;
        using var source = new GeneratedBodyStream(100_000_000, prefix);
        var http = new DefaultHttpContext();
        http.Request.ContentType = "multipart/form-data; boundary=test";
        http.Request.Body = new GatewayBudgetReadStream(source, GatewayRequestBody.MaxBytes);
        var ex = await Assert.ThrowsAsync<BadHttpRequestException>(() => GatewayRequestBody.ReadMultipartAsync(http.Request, default));
        Assert.Equal(413, ex.StatusCode);
        Assert.InRange(source.BytesRead, prefix.Length, 8192);
        output.WriteLine($"fileCount=17; physicalRead={source.BytesRead}");
    }

    [Fact]
    public async Task CancelledRead_PropagatesCancellation()
    {
        using var bounded = new GatewayBudgetReadStream(new MemoryStream(new byte[1024]), 100);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await bounded.ReadAsync(new byte[100], cancellation.Token));
        Assert.Equal(0, bounded.BytesRead);
    }
}

internal sealed class GeneratedBodyStream(long length, string prefix) : Stream
{
    private readonly byte[] _prefix = Encoding.UTF8.GetBytes(prefix);
    public long BytesRead { get; private set; }
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
    public override int Read(Span<byte> buffer)
    {
        var n = (int)Math.Min(buffer.Length, length - BytesRead);
        buffer[..n].Fill((byte)'a');
        for (var i = 0; i < n && BytesRead + i < _prefix.Length; i++) buffer[i] = _prefix[BytesRead + i];
        BytesRead += n;
        return n;
    }
    public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return ValueTask.FromResult(Read(buffer.Span));
    }
    public override void Flush() => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
