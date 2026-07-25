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
        var b2 = bytes[2];
        var b3 = bytes[3];

        // IANA 在 192.0.0.0/24 中给 PCP/TURN anycast 留了两个全局可达例外。
        if (b0 == 192 && b1 == 0 && b2 == 0 && b3 is 9 or 10)
            return false;

        return b0 == 0 ||                         // "this" network
               b0 == 10 ||                        // RFC1918
               b0 == 127 ||                       // loopback
               (b0 == 100 && b1 is >= 64 and <= 127) || // carrier-grade NAT
               (b0 == 169 && b1 == 254) ||        // link-local / cloud metadata
               (b0 == 172 && b1 is >= 16 and <= 31) ||  // RFC1918
               (b0 == 192 && b1 == 0 && b2 == 0) ||     // IETF protocol assignments
               (b0 == 192 && b1 == 0 && b2 == 2) ||     // TEST-NET-1
               (b0 == 192 && b1 == 88 && b2 == 99) ||   // deprecated 6to4 relay anycast
               (b0 == 192 && b1 == 168) ||        // RFC1918
               (b0 == 198 && b1 is 18 or 19) ||          // benchmarking
               (b0 == 198 && b1 == 51 && b2 == 100) ||  // TEST-NET-2
               (b0 == 203 && b1 == 0 && b2 == 113) ||   // TEST-NET-3
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
               HasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 96) || // IPv4/IPv6 translation
               HasPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48) ||
               HasPrefix(bytes, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], 64) || // discard-only
               HasPrefix(bytes, [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01], 64) || // dummy prefix
               (HasPrefix(bytes, [0x20, 0x01, 0x00], 23) && !IsGloballyReachableIetfProtocolAssignment(bytes)) ||
               HasPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32) || // documentation
               HasPrefix(bytes, [0x20, 0x02], 16) ||      // 6to4
               HasPrefix(bytes, [0x3f, 0xff, 0x00], 20) || // documentation
               HasPrefix(bytes, [0x5f, 0x00], 16) ||      // SRv6 SIDs
               bytes[0] == 0xff ||                // multicast
               (bytes[0] & 0xfe) == 0xfc;         // unique local fc00::/7
    }

    private static bool IsGloballyReachableIetfProtocolAssignment(byte[] address)
    {
        var isProtocolAnycast = HasPrefix(address, [0x20, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00], 64)
                                && address[8] == 0 && address[9] == 0 && address[10] == 0
                                && address[11] == 0 && address[12] == 0 && address[13] == 0 && address[14] == 0
                                && address[15] is >= 1 and <= 3;
        return isProtocolAnycast
               || HasPrefix(address, [0x20, 0x01, 0x00, 0x03], 32)
               || HasPrefix(address, [0x20, 0x01, 0x00, 0x04, 0x01, 0x12], 48)
               || HasPrefix(address, [0x20, 0x01, 0x00, 0x20], 28)
               || HasPrefix(address, [0x20, 0x01, 0x00, 0x30], 28);
    }

    private static bool HasPrefix(byte[] address, byte[] prefix, int prefixLength)
    {
        var wholeBytes = prefixLength / 8;
        var remainingBits = prefixLength % 8;
        if (address.Length * 8 < prefixLength || prefix.Length < wholeBytes + (remainingBits > 0 ? 1 : 0))
            return false;

        for (var i = 0; i < wholeBytes; i++)
        {
            if (address[i] != prefix[i])
                return false;
        }

        if (remainingBits == 0)
            return true;

        var mask = (byte)(0xff << (8 - remainingBits));
        return (address[wholeBytes] & mask) == (prefix[wholeBytes] & mask);
    }
}
