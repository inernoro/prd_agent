using System;

namespace PrdAgent.Core.Interfaces;

public interface ISafeOutboundUrlValidator
{
    Task<Uri> EnsureSafeHttpUrlAsync(string? url, string purpose, CancellationToken ct = default);
    bool IsSafeAddress(System.Net.IPAddress address);
}
