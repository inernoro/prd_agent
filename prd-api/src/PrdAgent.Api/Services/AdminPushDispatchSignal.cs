using System.Threading.Channels;

namespace PrdAgent.Api.Services;

public sealed class AdminPushDispatchSignal
{
    private readonly Channel<byte> _channel = Channel.CreateBounded<byte>(new BoundedChannelOptions(1)
    {
        FullMode = BoundedChannelFullMode.DropWrite,
        SingleReader = true,
        SingleWriter = false,
    });

    public void NotifyPending()
    {
        _channel.Writer.TryWrite(0);
    }

    public async Task WaitAsync(TimeSpan fallbackDelay, CancellationToken ct)
    {
        var signalTask = _channel.Reader.WaitToReadAsync(ct).AsTask();
        var delayTask = Task.Delay(fallbackDelay, ct);
        var completed = await Task.WhenAny(signalTask, delayTask);

        if (completed == signalTask && await signalTask)
        {
            while (_channel.Reader.TryRead(out _))
            {
            }
        }
    }
}
