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
    /// 发布一条"消息更新"事件（例如软删除），用于通知在线客户端立即移除/更新该消息。
    /// 注意：该事件不依赖 groupSeq 递增；离线重连需通过历史快照校准来纠正本地残留。
    /// </summary>
    void PublishUpdated(Message message);

    /// <summary>
    /// 发布 AI 流式输出的增量内容（delta）。
    /// 用于实时推送 AI 回复的打字机效果，无需等待完整消息生成。
    /// </summary>
    void PublishDelta(string groupId, string messageId, string deltaContent, string? blockId = null, bool isFirstChunk = false);

    /// <summary>
    /// 发布 Block 结束事件（blockEnd）。
    /// 用于通知前端某个 Markdown block 已完整输出，可以进行完整渲染。
    /// </summary>
    void PublishBlockEnd(string groupId, string messageId, string blockId);

    /// <summary>
    /// 发布 AI 思考过程的增量内容（thinking）。
    /// 用于实时推送 DeepSeek 等模型的 reasoning_content，在正文输出前展示给用户。
    /// </summary>
    void PublishThinking(string groupId, string messageId, string thinkingContent);

    /// <summary>
    /// 发布引用/注脚（citations）事件。
    /// 用于通知前端该消息关联的 PRD 文档引用信息。
    /// </summary>
    void PublishCitations(string groupId, string messageId, System.Collections.Generic.IReadOnlyList<DocCitation> citations);
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


