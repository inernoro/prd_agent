using System.Threading.Channels;
using PrdAgent.Core.Interfaces;

namespace PrdAgent.Infrastructure.Services.InfraAgentSessions;

/// <summary>
/// Process-local queue for CDS Agent runtime work.
/// This removes long agent runs from HTTP request lifetimes; production can replace it
/// with Redis/IRunQueue without changing MAP/CDS control-plane APIs.
/// </summary>
public sealed class InMemoryInfraAgentRuntimeJobQueue : IInfraAgentRuntimeJobQueue
{
    private readonly Channel<InfraAgentRuntimeJob> _channel = Channel.CreateUnbounded<InfraAgentRuntimeJob>(
        new UnboundedChannelOptions
        {
            SingleReader = false,
            SingleWriter = false
        });

    public ValueTask EnqueueAsync(InfraAgentRuntimeJob job, CancellationToken ct) =>
        _channel.Writer.WriteAsync(job, ct);

    public IAsyncEnumerable<InfraAgentRuntimeJob> DequeueAsync(CancellationToken ct) =>
        _channel.Reader.ReadAllAsync(ct);
}
