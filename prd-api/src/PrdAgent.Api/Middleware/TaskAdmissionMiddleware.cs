using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Security;
using PrdAgent.Core.Models;
using System.Text;
using System.Text.Json;

namespace PrdAgent.Api.Middleware;

public sealed class TaskAdmissionMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext http, TaskAdmissionService admission)
    {
        var original = http.Response.Body;
        using var capture = new BoundedResponseCapture(original, () => http.Response.ContentType);
        http.Response.Body = capture;
        try
        {
            var action = http.GetEndpoint()?.Metadata
                .GetMetadata<Microsoft.AspNetCore.Mvc.Controllers.ControllerActionDescriptor>();
            if (action is not null && TaskAdmissionPolicies.Find(action.ControllerTypeInfo.FullName!, action.ActionName) is not null
                && http.Request.ContentType?.StartsWith("application/json", StringComparison.OrdinalIgnoreCase) == true)
                http.Request.EnableBuffering();
            var identity = await admission.AdmitRequestAsync(http, CancellationToken.None);
            using var execution = TaskExecutionContext.Enter(identity);
            await next(http);
            var state = TaskAdmissionRequestState.Get(http);
            if (state.Identity is { } accepted)
            {
                using var acceptedScope = TaskExecutionContext.Enter(accepted);
                await admission.SaveAcceptedResponseAsync(accepted.PermitId, http.Response.StatusCode,
                    http.Response.ContentType ?? "", capture.CapturedBody, CancellationToken.None);
            }
        }
        catch (TaskIntentReplayException replay) when (!http.Response.HasStarted)
        {
            var permit = replay.Permit;
            http.Response.Headers["Idempotency-Replayed"] = "true";
            var replayBody = permit.AcceptedResponseBody;
            if (replayBody is not null && permit.SourceTask == "PrdAgent.Api.Controllers.McpGatewayController.Handle")
                replayBody = await RebindMcpReplayIdAsync(http.Request, replayBody);
            if (permit.AcceptedResponseStatus is { } status && replayBody is { } body)
            {
                http.Response.StatusCode = status;
                http.Response.ContentType = permit.AcceptedResponseContentType ?? "application/json";
                await original.WriteAsync(Encoding.UTF8.GetBytes(body), CancellationToken.None);
            }
            else
            {
                http.Response.StatusCode = StatusCodes.Status409Conflict;
                await http.Response.WriteAsJsonAsync(ApiResponse<object>.Fail("TASK_ALREADY_ACCEPTED",
                    "这次操作已经接收，未重复启动；请查看原任务，若要新任务请发起一次新的操作。"), CancellationToken.None);
            }
        }
        finally
        {
            http.Response.Body = original;
            if (http.Items[TaskAdmissionRequestState.ItemKey] is TaskAdmissionRequestState state)
                foreach (var lease in state.Leases.AsEnumerable().Reverse()) await lease.DisposeAsync();
        }
    }

    private static async Task<string?> RebindMcpReplayIdAsync(HttpRequest request, string cachedBody)
    {
        request.EnableBuffering();
        request.Body.Position = 0;
        try
        {
            using var incoming = await JsonDocument.ParseAsync(request.Body, cancellationToken: CancellationToken.None);
            using var cached = JsonDocument.Parse(cachedBody);
            var current = incoming.RootElement;
            var response = cached.RootElement;
            if (current.ValueKind != JsonValueKind.Object || response.ValueKind != JsonValueKind.Object
                || current.EnumerateObject().Select(x => x.Name).Distinct(StringComparer.Ordinal).Count() != current.EnumerateObject().Count()
                || response.EnumerateObject().Select(x => x.Name).Distinct(StringComparer.Ordinal).Count() != response.EnumerateObject().Count()
                || !current.TryGetProperty("jsonrpc", out var version) || version.ValueKind != JsonValueKind.String || version.GetString() != "2.0"
                || !current.TryGetProperty("method", out var method) || method.ValueKind != JsonValueKind.String || method.GetString() != "tools/call"
                || !current.TryGetProperty("id", out var id) || !ValidRpcId(id)
                || !response.TryGetProperty("jsonrpc", out var cachedVersion) || cachedVersion.ValueKind != JsonValueKind.String || cachedVersion.GetString() != "2.0"
                || !response.TryGetProperty("id", out var cachedId) || !ValidRpcId(cachedId)
                || response.TryGetProperty("result", out _) == response.TryGetProperty("error", out _)) return null;
            if (response.TryGetProperty("error", out var error)
                && (error.ValueKind != JsonValueKind.Object || !error.TryGetProperty("code", out var code) || code.ValueKind != JsonValueKind.Number || !code.TryGetInt32(out _)
                    || !error.TryGetProperty("message", out var message) || message.ValueKind != JsonValueKind.String)) return null;
            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer))
            {
                writer.WriteStartObject();
                foreach (var property in response.EnumerateObject())
                {
                    writer.WritePropertyName(property.Name);
                    if (property.Name == "id") id.WriteTo(writer);
                    else property.Value.WriteTo(writer);
                }
                writer.WriteEndObject();
            }
            return Encoding.UTF8.GetString(buffer.ToArray());
        }
        catch (JsonException) { return null; }
        finally { request.Body.Position = 0; }
    }

    private static bool ValidRpcId(JsonElement id)
        => id.ValueKind == JsonValueKind.String || id.ValueKind == JsonValueKind.Number && id.TryGetInt64(out _);

    /// <summary>流式响应立即透传，JSON最多旁录128KiB；不缓存完整SSE或改变用户等待过程。</summary>
    private sealed class BoundedResponseCapture(Stream destination, Func<string?> contentType) : Stream
    {
        private readonly MemoryStream _capture = new();
        private bool _overflow;
        public string? CapturedBody => !_overflow && _capture.Length > 0
            ? Encoding.UTF8.GetString(_capture.ToArray()) : null;
        private void Capture(ReadOnlySpan<byte> bytes)
        {
            if (_overflow || contentType()?.Contains("json", StringComparison.OrdinalIgnoreCase) != true) return;
            if (_capture.Length + bytes.Length > 131072) { _overflow = true; _capture.SetLength(0); return; }
            _capture.Write(bytes);
        }
        public override void Write(byte[] buffer, int offset, int count)
        { destination.Write(buffer, offset, count); Capture(buffer.AsSpan(offset, count)); }
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        { await destination.WriteAsync(buffer, cancellationToken); Capture(buffer.Span); }
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
        public override void Flush() => destination.Flush();
        public override Task FlushAsync(CancellationToken cancellationToken) => destination.FlushAsync(cancellationToken);
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) _capture.Dispose(); base.Dispose(disposing); }
    }
}
