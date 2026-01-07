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

    public void PublishDelta(string groupId, string messageId, string deltaContent, string? blockId = null, bool isFirstChunk = false)
    {
        var gid = (groupId ?? string.Empty).Trim();
        var mid = (messageId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid) || string.IsNullOrEmpty(mid)) return;
        if (string.IsNullOrEmpty(deltaContent)) return;

        if (!_subs.TryGetValue(gid, out var map) || map.IsEmpty) return;

        // Delta 事件不需要 seq（因为不用于断线续传，只用于实时推送）
        var payload = new GroupMessageBroadcast
        {
            GroupId = gid,
            Seq = 0,  // Delta 不参与 seq 排序
            Type = "delta",
            MessageId = mid,
            DeltaContent = deltaContent,
            BlockId = blockId,
            IsFirstChunk = isFirstChunk
        };

        foreach (var kv in map)
        {
            var ch = kv.Value;
            ch.Writer.TryWrite(payload);
        }
    }

    public void PublishBlockEnd(string groupId, string messageId, string blockId)
    {
        var gid = (groupId ?? string.Empty).Trim();
        var mid = (messageId ?? string.Empty).Trim();
        var bid = (blockId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid) || string.IsNullOrEmpty(mid) || string.IsNullOrEmpty(bid)) return;

        if (!_subs.TryGetValue(gid, out var map) || map.IsEmpty) return;

        // BlockEnd 事件不需要 seq
        var payload = new GroupMessageBroadcast
        {
            GroupId = gid,
            Seq = 0,
            Type = "blockEnd",
            MessageId = mid,
            BlockId = bid
        };

        foreach (var kv in map)
        {
            var ch = kv.Value;
            ch.Writer.TryWrite(payload);
        }
    }

    public void PublishCitations(string groupId, string messageId, IReadOnlyList<DocCitation> citations)
    {
        var gid = (groupId ?? string.Empty).Trim();
        var mid = (messageId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(gid) || string.IsNullOrEmpty(mid)) return;
        if (citations == null || citations.Count == 0) return;

        if (!_subs.TryGetValue(gid, out var map) || map.IsEmpty) return;

        // Citations 事件不需要 seq
        var payload = new GroupMessageBroadcast
        {
            GroupId = gid,
            Seq = 0,
            Type = "citations",
            MessageId = mid,
            Citations = citations
        };

        foreach (var kv in map)
        {
            var ch = kv.Value;
            ch.Writer.TryWrite(payload);
        }
    }
}


