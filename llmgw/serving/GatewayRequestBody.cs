using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;
using Microsoft.AspNetCore.Http;

namespace PrdAgent.LlmGatewayHost;

/// <summary>Physical ingress budget, independent of Content-Length and transport framing.</summary>
public static class GatewayRequestBody
{
    // Preserve Kestrel's existing default ceiling for all hosting/test transports.
    public const long MaxBytes = 30_000_000;
    public const long UserKeyMaxBytes = 1024 * 1024;
    public const int MaxDepth = 64; // System.Text.Json's existing default.

    // Image-edit batches: 16 image/mask parts; the aggregate transport ceiling remains 30 MB.
    public const int MaxMultipartFiles = 16;
    public const long MaxMultipartFileBytes = MaxBytes;

    public static async Task<BufferedMultipartForm> ReadMultipartAsync(HttpRequest request, CancellationToken ct)
    {
        var boundary = HeaderUtilities.RemoveQuotes(MediaTypeHeaderValue.Parse(request.ContentType!).Boundary).Value;
        if (string.IsNullOrEmpty(boundary) || boundary.Length > 128) throw new InvalidDataException("invalid boundary");
        var reader = new MultipartReader(boundary, request.Body);
        var fields = new Dictionary<string, StringValues>(StringComparer.OrdinalIgnoreCase);
        var files = new FormFileCollection();
        var buffers = new List<Stream>();
        var sections = 0;
        try
        {
            MultipartSection? section;
            while ((section = await reader.ReadNextSectionAsync(ct)) is not null)
            {
                if (++sections > 1024) throw new BadHttpRequestException("too many multipart sections", 413);
                if (!ContentDispositionHeaderValue.TryParse(section.ContentDisposition, out var disposition)
                    || !disposition.DispositionType.Equals("form-data", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("invalid disposition");
                var name = HeaderUtilities.RemoveQuotes(disposition.Name).Value ?? string.Empty;
                if (name.Length > 2048) throw new BadHttpRequestException("multipart name too large", 413);
                if (disposition.FileName.HasValue || disposition.FileNameStar.HasValue)
                {
                    // Reject the next file at its headers, before draining/materializing its content.
                    if (files.Count >= MaxMultipartFiles) throw new BadHttpRequestException("too many multipart files", 413);
                    var bounded = new GatewayBudgetReadStream(section.Body, MaxMultipartFileBytes);
                    var buffered = new FileBufferingReadStream(bounded, 64 * 1024, null, Path.GetTempPath);
                    buffers.Add(buffered);
                    await buffered.CopyToAsync(Stream.Null, ct);
                    buffered.Position = 0;
                    var fileName = HeaderUtilities.RemoveQuotes(disposition.FileNameStar.HasValue
                        ? disposition.FileNameStar : disposition.FileName).Value ?? string.Empty;
                    files.Add(new FormFile(buffered, 0, buffered.Length, name, fileName)
                    {
                        Headers = new HeaderDictionary(section.Headers!),
                        ContentType = section.ContentType ?? "application/octet-stream",
                    });
                }
                else
                {
                    using var bounded = new GatewayBudgetReadStream(section.Body, 4 * 1024 * 1024);
                    var encoding = MediaTypeHeaderValue.TryParse(section.ContentType, out var mediaType)
                        ? mediaType.Encoding ?? System.Text.Encoding.UTF8 : System.Text.Encoding.UTF8;
                    using var text = new StreamReader(bounded, encoding);
                    var value = await text.ReadToEndAsync(ct);
                    fields[name] = StringValues.Concat(fields.GetValueOrDefault(name), value);
                }
            }
            return new BufferedMultipartForm(new FormCollection(fields, files), buffers);
        }
        catch
        {
            foreach (var buffer in buffers) buffer.Dispose();
            throw;
        }
    }

    public sealed class BufferedMultipartForm(IFormCollection form, List<Stream> buffers) : IDisposable
    {
        public IFormCollection Form { get; } = form;
        public void Dispose() { foreach (var buffer in buffers) buffer.Dispose(); }
    }

    public static async Task ValidateJsonAsync(HttpRequest request, CancellationToken ct)
    {
        request.EnableBuffering();
        var buffer = new byte[16 * 1024];
        var retained = 0;
        var first = true;
        var state = new JsonReaderState(new JsonReaderOptions { MaxDepth = MaxDepth });
        try
        {
            while (true)
            {
                var read = await request.Body.ReadAsync(buffer.AsMemory(retained), ct);
                var length = retained + read;
                if (first)
                {
                    if (length < 3 && read != 0) { retained = length; continue; }
                    first = false;
                    // Preserve JsonDocument/HTTP serializer acceptance of a UTF-8 BOM, even across reads.
                    if (length >= 3 && buffer[0] == 0xef && buffer[1] == 0xbb && buffer[2] == 0xbf)
                    {
                        length -= 3;
                        buffer.AsSpan(3, length).CopyTo(buffer);
                    }
                }
                var consumed = Consume(buffer, length, read == 0, ref state);
                retained = length - consumed;
                buffer.AsSpan(consumed, retained).CopyTo(buffer);
                if (read == 0) break;
                if (retained == buffer.Length)
                    Array.Resize(ref buffer, checked(buffer.Length * 2));
            }
        }
        finally { request.Body.Position = 0; }
    }

    private static int Consume(byte[] buffer, int length, bool final, ref JsonReaderState state)
    {
        var reader = new Utf8JsonReader(buffer.AsSpan(0, length), final, state);
        while (reader.Read()) { }
        state = reader.CurrentState;
        return checked((int)reader.BytesConsumed);
    }
}

/// <summary>Non-seekable wrapper so replay buffers cannot bypass physical byte accounting. Leaves transport ownership to the host.</summary>
public sealed class GatewayBudgetReadStream(Stream inner, long limit) : Stream
{
    public long BytesRead { get; private set; }
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    private int Allowed(int requested) => (int)Math.Min(requested, Math.Max(1, limit - BytesRead + 1));
    private int Count(int read)
    {
        BytesRead += read;
        if (BytesRead > limit) throw new BadHttpRequestException("gateway request body exceeds byte budget", StatusCodes.Status413PayloadTooLarge);
        return read;
    }
    public override int Read(byte[] buffer, int offset, int count) => Count(inner.Read(buffer, offset, Allowed(count)));
    public override int Read(Span<byte> buffer) => Count(inner.Read(buffer[..Allowed(buffer.Length)]));
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        => Count(await inner.ReadAsync(buffer[..Allowed(buffer.Length)], cancellationToken));
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        => ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
    public override void Flush() => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
