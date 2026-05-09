using System.Net;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services;

public sealed class SafeOutboundUrlValidator : ISafeOutboundUrlValidator
{
    public async Task<Uri> EnsureSafeHttpUrlAsync(string? url, string purpose, CancellationToken ct = default)
    {
        var trimmed = (url ?? string.Empty).Trim();
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
            throw new InvalidOperationException($"{purpose} URL 格式无效");

        if (uri.Scheme is not ("http" or "https"))
            throw new InvalidOperationException($"{purpose} 仅允许 http/https URL");

        if (!string.IsNullOrWhiteSpace(uri.UserInfo))
            throw new InvalidOperationException($"{purpose} URL 不允许携带 userinfo");

        if (string.IsNullOrWhiteSpace(uri.Host))
            throw new InvalidOperationException($"{purpose} URL host 不能为空");

        var host = uri.Host.Trim().TrimEnd('.');
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException($"{purpose} URL 不允许指向 localhost");

        var addresses = await ResolveAddressesAsync(host, ct);
        if (addresses.Length == 0)
            throw new InvalidOperationException($"{purpose} URL host 无法解析");

        foreach (var address in addresses)
        {
            if (IsBlockedAddress(address))
                throw new InvalidOperationException($"{purpose} URL 不允许指向内网或保留地址");
        }

        return uri;
    }

    public bool IsSafeAddress(IPAddress address) => !IsBlockedAddress(address);

    private static async Task<IPAddress[]> ResolveAddressesAsync(string host, CancellationToken ct)
    {
        if (IPAddress.TryParse(host, out var literal))
            return new[] { literal };

        return await Dns.GetHostAddressesAsync(host, ct);
    }

    private static bool IsBlockedAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
            address = address.MapToIPv4();

        if (IPAddress.IsLoopback(address))
            return true;

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
            return IsBlockedIPv4(address.GetAddressBytes());

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
            return IsBlockedIPv6(address);

        return true;
    }

    private static bool IsBlockedIPv4(byte[] bytes)
    {
        if (bytes.Length != 4)
            return true;

        var b0 = bytes[0];
        var b1 = bytes[1];

        return b0 == 0 ||                         // "this" network
               b0 == 10 ||                        // RFC1918
               b0 == 127 ||                       // loopback
               (b0 == 100 && b1 is >= 64 and <= 127) || // carrier-grade NAT
               (b0 == 169 && b1 == 254) ||        // link-local / cloud metadata
               (b0 == 172 && b1 is >= 16 and <= 31) ||  // RFC1918
               (b0 == 192 && b1 == 168) ||        // RFC1918
               b0 >= 224;                         // multicast / reserved
    }

    private static bool IsBlockedIPv6(IPAddress address)
    {
        var bytes = address.GetAddressBytes();
        return address.Equals(IPAddress.IPv6Any) ||
               address.Equals(IPAddress.IPv6Loopback) ||
               address.Equals(IPAddress.IPv6None) ||
               address.IsIPv6LinkLocal ||
               address.IsIPv6SiteLocal ||
               bytes[0] == 0xff ||                // multicast
               (bytes[0] & 0xfe) == 0xfc;         // unique local fc00::/7
    }
}
