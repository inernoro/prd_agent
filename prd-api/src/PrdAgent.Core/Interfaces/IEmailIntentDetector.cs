using PrdAgent.Core.Models;

namespace PrdAgent.Core.Interfaces;

/// <summary>
/// 邮件意图检测服务接口
/// </summary>
public interface IEmailIntentDetector
{
    /// <summary>
    /// 检测邮件意图
    /// </summary>
    /// <param name="toAddresses">收件地址列表</param>
    /// <param name="subject">邮件主题</param>
    /// <param name="body">邮件正文</param>
    /// <param name="ct">取消令牌</param>
    Task<EmailIntent> DetectAsync(
        IEnumerable<string> toAddresses,
        string subject,
        string body,
        CancellationToken ct = default);
}

/// <summary>
/// 邮件处理器接口
/// </summary>
public interface IEmailHandler
{
    /// <summary>支持的意图类型</summary>
    EmailIntentType IntentType { get; }

    /// <summary>
    /// 处理邮件
    /// </summary>
    /// <param name="taskId">任务ID</param>
    /// <param name="senderAddress">发件人地址</param>
    /// <param name="senderName">发件人名称</param>
    /// <param name="subject">主题</param>
    /// <param name="body">正文</param>
    /// <param name="intent">检测到的意图</param>
    /// <param name="mappedUserId">映射的用户ID（如果有）</param>
    /// <param name="ct">取消令牌</param>
    Task<EmailHandleResult> HandleAsync(
        string taskId,
        string senderAddress,
        string? senderName,
        string subject,
        string body,
        EmailIntent intent,
        string? mappedUserId,
        CancellationToken ct = default);
}
