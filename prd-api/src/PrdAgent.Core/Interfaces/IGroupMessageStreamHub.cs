using System.Threading.Channels;
using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

public interface IGroupMessageStreamHub
{
    /// <summary>
    /// 订阅指定群的实时消息广播。
    /// </summary>
    GroupMessageStreamSubscription Subscribe(string groupId);

    /// <summary>
    /// 发布一条群消息（要求 message.GroupId 非空且 message.GroupSeq 有值）。
    /// </summary>
    void Publish(Message message);

    /// <summary>
    /// 发布一条“消息更新”事件（例如软删除），用于通知在线客户端立即移除/更新该消息。
    /// 注意：该事件不依赖 groupSeq 递增；离线重连需通过历史快照校准来纠正本地残留。
    /// </summary>
    void PublishUpdated(Message message);
}

public sealed class GroupMessageStreamSubscription : IDisposable
{
    private readonly Action _dispose;

    public GroupMessageStreamSubscription(ChannelReader<GroupMessageBroadcast> reader, Action dispose)
    {
        Reader = reader;
        _dispose = dispose;
    }

    public ChannelReader<GroupMessageBroadcast> Reader { get; }

    public void Dispose()
    {
        _dispose();
    }
}


