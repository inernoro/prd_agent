using System.Net;
using PrdAgent.GatewayTransport;
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
            if (!SafeOutboundAddressPolicy.IsPublicAddress(address))
                throw new InvalidOperationException($"{purpose} URL 不允许指向内网或保留地址");
        }

        return uri;
    }

    public bool IsSafeAddress(IPAddress address) => SafeOutboundAddressPolicy.IsPublicAddress(address);

    private static async Task<IPAddress[]> ResolveAddressesAsync(string host, CancellationToken ct)
    {
        if (IPAddress.TryParse(host, out var literal))
            return new[] { literal };

        return await Dns.GetHostAddressesAsync(host, ct);
    }

}
