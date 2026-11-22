using System.Net;
using System.Net.Sockets;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

// Only this assembly can create an approved snapshot. Do not expose mutable IPAddress objects.
public sealed class SafeDiagnosticTarget
{
    private readonly string[] _addresses;
    public Uri Uri { get; }
    public IReadOnlyList<IPAddress> Addresses => Array.AsReadOnly(_addresses.Select(IPAddress.Parse).ToArray());
    internal SafeDiagnosticTarget(Uri uri, IEnumerable<IPAddress> addresses)
    {
        Uri = uri;
        _addresses = addresses.Select(a => a.ToString()).Distinct().ToArray();
    }
}

public sealed class SafeOutboundDiagnosticConnector
{
    private readonly ISafeOutboundUrlValidator _validator;
    private readonly Func<string, CancellationToken, Task<IPAddress[]>> _resolve;
    private readonly Func<IPEndPoint, CancellationToken, ValueTask<Stream>> _connect;
    public SafeOutboundDiagnosticConnector(ISafeOutboundUrlValidator validator)
        : this(validator, (host, ct) => Dns.GetHostAddressesAsync(host, ct), ConnectSocketAsync) { }

    // Test seams for deterministic DNS and local fixtures; production DI uses the constructor above.
    public SafeOutboundDiagnosticConnector(ISafeOutboundUrlValidator validator,
        Func<string, CancellationToken, Task<IPAddress[]>> resolve,
        Func<IPEndPoint, CancellationToken, ValueTask<Stream>> connect)
    {
        _validator = validator;
        _resolve = resolve;
        _connect = connect;
    }

    public async Task<SafeDiagnosticTarget> PrepareAsync(Uri uri, CancellationToken ct)
    {
        if (!uri.IsAbsoluteUri || uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo))
            throw new InvalidOperationException("诊断地址无效，请填写完整的 http/https 地址");
        var host = uri.IdnHost.TrimEnd('.');
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("诊断不能连接本机地址，请使用可公开访问的地址");
        ct.ThrowIfCancellationRequested();
        var addresses = IPAddress.TryParse(host, out var literal) ? new[] { literal } : await _resolve(host, ct);
        ct.ThrowIfCancellationRequested();
        var target = new SafeDiagnosticTarget(uri, addresses);
        if (target.Addresses.Count == 0 || target.Addresses.Any(a => !_validator.IsSafeAddress(a)))
            throw new InvalidOperationException("诊断地址无法解析或不允许访问，请使用可公开访问的地址");
        return target;
    }

    public async ValueTask<Stream> ConnectAsync(SafeDiagnosticTarget target, CancellationToken ct)
    {
        Exception? lastError = null;
        foreach (var address in target.Addresses)
        {
            ct.ThrowIfCancellationRequested();
            try { return await _connect(new IPEndPoint(address, target.Uri.Port), ct); }
            catch (SocketException ex) { lastError = ex; }
        }
        throw lastError ?? new SocketException((int)SocketError.HostUnreachable);
    }

    public HttpMessageHandler CreateHandler(SafeDiagnosticTarget target) => new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        UseProxy = false,
        UseCookies = false,
        ConnectCallback = (context, ct) =>
        {
            if (!string.Equals(context.DnsEndPoint.Host.TrimEnd('.'), target.Uri.IdnHost.TrimEnd('.'), StringComparison.OrdinalIgnoreCase)
                || context.DnsEndPoint.Port != target.Uri.Port)
                throw new InvalidOperationException("诊断目标发生变化，请检查地址后重试");
            return ConnectAsync(target, ct);
        }
    };

    private static async ValueTask<Stream> ConnectSocketAsync(IPEndPoint endpoint, CancellationToken ct)
    {
        var socket = new Socket(endpoint.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
        try
        {
            await socket.ConnectAsync(endpoint, ct);
            return new NetworkStream(socket, ownsSocket: true);
        }
        catch { socket.Dispose(); throw; }
    }
}
