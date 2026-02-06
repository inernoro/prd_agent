namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 邮件通道服务接口
/// </summary>
public interface IEmailChannelService
{
    /// <summary>
    /// 测试 IMAP 连接
    /// </summary>
    Task<(bool Success, string Message)> TestImapConnectionAsync(
        string host,
        int port,
        string username,
        string password,
        bool useSsl,
        CancellationToken ct = default);

    /// <summary>
    /// 轮询邮件并创建任务
    /// </summary>
    /// <returns>处理的邮件数量</returns>
    Task<int> PollEmailsAsync(CancellationToken ct = default);

    /// <summary>
    /// 发送邮件回复
    /// </summary>
    Task<bool> SendReplyAsync(
        string toAddress,
        string toName,
        string subject,
        string body,
        string? inReplyTo = null,
        CancellationToken ct = default);
}
