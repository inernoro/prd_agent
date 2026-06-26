using System.Collections.Concurrent;
using System.Threading.Channels;

namespace PrdAgent.Infrastructure.Services.Changelog;

/// <summary>
/// 一条「更新中心数据已刷新」推送事件。
/// </summary>
/// <param name="ViewType">视图类型：current-week / releases / github-logs / github-pending-review</param>
/// <param name="FetchedAt">该视图最新拉取时间（UTC）</param>
/// <param name="Source">数据来源：local / github / none</param>
public sealed record ChangelogPushEvent(string ViewType, DateTime FetchedAt, string Source);

/// <summary>
/// 更新中心 SSE 推送中枢（进程内、单例）。
///
/// 后台刷新 Worker 发现内容有变化时 <see cref="Publish"/> 一条事件；
/// 每个打开着更新中心的浏览器通过 <see cref="Subscribe"/> 拿到一个独立 Channel，
/// SSE 端点把事件逐条写给前端，前端据此重新读取存量并平滑替换。
///
/// 已知边界：进程内广播，多实例部署时跨实例不互通（见 doc/debt.platform.changelog-center.md）。
/// </summary>
public interface IChangelogPushHub
{
    /// <summary>订阅推送，返回订阅 id 与只读 Channel。用完务必 <see cref="Unsubscribe"/>。</summary>
    (Guid id, ChannelReader<ChangelogPushEvent> reader) Subscribe();

    /// <summary>取消订阅（SSE 连接断开时调用）。</summary>
    void Unsubscribe(Guid id);

    /// <summary>向所有订阅者广播一条事件。</summary>
    void Publish(ChangelogPushEvent evt);
}

public sealed class ChangelogPushHub : IChangelogPushHub
{
    private readonly ConcurrentDictionary<Guid, Channel<ChangelogPushEvent>> _subscribers = new();

    public (Guid id, ChannelReader<ChangelogPushEvent> reader) Subscribe()
    {
        var id = Guid.NewGuid();
        // 有界 + DropOldest：慢消费者不会无限堆积内存；漏掉旧事件无所谓（前端重读存量）。
        var channel = Channel.CreateBounded<ChangelogPushEvent>(new BoundedChannelOptions(16)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });
        _subscribers[id] = channel;
        return (id, channel.Reader);
    }

    public void Unsubscribe(Guid id)
    {
        if (_subscribers.TryRemove(id, out var channel))
        {
            channel.Writer.TryComplete();
        }
    }

    public void Publish(ChangelogPushEvent evt)
    {
        foreach (var channel in _subscribers.Values)
        {
            channel.Writer.TryWrite(evt);
        }
    }
}
