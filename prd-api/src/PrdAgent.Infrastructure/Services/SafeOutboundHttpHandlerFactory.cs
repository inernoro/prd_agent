using System.Net;
using System.Net.Sockets;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

public interface ISafeOutboundHttpHandlerFactory
{
    HttpMessageHandler CreateHandler();
}

public sealed class SafeOutboundHttpHandlerFactory : ISafeOutboundHttpHandlerFactory
{
    private readonly ISafeOutboundUrlValidator _validator;

    public SafeOutboundHttpHandlerFactory(ISafeOutboundUrlValidator validator)
    {
        _validator = validator;
    }

    public HttpMessageHandler CreateHandler()
    {
        return new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            ConnectCallback = ConnectSafelyAsync,
        };
    }

    private async ValueTask<Stream> ConnectSafelyAsync(SocketsHttpConnectionContext context, CancellationToken ct)
    {
        var addresses = await ResolveAddressesAsync(context.DnsEndPoint.Host, ct);
        if (addresses.Length == 0)
            throw new InvalidOperationException("出站请求 host 无法解析");

        foreach (var address in addresses)
        {
            if (!_validator.IsSafeAddress(address))
                throw new InvalidOperationException("出站请求不允许连接内网或保留地址");
        }

        var lastError = default(Exception);
        foreach (var address in addresses)
        {
            var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp) { NoDelay = true };
            try
            {
                await socket.ConnectAsync(new IPEndPoint(address, context.DnsEndPoint.Port), ct);
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

    private static async Task<IPAddress[]> ResolveAddressesAsync(string host, CancellationToken ct)
    {
        if (IPAddress.TryParse(host, out var literal))
            return new[] { literal };

        return await Dns.GetHostAddressesAsync(host, ct);
    }
}
