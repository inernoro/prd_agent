using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Net.WebSockets;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

public sealed record SafeWebSocketTarget(Uri Uri, IReadOnlyList<IPAddress> Addresses);

public interface ISafeOutboundWebSocketConnector
{
    Task<SafeWebSocketTarget> PrepareAsync(string? url, CancellationToken ct = default);
    Task<IDisposable> ConnectAsync(ClientWebSocket socket, string? url, CancellationToken ct = default);
}

public sealed class SafeOutboundWebSocketConnector : ISafeOutboundWebSocketConnector
{
    private readonly ISafeOutboundUrlValidator _validator;

    public SafeOutboundWebSocketConnector(ISafeOutboundUrlValidator validator)
    {
        _validator = validator;
    }

    public async Task<SafeWebSocketTarget> PrepareAsync(string? url, CancellationToken ct = default)
    {
        var trimmed = (url ?? string.Empty).Trim();
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
            throw new InvalidOperationException("外部 WebSocket URL 格式无效");
        if (uri.Scheme != "wss")
            throw new InvalidOperationException("外部 WebSocket 只允许 wss 加密连接");
        if (!string.IsNullOrWhiteSpace(uri.UserInfo))
            throw new InvalidOperationException("外部 WebSocket URL 不允许携带 userinfo");
        if (string.IsNullOrWhiteSpace(uri.Host))
            throw new InvalidOperationException("外部 WebSocket URL host 不能为空");

        var host = uri.IdnHost.Trim().TrimEnd('.');
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("外部 WebSocket 不允许连接 localhost");
        var addresses = IPAddress.TryParse(host, out var literal)
            ? new[] { literal }
            : await Dns.GetHostAddressesAsync(host, ct);
        if (addresses.Length == 0)
            throw new InvalidOperationException("外部 WebSocket host 无法解析");
        if (addresses.Any(address => !_validator.IsSafeAddress(address)))
            throw new InvalidOperationException("外部 WebSocket 不允许连接内网或保留地址");

        return new SafeWebSocketTarget(uri, addresses);
    }

    public async Task<IDisposable> ConnectAsync(ClientWebSocket socket, string? url, CancellationToken ct = default)
    {
        var target = await PrepareAsync(url, ct);
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseProxy = false,
            ConnectCallback = (context, connectCt) => ConnectPinnedAsync(context, target, connectCt),
            SslOptions = new SslClientAuthenticationOptions
            {
                TargetHost = target.Uri.IdnHost,
                RemoteCertificateValidationCallback = (_, _, _, errors) => errors == SslPolicyErrors.None,
            },
        };
        var invoker = new HttpMessageInvoker(handler, disposeHandler: true);
        try
        {
            await socket.ConnectAsync(target.Uri, invoker, ct);
            return invoker;
        }
        catch
        {
            invoker.Dispose();
            throw;
        }
    }

    private static async ValueTask<Stream> ConnectPinnedAsync(
        SocketsHttpConnectionContext context,
        SafeWebSocketTarget target,
        CancellationToken ct)
    {
        if (!string.Equals(context.DnsEndPoint.Host.TrimEnd('.'), target.Uri.IdnHost.TrimEnd('.'), StringComparison.OrdinalIgnoreCase)
            || context.DnsEndPoint.Port != target.Uri.Port)
        {
            throw new InvalidOperationException("WebSocket 握手目标与已验证目标不一致");
        }

        Exception? lastError = null;
        foreach (var address in target.Addresses)
        {
            var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(new IPEndPoint(address, target.Uri.Port), ct);
                return new NetworkStream(socket, ownsSocket: true);
            }
            catch (Exception ex)
            {
                lastError = ex;
                socket.Dispose();
            }
        }
        throw lastError ?? new SocketException((int)SocketError.HostUnreachable);
    }
}
