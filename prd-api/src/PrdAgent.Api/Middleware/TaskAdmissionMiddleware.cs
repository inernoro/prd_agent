using PrdAgent.Api.Services.BackgroundTasks;
using PrdAgent.Core.Security;
using PrdAgent.Core.Models;
using System.Text;

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
            if (permit.AcceptedResponseStatus is { } status && permit.AcceptedResponseBody is { } body)
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
