using System.Collections.Concurrent;
using System.Threading.Channels;
using PrdAgent.Core.Interfaces;
using PrdAgent.Core.Models;

namespace PrdAgent.Infrastructure.Services;

/// <summary>
/// 群消息实时广播 Hub（进程内）。
/// 说明：这不是事件溯源；断线续传由 SSE 端点回放 Mongo 来完成。
/// </summary>
public class GroupMessageStreamHub : IGroupMessageStreamHub
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, Channel<GroupMessageBroadcast>>> _subs = new();

    public GroupMessageStreamSubscription Subscribe(string groupId)
    {
        var gid = (groupId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid))
            throw new ArgumentException("groupId 不能为空", nameof(groupId));

        var ch = Channel.CreateUnbounded<GroupMessageBroadcast>(new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false
        });

        var id = Guid.NewGuid();
        var groupMap = _subs.GetOrAdd(gid, _ => new ConcurrentDictionary<Guid, Channel<GroupMessageBroadcast>>());
        groupMap[id] = ch;

        return new GroupMessageStreamSubscription(
            ch.Reader,
            dispose: () =>
            {
                if (_subs.TryGetValue(gid, out var map))
                {
                    if (map.TryRemove(id, out var removed))
                    {
                        try { removed.Writer.TryComplete(); } catch { /* ignore */ }
                    }
                    if (map.IsEmpty)
                    {
                        _subs.TryRemove(gid, out _);
                    }
                }
            });
    }

    public void Publish(Message message)
    {
        if (message == null) return;
        var gid = (message.GroupId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid)) return;
        if (!message.GroupSeq.HasValue || message.GroupSeq.Value <= 0) return;

        if (!_subs.TryGetValue(gid, out var map) || map.IsEmpty) return;

        var payload = new GroupMessageBroadcast
        {
            GroupId = gid,
            Seq = message.GroupSeq.Value,
            Type = "message",
            Message = message
        };

        foreach (var kv in map)
        {
            var ch = kv.Value;
            ch.Writer.TryWrite(payload);
        }
    }

    public void PublishUpdated(Message message)
    {
        if (message == null) return;
        var gid = (message.GroupId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid)) return;
        if (!message.GroupSeq.HasValue || message.GroupSeq.Value <= 0) return;

        if (!_subs.TryGetValue(gid, out var map) || map.IsEmpty) return;

        var payload = new GroupMessageBroadcast
        {
            GroupId = gid,
            Seq = message.GroupSeq.Value,
            Type = "messageUpdated",
            Message = message
        };

        foreach (var kv in map)
        {
            var ch = kv.Value;
            ch.Writer.TryWrite(payload);
        }
    }
}


