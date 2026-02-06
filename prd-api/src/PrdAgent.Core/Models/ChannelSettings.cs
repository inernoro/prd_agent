namespace PrdAgent.Core.Models;

/// <summary>
/// 通道邮箱配置
/// 用于配置 IMAP/SMTP 服务器以接收和发送邮件
/// </summary>
public class ChannelSettings
{
    /// <summary>主键（固定为 "default"，单例模式）</summary>
    public string Id { get; set; } = "default";

    #region IMAP 收信配置

    /// <summary>IMAP 服务器地址（如 imap.company.com）</summary>
    public string? ImapHost { get; set; }

    /// <summary>IMAP 端口（默认 993）</summary>
    public int ImapPort { get; set; } = 993;

    /// <summary>IMAP 用户名（通常是完整邮箱地址）</summary>
    public string? ImapUsername { get; set; }

    /// <summary>IMAP 密码（加密存储）</summary>
    public string? ImapPassword { get; set; }

    /// <summary>是否使用 SSL/TLS</summary>
    public bool ImapUseSsl { get; set; } = true;

    /// <summary>监控的邮箱文件夹（默认 INBOX）</summary>
    public string ImapFolder { get; set; } = "INBOX";

    #endregion

    #region SMTP 发信配置

    /// <summary>SMTP 服务器地址（如 smtp.company.com）</summary>
    public string? SmtpHost { get; set; }

    /// <summary>SMTP 端口（默认 587）</summary>
    public int SmtpPort { get; set; } = 587;

    /// <summary>SMTP 用户名</summary>
    public string? SmtpUsername { get; set; }

    /// <summary>SMTP 密码（加密存储）</summary>
    public string? SmtpPassword { get; set; }

    /// <summary>是否使用 SSL/TLS</summary>
    public bool SmtpUseSsl { get; set; } = true;

    /// <summary>发件人显示名称</summary>
    public string? SmtpFromName { get; set; }

    /// <summary>发件人邮箱地址（如果与用户名不同）</summary>
    public string? SmtpFromAddress { get; set; }

    #endregion

    #region 轮询配置

    /// <summary>轮询间隔（分钟）</summary>
    public int PollIntervalMinutes { get; set; } = 5;

    /// <summary>是否启用邮件通道</summary>
    public bool IsEnabled { get; set; } = false;

    /// <summary>上次轮询时间</summary>
    public DateTime? LastPollAt { get; set; }

    /// <summary>上次轮询结果：success / failed</summary>
    public string? LastPollResult { get; set; }

    /// <summary>上次轮询错误信息</summary>
    public string? LastPollError { get; set; }

    /// <summary>上次轮询获取的邮件数量</summary>
    public int LastPollEmailCount { get; set; }

    #endregion

    #region 高级配置

    /// <summary>
    /// 接收的目标邮箱域名列表
    /// 例如：["ai.company.com"] 表示只处理发送到 *@ai.company.com 的邮件
    /// 留空表示处理所有发到配置邮箱的邮件
    /// </summary>
    public List<string> AcceptedDomains { get; set; } = new();

    /// <summary>
    /// 是否自动回复确认收到
    /// </summary>
    public bool AutoAcknowledge { get; set; } = true;

    /// <summary>
    /// 处理完成后是否标记邮件为已读
    /// </summary>
    public bool MarkAsReadAfterProcess { get; set; } = true;

    /// <summary>
    /// 是否将处理过的邮件移到指定文件夹
    /// </summary>
    public string? ProcessedFolder { get; set; }

    #endregion

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
